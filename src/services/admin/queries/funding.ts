/** Guarded funding, assessment, and operational-recovery persistence. */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
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
  sebTtmDecision,
  sebUtilizationObligation,
} from '../../../db/schema'
import { changedExactlyOne } from '../support'
import type { AdminOperationContext, AssessmentType, RecoveryComponent } from '../types'

export const fundingWorkspace = async (db: Database, applicationId: string) => {
  const [award] = await db.select().from(sebFundingAward)
    .where(eq(sebFundingAward.applicationId, applicationId)).limit(1)
  if (!award) return null
  const [versions, ledger, obligations, assessments, recovery] = await Promise.all([
    db.select().from(sebFundingAwardVersion)
      .where(eq(sebFundingAwardVersion.fundingAwardId, award.id))
      .orderBy(asc(sebFundingAwardVersion.version)),
    db.select().from(sebDisbursement)
      .where(eq(sebDisbursement.fundingAwardId, award.id))
      .orderBy(asc(sebDisbursement.sequenceNumber)),
    db.select().from(sebUtilizationObligation)
      .where(eq(sebUtilizationObligation.fundingAwardId, award.id)),
    db.select().from(sebAwardAssessment)
      .where(eq(sebAwardAssessment.fundingAwardId, award.id))
      .orderBy(asc(sebAwardAssessment.createdAt)),
    db.select().from(sebRecoveryCase)
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
  const [updated] = await context.db.batch([
    context.db.update(sebApplication).set({
      status: 'SANCTIONED',
      statusVersion: nextStatusVersion,
      statusChangedAt: input.now,
      updatedAt: input.now,
    }).where(and(
      eq(sebApplication.id, input.applicationId),
      eq(sebApplication.status, 'APPROVED'),
      eq(sebApplication.statusVersion, input.expectedStatusVersion),
      eq(sebApplication.assignedToUserId, input.actorId),
      isNull(sebApplication.deletedAt),
      sql`EXISTS (
        SELECT 1 FROM ${sebTtmDecision}
        WHERE ${sebTtmDecision.id} = ${input.decisionId}
          AND ${sebTtmDecision.applicationId} = ${input.applicationId}
          AND ${sebTtmDecision.outcome} = 'APPROVED'
          AND ${sebTtmDecision.approvedAmountPaise} > 0
          AND NOT EXISTS (
            SELECT 1 FROM ${sebTtmDecision} AS newer
            WHERE newer.application_id = ${input.applicationId}
              AND newer.decision_number > ${sebTtmDecision.decisionNumber}
          )
      )`,
    )).returning({ id: sebApplication.id }),
    context.db.insert(sebFundingAward).select(sql`
      SELECT ${id}, application.funding_case_id, application.id,
        ${input.sanctionOrder}, ${input.sanctionDate}, decision.approved_amount_paise,
        ${input.conditions}, 'ACTIVE', NULL, 0, 1, ${input.now.getTime()},
        ${input.now.getTime()}, NULL, NULL, NULL
      FROM ${sebApplication} AS application
      INNER JOIN ${sebTtmDecision} AS decision ON decision.id = ${input.decisionId}
      WHERE application.id = ${input.applicationId}
        AND application.status = 'SANCTIONED'
        AND application.status_version = ${nextStatusVersion}
    `),
    context.db.insert(sebFundingAwardVersion).select(sql`
      SELECT ${versionId}, ${id}, 1, ${input.sanctionOrder}, ${input.sanctionDate},
        award.sanctioned_amount_paise, ${input.conditions}, 'ACTIVE', NULL, 'CREATED',
        NULL, NULL, ${input.actorId}, ${input.now.getTime()}
      FROM ${sebFundingAward} AS award WHERE award.id = ${id}
    `),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'AWARD_SANCTIONED',
        ${input.actorId}, NULL, NULL, NULL, 'APPROVED', 'SANCTIONED', NULL,
        'Funding support was sanctioned.', NULL, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebFundingAward} WHERE ${sebFundingAward.id} = ${id})
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.AWARD_CREATED',
        'SEB_FUNDING_AWARD', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL,
        ${input.now.getTime()}
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
      FROM ${sebTtmDecision} AS decision
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
  const [changed] = await context.db.batch([
    changedHead,
    context.db.insert(sebFundingAwardVersion).select(sql`
      SELECT ${crypto.randomUUID()}, award.id, ${next}, award.sanction_order_number,
        award.sanction_date, award.sanctioned_amount_paise, award.applicant_conditions,
        award.status, award.closure_disposition, ${input.changeType},
        ${input.reasonCategoryId}, ${input.reason},
        ${input.actorId}, ${input.now.getTime()}
      FROM ${sebFundingAward} AS award
      WHERE award.id = ${input.awardId} AND award.current_version = ${next}
    `),
    context.db.update(sebApplication).set({
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
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'AWARD_CHANGED',
        ${input.actorId}, NULL, NULL, NULL, NULL,
        CASE WHEN ${input.status} = 'CANCELLED' THEN 'CANCELLED' ELSE NULL END,
        NULL, 'The funding award changed.', NULL, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingAwardVersion}
        WHERE ${sebFundingAwardVersion.fundingAwardId} = ${input.awardId}
          AND ${sebFundingAwardVersion.version} = ${next}
      )
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.AWARD_CHANGED',
        'SEB_FUNDING_AWARD', ${input.awardId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, ${JSON.stringify({ status: input.status })}, ${input.now.getTime()}
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
    ttmApprovalReference: string
    ttmApprovalDate: string
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
  const [changed] = await context.db.batch([
    context.db.update(sebFundingAward).set({ ledgerVersion: next, updatedAt: input.now })
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
    context.db.insert(sebDisbursement).select(sql`
      SELECT ${id}, ${input.awardId}, ${next}, 'RELEASE', NULL, ${input.amountPaise},
        ${input.occurredAt.getTime()}, ${input.externalReference},
        ${input.ttmApprovalReference}, ${input.ttmApprovalDate},
        ${input.bankAccountVerifiedAt.getTime()}, ${input.performanceAgreementReference},
        ${input.performanceAgreementExecutedAt.getTime()}, ${input.physicalVerificationRequired},
        ${input.physicalVerificationReference}, ${input.physicalVerificationCompletedAt?.getTime() ?? null},
        NULL, ${input.applicantMessage}, ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingAward}
        WHERE ${sebFundingAward.id} = ${input.awardId} AND ${sebFundingAward.ledgerVersion} = ${next}
      )
    `),
    context.db.insert(sebUtilizationObligation).select(sql`
      SELECT ${obligationId}, ${input.awardId}, ${id}, ${dueAt.getTime()}, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebDisbursement} WHERE ${sebDisbursement.id} = ${id})
    `),
    context.db.update(sebApplication).set({
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
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RELEASE_RECORDED',
        'SEB_DISBURSEMENT', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL,
        ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebUtilizationObligation} WHERE ${sebUtilizationObligation.id} = ${obligationId})
    `),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'RELEASE_RECORDED',
        ${input.actorId}, NULL, NULL, NULL, NULL, 'DISBURSED', NULL,
        ${input.applicantMessage}, NULL, ${input.now.getTime()}
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
  const [changed] = await context.db.batch([
    context.db.update(sebFundingAward).set({ ledgerVersion: next, updatedAt: input.now })
      .where(and(
        eq(sebFundingAward.id, input.awardId),
        eq(sebFundingAward.applicationId, input.applicationId),
        eq(sebFundingAward.ledgerVersion, input.expectedLedgerVersion),
        isNull(sebFundingAward.deletedAt),
        sql`${input.amountPaise} <= (
          SELECT release.amount_paise - COALESCE(SUM(reversal.amount_paise), 0)
          FROM ${sebDisbursement} AS release
          LEFT JOIN ${sebDisbursement} AS reversal
            ON reversal.related_disbursement_id = release.id
          WHERE release.id = ${input.releaseId}
            AND release.funding_award_id = ${input.awardId}
            AND release.entry_type = 'RELEASE'
        )`,
      )).returning({ id: sebFundingAward.id }),
    context.db.insert(sebDisbursement).select(sql`
      SELECT ${id}, ${input.awardId}, ${next}, 'REVERSAL', ${input.releaseId},
        ${input.amountPaise}, ${input.occurredAt.getTime()}, ${input.externalReference},
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.reasonCategoryId}, ${input.applicantMessage}, ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingAward}
        WHERE ${sebFundingAward.id} = ${input.awardId} AND ${sebFundingAward.ledgerVersion} = ${next}
      )
    `),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'RELEASE_REVERSED',
        ${input.actorId}, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.applicantMessage}, NULL, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebDisbursement} WHERE id = ${id})
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.RELEASE_REVERSED',
        'SEB_DISBURSEMENT', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL,
        ${input.now.getTime()}
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
  const [sequence] = await context.db.all<{ value: number }>(sql`
    SELECT COALESCE(MAX(assessment_number), 0) + 1 AS value
    FROM ${sebAwardAssessment}
    WHERE funding_award_id = ${input.awardId}
      AND assessment_type = ${input.type}
      AND utilization_obligation_id IS ${input.obligationId}
  `)
  // SQLite aggregate queries always return one row, even when no assessment
  // exists yet; COALESCE makes the value non-null.
  const number = Number(sequence!.value)
  const [result] = await context.db.batch([
    context.db.insert(sebAwardAssessment).select(sql`
    SELECT ${id}, ${input.awardId}, ${input.type}, ${number}, ${input.outcome},
      ${input.obligationId}, ${input.evidenceReference}, ${input.applicantSummary},
      ${input.internalNote}, ${input.actorId}, ${input.assessedAt.getTime()}, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebFundingAward}
      WHERE ${sebFundingAward.id} = ${input.awardId}
        AND ${sebFundingAward.applicationId} = ${input.applicationId}
        AND ${sebFundingAward.deletedAt} IS NULL
    )
    `).returning({ id: sebAwardAssessment.id }),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'ASSESSMENT_RECORDED',
        ${input.actorId}, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.applicantSummary}, NULL, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebAwardAssessment} WHERE id = ${id})
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorId}, 'SEB.ASSESSMENT_RECORDED',
        'SEB_AWARD_ASSESSMENT', ${id}, 'SUCCESS', NULL, NULL, NULL, NULL,
        ${JSON.stringify({ type: input.type, outcome: input.outcome })}, ${input.now.getTime()}
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
  const [versions, entries] = await Promise.all([
    db.select().from(sebRecoveryCaseVersion)
      .where(eq(sebRecoveryCaseVersion.recoveryCaseId, recoveryCaseId))
      .orderBy(asc(sebRecoveryCaseVersion.version)),
    db.select().from(sebRecoveryEntry)
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
  const [inserted] = await context.db.batch([
    context.db.insert(sebRecoveryCase).select(sql`
      SELECT ${id}, award.application_id, award.id, 'OPEN', 0,
        ${input.officialReference}, ${input.officialDate}, ${input.reasonCategoryId},
        ${input.applicantMessage}, ${input.actorId}, 1, ${input.now.getTime()},
        ${input.now.getTime()}, NULL, NULL, NULL
      FROM ${sebFundingAward} AS award
      WHERE award.id = ${input.awardId} AND award.status = 'CANCELLED'
        AND award.deleted_at IS NULL
        AND (
          SELECT COALESCE(SUM(CASE WHEN entry_type = 'RELEASE' THEN amount_paise ELSE -amount_paise END), 0)
          FROM ${sebDisbursement} WHERE funding_award_id = award.id
        ) > 0
    `).returning({ id: sebRecoveryCase.id }),
    context.db.insert(sebRecoveryCaseVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${id}, 1, 'OPEN', 'OPENED', NULL,
        ${input.actorId}, ${input.now.getTime()}
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
  const [inserted] = await context.db.batch([
    context.db.insert(sebRecoveryEntry).select(sql`
      SELECT ${id}, ${input.recoveryCaseId}, ${next}, ${input.entryType},
        ${input.component}, ${input.relatedEntryId}, ${input.amountPaise},
        ${input.externalReference}, ${input.occurredAt.getTime()}, ${input.reasonCategoryId},
        ${input.applicantMessage}, ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRecoveryCase}
        WHERE ${sebRecoveryCase.id} = ${input.recoveryCaseId}
          AND ${sebRecoveryCase.ledgerVersion} = ${input.expectedLedgerVersion}
          AND ${sebRecoveryCase.status} IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED', 'SETTLED')
          AND ${sebRecoveryCase.deletedAt} IS NULL
      )
        AND ${entryGuard}
    `).returning({ id: sebRecoveryEntry.id }),
    context.db.update(sebRecoveryCase).set({
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
  ])
  return changedExactlyOne(inserted) ? id : null
}

export const closeRecoveryWrite = async (
  context: AdminOperationContext,
  input: { recoveryCaseId: string; expectedVersion: number; actorId: string; reason: string; now: Date },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const [changed] = await context.db.batch([
    context.db.update(sebRecoveryCase).set({
      status: 'CLOSED', currentVersion: next, updatedAt: input.now,
    }).where(and(
      eq(sebRecoveryCase.id, input.recoveryCaseId),
      eq(sebRecoveryCase.currentVersion, input.expectedVersion),
      sql`${sebRecoveryCase.status} IN ('SETTLED', 'PARTIALLY_SETTLED', 'DEMANDED')`,
      sql`${recoveryOutstandingSql(input.recoveryCaseId)} = 0`,
      isNull(sebRecoveryCase.deletedAt),
    )).returning({ id: sebRecoveryCase.id }),
    context.db.insert(sebRecoveryCaseVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.recoveryCaseId}, ${next}, 'CLOSED',
        'CLOSED', ${input.reason}, ${input.actorId}, ${input.now.getTime()}
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
  const [changed] = await context.db.batch([
    context.db.update(sebRecoveryCase).set({
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
    context.db.insert(sebRecoveryCaseVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.recoveryCaseId}, ${next}, 'CANCELLED',
        'CANCELLED', ${input.reason}, ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRecoveryCase}
        WHERE ${sebRecoveryCase.id} = ${input.recoveryCaseId}
          AND ${sebRecoveryCase.currentVersion} = ${next}
          AND ${sebRecoveryCase.status} = 'CANCELLED'
      )
    `),
  ])
  return changedExactlyOne(changed)
}
