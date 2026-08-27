/** Guarded funding, assessment, and operational-recovery persistence. */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { batch, type Database } from '../../../db'
import {
  coreAuditEvent,
  sebApplication,
  sebApplicationEvent,
  sebAwardAssessment,
  sebDisbursement,
  sebFundingAward,
  sebFundingAwardVersion,
  sebRecoveryCase,
  sebRecoveryCaseVersion,
  sebRecoveryEntry,
  sebProgrammeDecision,
  sebUtilizationObligation,
} from '../../../db/schema'
import { changedExactlyOne, headJustMovedTo } from '../support'
import type { AdminOperationContext, AssessmentType, RecoveryComponent } from '../types'

export const fundingWorkspace = async (db: Database, applicationId: string) => {
  const [award] = await db.select().from(sebFundingAward)
    .where(eq(sebFundingAward.applicationId, applicationId)).limit(1)
  if (!award) return null
  /*
   * One statement, not 5. Every read here is single-table, so `db.batch` maps
   * the results back correctly — a joined read could not go in here, because a
   * batch is read back by column name and two columns called `id` collide.
   */
  const [versions, ledger, obligations, assessments, recovery] = await batch(db, (tx) => [
    tx.select().from(sebFundingAwardVersion)
      .where(eq(sebFundingAwardVersion.fundingAwardId, award.id))
      .orderBy(asc(sebFundingAwardVersion.version)),
    /*
     * Deliberately uncapped, unlike the display-only histories elsewhere: the
     * released totals are folded from these rows, so a truncated ledger would
     * report a wrong figure rather than a short list. Bounded in practice by
     * the instalments the programme office actually pays, which no caller
     * controls.
     */
    tx.select().from(sebDisbursement)
      .where(eq(sebDisbursement.fundingAwardId, award.id))
      .orderBy(asc(sebDisbursement.sequenceNumber)),
    tx.select().from(sebUtilizationObligation)
      .where(eq(sebUtilizationObligation.fundingAwardId, award.id)),
    tx.select().from(sebAwardAssessment)
      .where(eq(sebAwardAssessment.fundingAwardId, award.id))
      .orderBy(asc(sebAwardAssessment.createdAt)),
    tx.select().from(sebRecoveryCase)
      .where(eq(sebRecoveryCase.fundingAwardId, award.id))
      .orderBy(desc(sebRecoveryCase.createdAt)),
  ])
  return { award, versions, ledger, obligations, assessments, recovery }
}

export const createAwardWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    expectedStatusVersion: number
    decisionId: string
    actorId: string
    sanctionOrder: string
    sanctionDate: string
    conditions: string | null
    now: Date
  },
): Promise<string | null> => {
  const id = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  const nextStatusVersion = input.expectedStatusVersion + 1
  const [updated] = await batch(context.db, (tx) => [
    tx.update(sebApplication).set({
      status: 'SANCTIONED',
      statusVersion: nextStatusVersion,
      statusChangedAt: input.now,
      updatedAt: input.now,
    }).where(and(
      eq(sebApplication.id, input.applicationId),
      eq(sebApplication.status, 'APPROVED'),
      eq(sebApplication.statusVersion, input.expectedStatusVersion),
      isNull(sebApplication.deletedAt),
      sql`EXISTS (
        SELECT 1 FROM ${sebProgrammeDecision}
        WHERE ${sebProgrammeDecision.id} = ${input.decisionId}
          AND ${sebProgrammeDecision.applicationId} = ${input.applicationId}
          AND ${sebProgrammeDecision.outcome} = 'APPROVED'
          AND ${sebProgrammeDecision.approvedAmountPaise} > 0
          AND NOT EXISTS (
            SELECT 1 FROM ${sebProgrammeDecision} AS newer
            WHERE newer.application_id = ${input.applicationId}
              AND newer.decision_number > ${sebProgrammeDecision.decisionNumber}
          )
      )`,
    )).returning({ id: sebApplication.id }),
    tx.insert(sebFundingAward).select(sql`
      SELECT ${id}, application.funding_case_id, application.id,
        ${input.sanctionOrder}, ${input.sanctionDate}, decision.approved_amount_paise,
        ${input.conditions}, 'ACTIVE', NULL, 0, 1, ${input.now},
        ${input.now}, NULL, NULL, NULL
      FROM ${sebApplication} AS application
      INNER JOIN ${sebProgrammeDecision} AS decision ON decision.id = ${input.decisionId}
      WHERE application.id = ${input.applicationId}
        AND application.status = 'SANCTIONED'
        AND ${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}
    `),
    tx.insert(sebFundingAwardVersion).select(sql`
      SELECT ${versionId}, ${id}, 1, ${input.sanctionOrder}, ${input.sanctionDate},
        award.sanctioned_amount_paise, ${input.conditions}, 'ACTIVE', NULL, 'CREATED',
        NULL, NULL, ${input.actorId}, ${input.now}
      FROM ${sebFundingAward} AS award WHERE award.id = ${id}
    `),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'AWARD_SANCTIONED',
        ${input.actorId}, NULL, NULL, NULL, 'APPROVED', 'SANCTIONED', NULL,
        'Funding support was sanctioned.', NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebFundingAward} WHERE ${sebFundingAward.id} = ${id})
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.AWARD_CREATED',
        'SEB_FUNDING_AWARD', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL,
        ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebFundingAwardVersion} WHERE ${sebFundingAwardVersion.id} = ${versionId})
    `),
  ])
  return changedExactlyOne(updated) ? id : null
}

export const changeAwardWrite = async (
  context: AdminOperationContext,
  input: {
    awardId: string
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    actorId: string
    status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'CLOSED'
    closureDisposition: 'RELEASES_COMPLETE' | 'REMAINDER_NOT_RELEASED' | null
    amountPaise: number
    conditions: string | null
    reasonCategoryId: string
    changeType: 'AMENDED' | 'STATUS_CHANGED'
    reason: string
    now: Date
  },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const changedHead = context.db.update(sebFundingAward).set({
    currentVersion: next,
    status: input.status,
    closureDisposition: input.closureDisposition,
    sanctionedAmountPaise: input.amountPaise,
    applicantConditions: input.conditions,
    updatedAt: input.now,
  }).where(and(
    eq(sebFundingAward.id, input.awardId),
    eq(sebFundingAward.applicationId, input.applicationId),
    eq(sebFundingAward.currentVersion, input.expectedVersion),
    isNull(sebFundingAward.deletedAt),
    sql`${input.amountPaise} >= (
      SELECT COALESCE(SUM(CASE WHEN entry_type = 'RELEASE' THEN amount_paise ELSE -amount_paise END), 0)
      FROM ${sebDisbursement} WHERE funding_award_id = ${input.awardId}
    )`,
    sql`${input.amountPaise} <= (
      SELECT decision.approved_amount_paise
      FROM ${sebProgrammeDecision} AS decision
      WHERE decision.application_id = ${sebFundingAward.applicationId}
      ORDER BY decision.created_at DESC
      LIMIT 1
    )`,
    sql`NOT (${sebFundingAward.status} IN ('CANCELLED', 'CLOSED'))`,
    sql`EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.applicationId}
        AND ${sebApplication.statusVersion} = ${input.expectedStatusVersion}
        AND ${sebApplication.deletedAt} IS NULL
    )`,
  )).returning({ id: sebFundingAward.id })
  const [changed] = await batch(context.db, (tx) => [
    changedHead,
    tx.insert(sebFundingAwardVersion).select(sql`
      SELECT ${crypto.randomUUID()}, award.id, ${next}, award.sanction_order_number,
        award.sanction_date, award.sanctioned_amount_paise, award.applicant_conditions,
        award.status, award.closure_disposition, ${input.changeType},
        ${input.reasonCategoryId}, ${input.reason},
        ${input.actorId}, ${input.now}
      FROM ${sebFundingAward} AS award
      WHERE award.id = ${input.awardId} AND award.current_version = ${next}
    `),
    tx.update(sebApplication).set({
      status: 'CANCELLED',
      statusVersion: input.expectedStatusVersion + 1,
      statusChangedAt: input.now,
      updatedAt: input.now,
    }).where(and(
      eq(sebApplication.id, input.applicationId),
      eq(sebApplication.statusVersion, input.expectedStatusVersion),
      sql`${input.status} = 'CANCELLED'`,
      sql`EXISTS (
        SELECT 1 FROM ${sebFundingAward}
        WHERE ${sebFundingAward.id} = ${input.awardId}
          AND ${sebFundingAward.currentVersion} = ${next}
          AND ${sebFundingAward.status} = 'CANCELLED'
      )`,
    )),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'AWARD_CHANGED',
        ${input.actorId}, NULL, NULL, NULL, NULL,
        CASE WHEN ${input.status} = 'CANCELLED' THEN 'CANCELLED' ELSE NULL END,
        NULL, 'The funding award changed.', NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingAwardVersion}
        WHERE ${sebFundingAwardVersion.fundingAwardId} = ${input.awardId}
          AND ${sebFundingAwardVersion.version} = ${next}
      )
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.AWARD_CHANGED',
        'SEB_FUNDING_AWARD', ${input.awardId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, ${JSON.stringify({ status: input.status })}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingAwardVersion}
        WHERE ${sebFundingAwardVersion.fundingAwardId} = ${input.awardId}
          AND ${sebFundingAwardVersion.version} = ${next}
      )
    `),
  ])
  return changedExactlyOne(changed)
}

export const recordReleaseWrite = async (
  context: AdminOperationContext,
  input: {
    awardId: string
    applicationId: string
    expectedLedgerVersion: number
    actorId: string
    amountPaise: number
    occurredAt: Date
    externalReference: string
    approvalReference: string
    approvalDate: string
    bankAccountVerifiedAt: Date
    performanceAgreementReference: string
    performanceAgreementExecutedAt: Date
    physicalVerificationRequired: boolean
    physicalVerificationReference: string | null
    physicalVerificationCompletedAt: Date | null
    applicantMessage: string
    now: Date
  },
): Promise<string | null> => {
  const id = crypto.randomUUID()
  const obligationId = crypto.randomUUID()
  const next = input.expectedLedgerVersion + 1
  const dueAt = new Date(input.occurredAt)
  dueAt.setUTCDate(dueAt.getUTCDate() + 180)
  const [changed] = await batch(context.db, (tx) => [
    tx.update(sebFundingAward).set({ ledgerVersion: next, updatedAt: input.now })
      .where(and(
        eq(sebFundingAward.id, input.awardId),
        eq(sebFundingAward.applicationId, input.applicationId),
        eq(sebFundingAward.status, 'ACTIVE'),
        eq(sebFundingAward.ledgerVersion, input.expectedLedgerVersion),
        isNull(sebFundingAward.deletedAt),
        sql`(
          SELECT COALESCE(SUM(CASE WHEN entry_type = 'RELEASE' THEN amount_paise ELSE -amount_paise END), 0)
          FROM ${sebDisbursement} WHERE funding_award_id = ${input.awardId}
        ) + ${input.amountPaise} <= ${sebFundingAward.sanctionedAmountPaise}`,
      )).returning({ id: sebFundingAward.id }),
    tx.insert(sebDisbursement).select(sql`
      SELECT ${id}, ${input.awardId}, ${next}, 'RELEASE', NULL, ${input.amountPaise},
        ${input.occurredAt}, ${input.externalReference},
        ${input.approvalReference}, ${input.approvalDate},
        ${input.bankAccountVerifiedAt}, ${input.performanceAgreementReference},
        ${input.performanceAgreementExecutedAt}, ${input.physicalVerificationRequired},
        ${input.physicalVerificationReference}, ${input.physicalVerificationCompletedAt ?? null},
        NULL, ${input.applicantMessage}, ${input.actorId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingAward}
        WHERE ${sebFundingAward.id} = ${input.awardId} AND ${sebFundingAward.ledgerVersion} = ${next}
      )
    `),
    tx.insert(sebUtilizationObligation).select(sql`
      SELECT ${obligationId}, ${input.awardId}, ${id}, ${dueAt}, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebDisbursement} WHERE ${sebDisbursement.id} = ${id})
    `),
    tx.update(sebApplication).set({
      status: 'DISBURSED',
      statusVersion: sql`${sebApplication.statusVersion} + 1`,
      statusChangedAt: input.now,
      updatedAt: input.now,
    }).where(and(
      eq(sebApplication.status, 'SANCTIONED'),
      sql`EXISTS (
        SELECT 1 FROM ${sebFundingAward}
        WHERE ${sebFundingAward.id} = ${input.awardId}
          AND ${sebFundingAward.applicationId} = ${sebApplication.id}
      )`,
      sql`EXISTS (SELECT 1 FROM ${sebDisbursement} WHERE ${sebDisbursement.id} = ${id})`,
    )),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RELEASE_RECORDED',
        'SEB_DISBURSEMENT', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL,
        ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebUtilizationObligation} WHERE ${sebUtilizationObligation.id} = ${obligationId})
    `),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'RELEASE_RECORDED',
        ${input.actorId}, NULL, NULL, NULL, NULL, 'DISBURSED', NULL,
        ${input.applicantMessage}, NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebUtilizationObligation} WHERE id = ${obligationId})
    `),
  ])
  return changedExactlyOne(changed) ? id : null
}

export const reverseReleaseWrite = async (
  context: AdminOperationContext,
  input: {
    awardId: string
    applicationId: string
    releaseId: string
    expectedLedgerVersion: number
    actorId: string
    amountPaise: number
    occurredAt: Date
    externalReference: string
    reasonCategoryId: string
    applicantMessage: string
    now: Date
  },
): Promise<string | null> => {
  const id = crypto.randomUUID()
  const next = input.expectedLedgerVersion + 1
  const [changed] = await batch(context.db, (tx) => [
    tx.update(sebFundingAward).set({ ledgerVersion: next, updatedAt: input.now })
      .where(and(
        eq(sebFundingAward.id, input.awardId),
        eq(sebFundingAward.applicationId, input.applicationId),
        eq(sebFundingAward.ledgerVersion, input.expectedLedgerVersion),
        isNull(sebFundingAward.deletedAt),
        /*
         * Grouped, because `release.amount_paise` sits beside `SUM(...)`.
         * SQLite picked a row for the bare column and answered anyway; Postgres
         * refuses the query outright, so this guard — the one stopping a
         * release being reversed for more than it paid — did not merely
         * mis-answer, it threw.
         *
         * On `release.id` rather than the amount: the primary key groups to
         * exactly the one row the `WHERE` selects, and stays right if two
         * releases ever share an amount.
         */
        sql`${input.amountPaise} <= (
          SELECT release.amount_paise - COALESCE(SUM(reversal.amount_paise), 0)
          FROM ${sebDisbursement} AS release
          LEFT JOIN ${sebDisbursement} AS reversal
            ON reversal.related_disbursement_id = release.id
          WHERE release.id = ${input.releaseId}
            AND release.funding_award_id = ${input.awardId}
            AND release.entry_type = 'RELEASE'
          GROUP BY release.id, release.amount_paise
        )`,
      )).returning({ id: sebFundingAward.id }),
    tx.insert(sebDisbursement).select(sql`
      SELECT ${id}, ${input.awardId}, ${next}, 'REVERSAL', ${input.releaseId},
        ${input.amountPaise}, ${input.occurredAt}, ${input.externalReference},
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.reasonCategoryId}, ${input.applicantMessage}, ${input.actorId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingAward}
        WHERE ${sebFundingAward.id} = ${input.awardId} AND ${sebFundingAward.ledgerVersion} = ${next}
      )
    `),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'RELEASE_REVERSED',
        ${input.actorId}, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.applicantMessage}, NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebDisbursement} WHERE id = ${id})
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RELEASE_REVERSED',
        'SEB_DISBURSEMENT', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL,
        ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebDisbursement} WHERE id = ${id})
    `),
  ])
  return changedExactlyOne(changed) ? id : null
}

export const recordAssessmentWrite = async (
  context: AdminOperationContext,
  input: {
    awardId: string
    applicationId: string
    type: AssessmentType
    obligationId: string | null
    outcome: 'PASSED' | 'FAILED'
    evidenceReference: string
    applicantSummary: string
    internalNote: string | null
    assessedAt: Date
    actorId: string
    now: Date
  },
): Promise<string | null> => {
  const id = crypto.randomUUID()
  /*
   * `IS NOT DISTINCT FROM`, because the obligation is nullable and this must
   * match a null to a null. SQLite spelt that `IS ?`; Postgres reserves `IS`
   * for `NULL`, `TRUE` and `FALSE` and refuses a parameter outright — so an
   * assessment against a non-utilization type, which carries no obligation,
   * threw here instead of being numbered.
   */
  const { rows: sequenceRows } = await context.db.execute<{ value: number }>(sql`
    SELECT (COALESCE(MAX(assessment_number), 0) + 1)::int AS value
    FROM ${sebAwardAssessment}
    WHERE funding_award_id = ${input.awardId}
      AND assessment_type = ${input.type}
      AND utilization_obligation_id IS NOT DISTINCT FROM ${input.obligationId}
  `)
  // An aggregate query always returns one row, even when no assessment exists
  // yet; COALESCE makes the value non-null.
  const number = Number(sequenceRows[0]!.value)
  const [result] = await batch(context.db, (tx) => [
    tx.insert(sebAwardAssessment).select(sql`
    SELECT ${id}, ${input.awardId}, ${input.type}, ${number}, ${input.outcome},
      ${input.obligationId}, ${input.evidenceReference}, ${input.applicantSummary},
      ${input.internalNote}, ${input.actorId}, ${input.assessedAt}, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebFundingAward}
      WHERE ${sebFundingAward.id} = ${input.awardId}
        AND ${sebFundingAward.applicationId} = ${input.applicationId}
        AND ${sebFundingAward.deletedAt} IS NULL
    )
    `).returning({ id: sebAwardAssessment.id }),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'ASSESSMENT_RECORDED',
        ${input.actorId}, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.applicantSummary}, NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebAwardAssessment} WHERE id = ${id})
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.ASSESSMENT_RECORDED',
        'SEB_AWARD_ASSESSMENT', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL,
        ${JSON.stringify({ type: input.type, outcome: input.outcome })}, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebAwardAssessment} WHERE id = ${id})
    `),
  ])
  return changedExactlyOne(result) ? id : null
}

export type RecoveryBalance = {
  principalDemanded: number
  interestDemanded: number
  receipts: number
  waivers: number
  outstanding: number
}

export type RecoveryLedgerEntry = {
  id: string
  entryType: string
  component: string
  relatedEntryId: string | null
  amountPaise: number
}

const addRetainedRecoveryEntry = (
  balance: Omit<RecoveryBalance, 'outstanding'>,
  entry: RecoveryLedgerEntry,
  retained: number,
) => {
  if (entry.entryType === 'DEMAND') {
    if (entry.component === 'PRINCIPAL') balance.principalDemanded += retained
    else balance.interestDemanded += retained
  } else if (entry.entryType === 'RECEIPT') balance.receipts += retained
  // REVERSAL entries are removed by the caller. The fixed database enum means
  // WAIVER is the only remaining entry type here.
  else balance.waivers += retained
}

/** Pure accounting fold used by queries, close guards, and unit tests. */
export const calculateRecoveryBalance = (
  entries: RecoveryLedgerEntry[],
): RecoveryBalance => {
  const reversed = new Map<string, number>()
  for (const entry of entries) if (entry.entryType === 'REVERSAL' && entry.relatedEntryId) {
    reversed.set(entry.relatedEntryId, (reversed.get(entry.relatedEntryId) ?? 0) + entry.amountPaise)
  }
  const balance = { principalDemanded: 0, interestDemanded: 0, receipts: 0, waivers: 0 }
  for (const entry of entries) {
    if (entry.entryType === 'REVERSAL') continue
    const retained = entry.amountPaise - (reversed.get(entry.id) ?? 0)
    addRetainedRecoveryEntry(balance, entry, retained)
  }
  return {
    ...balance,
    outstanding: balance.principalDemanded + balance.interestDemanded -
      balance.receipts - balance.waivers,
  }
}

export const recoveryWorkspace = async (db: Database, recoveryCaseId: string) => {
  const [recoveryCase] = await db.select().from(sebRecoveryCase)
    .where(eq(sebRecoveryCase.id, recoveryCaseId)).limit(1)
  if (!recoveryCase) return null
  /*
   * One statement, not 2. Every read here is single-table, so `db.batch` maps
   * the results back correctly — a joined read could not go in here, because a
   * batch is read back by column name and two columns called `id` collide.
   */
  const [versions, entries] = await batch(db, (tx) => [
    tx.select().from(sebRecoveryCaseVersion)
      .where(eq(sebRecoveryCaseVersion.recoveryCaseId, recoveryCaseId))
      .orderBy(asc(sebRecoveryCaseVersion.version)),
    // Uncapped for the same reason as the disbursement ledger: the outstanding
    // balance is folded from these entries, so a cap would corrupt it.
    tx.select().from(sebRecoveryEntry)
      .where(eq(sebRecoveryEntry.recoveryCaseId, recoveryCaseId))
      .orderBy(asc(sebRecoveryEntry.sequenceNumber)),
  ])
  return { recoveryCase, versions, entries, balance: calculateRecoveryBalance(entries) }
}

/**
 * Calculates retained recovery value entirely inside SQLite. Reversals reduce
 * the exact entry they reference; they never become independent credits. The
 * expression is used in write predicates so a concurrent ledger change cannot
 * pass a stale JavaScript-side balance check.
 */
const recoveryOutstandingSql = (recoveryCaseId: string, component?: RecoveryComponent) => sql`
  COALESCE((
    SELECT SUM(
      CASE
        WHEN original.entry_type = 'DEMAND' THEN
          original.amount_paise - COALESCE((
            SELECT SUM(reversal.amount_paise)
            FROM ${sebRecoveryEntry} AS reversal
            WHERE reversal.related_entry_id = original.id
          ), 0)
        WHEN original.entry_type IN ('RECEIPT', 'WAIVER') THEN
          -(original.amount_paise - COALESCE((
            SELECT SUM(reversal.amount_paise)
            FROM ${sebRecoveryEntry} AS reversal
            WHERE reversal.related_entry_id = original.id
          ), 0))
        ELSE 0
      END
    )
    FROM ${sebRecoveryEntry} AS original
    WHERE original.recovery_case_id = ${recoveryCaseId}
      AND original.entry_type <> 'REVERSAL'
      ${component ? sql`AND original.component = ${component}` : sql``}
  ), 0)
`

export const openRecoveryWrite = async (
  context: AdminOperationContext,
  input: {
    awardId: string
    actorId: string
    officialReference: string
    officialDate: string
    reasonCategoryId: string
    applicantMessage: string
    now: Date
  },
): Promise<string | null> => {
  const id = crypto.randomUUID()
  const [inserted] = await batch(context.db, (tx) => [
    tx.insert(sebRecoveryCase).select(sql`
      SELECT ${id}, award.application_id, award.id, 'OPEN', 0,
        ${input.officialReference}, ${input.officialDate}, ${input.reasonCategoryId},
        ${input.applicantMessage}, ${input.actorId}, 1, ${input.now},
        ${input.now}, NULL, NULL, NULL
      FROM ${sebFundingAward} AS award
      WHERE award.id = ${input.awardId} AND award.status = 'CANCELLED'
        AND award.deleted_at IS NULL
        AND (
          SELECT COALESCE(SUM(CASE WHEN entry_type = 'RELEASE' THEN amount_paise ELSE -amount_paise END), 0)
          FROM ${sebDisbursement} WHERE funding_award_id = award.id
        ) > 0
    `).returning({ id: sebRecoveryCase.id }),
    tx.insert(sebRecoveryCaseVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${id}, 1, 'OPEN', 'OPENED', NULL,
        ${input.actorId}, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebRecoveryCase} WHERE ${sebRecoveryCase.id} = ${id})
    `),
    /*
     * Recovery is public money being claimed back, and a waiver is public money
     * written off. Both have to be reviewable after the fact, which means the
     * audit trail and not only the ledger — the ledger says what the balance
     * is, the trail says who moved it.
     */
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RECOVERY_OPENED',
        'SEB_RECOVERY_CASE', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL,
        ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebRecoveryCase} WHERE ${sebRecoveryCase.id} = ${id})
    `),
  ])
  return changedExactlyOne(inserted) ? id : null
}

export const recordRecoveryEntryWrite = async (
  context: AdminOperationContext,
  input: {
    recoveryCaseId: string
    expectedLedgerVersion: number
    entryType: 'DEMAND' | 'RECEIPT' | 'WAIVER' | 'REVERSAL'
    component: RecoveryComponent
    relatedEntryId: string | null
    amountPaise: number
    externalReference: string
    occurredAt: Date
    reasonCategoryId: string | null
    applicantMessage: string
    actorId: string
    now: Date
  },
): Promise<string | null> => {
  const id = crypto.randomUUID()
  const next = input.expectedLedgerVersion + 1
  const entryGuard = input.entryType === 'REVERSAL'
    ? sql`EXISTS (
        SELECT 1 FROM ${sebRecoveryEntry} AS original
        WHERE original.id = ${input.relatedEntryId}
          AND original.recovery_case_id = ${input.recoveryCaseId}
          AND original.entry_type <> 'REVERSAL'
          AND original.component = ${input.component}
          AND ${input.amountPaise} <= original.amount_paise - COALESCE((
            SELECT SUM(existing.amount_paise)
            FROM ${sebRecoveryEntry} AS existing
            WHERE existing.related_entry_id = original.id
          ), 0)
      )`
    : input.entryType === 'RECEIPT' || input.entryType === 'WAIVER'
      ? sql`${input.amountPaise} <= ${recoveryOutstandingSql(input.recoveryCaseId, input.component)}`
      : sql`1 = 1`
  const [inserted] = await batch(context.db, (tx) => [
    tx.insert(sebRecoveryEntry).select(sql`
      SELECT ${id}, ${input.recoveryCaseId}, ${next}, ${input.entryType},
        ${input.component}, ${input.relatedEntryId}, ${input.amountPaise},
        ${input.externalReference}, ${input.occurredAt}, ${input.reasonCategoryId},
        ${input.applicantMessage}, ${input.actorId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRecoveryCase}
        WHERE ${sebRecoveryCase.id} = ${input.recoveryCaseId}
          AND ${sebRecoveryCase.ledgerVersion} = ${input.expectedLedgerVersion}
          AND ${sebRecoveryCase.status} IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED', 'SETTLED')
          AND ${sebRecoveryCase.deletedAt} IS NULL
      )
        AND ${entryGuard}
    `).returning({ id: sebRecoveryEntry.id }),
    tx.update(sebRecoveryCase).set({
      ledgerVersion: next,
      status: sql`CASE
        WHEN ${recoveryOutstandingSql(input.recoveryCaseId)} = 0 THEN 'SETTLED'
        WHEN EXISTS (
          SELECT 1 FROM ${sebRecoveryEntry}
          WHERE ${sebRecoveryEntry.recoveryCaseId} = ${input.recoveryCaseId}
            AND ${sebRecoveryEntry.entryType} IN ('RECEIPT', 'WAIVER')
        ) THEN 'PARTIALLY_SETTLED'
        ELSE 'DEMANDED'
      END`,
      updatedAt: input.now,
    }).where(and(
      eq(sebRecoveryCase.id, input.recoveryCaseId),
      eq(sebRecoveryCase.ledgerVersion, input.expectedLedgerVersion),
      sql`EXISTS (SELECT 1 FROM ${sebRecoveryEntry} WHERE ${sebRecoveryEntry.id} = ${id})`,
    )),
    /*
     * The entry type is recorded in the metadata, because a waiver and a
     * receipt are the same shape and very different acts — a trail that could
     * not tell them apart would be no use for the one that matters.
     */
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RECOVERY_ENTRY_RECORDED',
        'SEB_RECOVERY_CASE', ${input.recoveryCaseId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, ${JSON.stringify({ entryType: input.entryType, component: input.component })},
        ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebRecoveryEntry} WHERE ${sebRecoveryEntry.id} = ${id})
    `),
  ])
  return changedExactlyOne(inserted) ? id : null
}

export const closeRecoveryWrite = async (
  context: AdminOperationContext,
  input: { recoveryCaseId: string; expectedVersion: number; actorId: string; reason: string; now: Date },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const [changed] = await batch(context.db, (tx) => [
    tx.update(sebRecoveryCase).set({
      status: 'CLOSED', currentVersion: next, updatedAt: input.now,
    }).where(and(
      eq(sebRecoveryCase.id, input.recoveryCaseId),
      eq(sebRecoveryCase.currentVersion, input.expectedVersion),
      sql`${sebRecoveryCase.status} IN ('SETTLED', 'PARTIALLY_SETTLED', 'DEMANDED')`,
      sql`${recoveryOutstandingSql(input.recoveryCaseId)} = 0`,
      isNull(sebRecoveryCase.deletedAt),
    )).returning({ id: sebRecoveryCase.id }),
    tx.insert(sebRecoveryCaseVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.recoveryCaseId}, ${next}, 'CLOSED',
        'CLOSED', ${input.reason}, ${input.actorId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRecoveryCase}
        WHERE ${sebRecoveryCase.id} = ${input.recoveryCaseId}
          AND ${sebRecoveryCase.currentVersion} = ${next}
      )
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RECOVERY_CLOSED',
        'SEB_RECOVERY_CASE', ${input.recoveryCaseId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRecoveryCase}
        WHERE ${sebRecoveryCase.id} = ${input.recoveryCaseId}
          AND ${sebRecoveryCase.currentVersion} = ${next}
      )
    `),
  ])
  return changedExactlyOne(changed)
}

/**
 * Cancels only an empty recovery case that was opened in error.
 *
 * Once a demand, receipt, waiver, or reversal exists, the accounting history is
 * evidence and must be corrected with compensating entries before normal
 * closure. Keeping this rule in the guarded SQL predicate makes cancellation
 * race-safe against the first concurrent ledger entry.
 */
export const cancelRecoveryWrite = async (
  context: AdminOperationContext,
  input: {
    recoveryCaseId: string
    expectedVersion: number
    actorId: string
    reason: string
    now: Date
  },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const [changed] = await batch(context.db, (tx) => [
    tx.update(sebRecoveryCase).set({
      status: 'CANCELLED', currentVersion: next, updatedAt: input.now,
    }).where(and(
      eq(sebRecoveryCase.id, input.recoveryCaseId),
      eq(sebRecoveryCase.currentVersion, input.expectedVersion),
      eq(sebRecoveryCase.status, 'OPEN'),
      isNull(sebRecoveryCase.deletedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM ${sebRecoveryEntry}
        WHERE ${sebRecoveryEntry.recoveryCaseId} = ${input.recoveryCaseId}
      )`,
    )).returning({ id: sebRecoveryCase.id }),
    tx.insert(sebRecoveryCaseVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.recoveryCaseId}, ${next}, 'CANCELLED',
        'CANCELLED', ${input.reason}, ${input.actorId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRecoveryCase}
        WHERE ${sebRecoveryCase.id} = ${input.recoveryCaseId}
          AND ${sebRecoveryCase.currentVersion} = ${next}
          AND ${sebRecoveryCase.status} = 'CANCELLED'
      )
    `),
    /*
     * A cancellation is the one recovery act that leaves no ledger entry
     * behind, so without this the case would vanish from the trail entirely
     * rather than merely being unexplained.
     */
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RECOVERY_CANCELLED',
        'SEB_RECOVERY_CASE', ${input.recoveryCaseId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRecoveryCase}
        WHERE ${sebRecoveryCase.id} = ${input.recoveryCaseId}
          AND ${sebRecoveryCase.currentVersion} = ${next}
      )
    `),
  ])
  return changedExactlyOne(changed)
}
