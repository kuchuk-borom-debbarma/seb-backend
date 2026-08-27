/**
 * Guarded persistence for partner-bank evidence and programme decisions.
 *
 * Every transition begins with an optimistic update and makes all append-only
 * evidence depend on the resulting version/state. The statements run in one
 * transaction, so a concurrent winner leaves no partial referral, decision,
 * timeline, or audit record behind.
 */
import { and, asc, count, desc, eq, getTableColumns, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { COUNT_MISSING, requireInvariant } from '../../application/support'
import { batch, type Database } from '../../../db'
import { encodeAdminCursor } from '../pagination'
import type { PageInfo } from '../types'
import {
  coreAuditEvent,
  sebApplication,
  sebApplicationAssignmentEvent,
  sebApplicationSubmission,
  sebApplicationEvent,
  sebDeskReview,
  sebFundingAward,
  sebPartnerBankOutcome,
  sebPartnerBankReferral,
  sebPartnerBankReferralVersion,
  sebRevisionRequest,
  sebProgrammeDecision,
} from '../../../db/schema'
import { changedExactlyOne, disclosedSelfReview, headJustMovedTo } from '../support'
import type { AdminOperationContext, BankOutcome, DecisionOutcome } from '../types'

const auditSelect = (
  context: AdminOperationContext,
  input: { actorId: string; action: string; type: string; id: string; now: Date; guard: ReturnType<typeof sql> },
) => context.db.insert(coreAuditEvent).select(sql`
  SELECT ${crypto.randomUUID()}, ${input.actorId}, ${input.action}, ${input.type},
    ${input.id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL, ${input.now}
  WHERE ${input.guard}
`)

export const createBankReferralWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    submissionId: string
    deskReviewId: string
    expectedStatusVersion: number
    actorId: string
    bankName: string
    bankBranch: string | null
    referralReference: string
    referralDate: string
    applicantMessage: string
    internalNote: string | null
    now: Date
  },
): Promise<boolean> => {
  const id = crypto.randomUUID()
  const nextStatusVersion = input.expectedStatusVersion + 1
  const update = context.db.update(sebApplication).set({
    statusVersion: nextStatusVersion,
    statusChangedAt: input.now,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'PARTNER_BANK_EVALUATION'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    isNull(sebApplication.deletedAt),
    sql`EXISTS (
      SELECT 1 FROM ${sebDeskReview}
      WHERE ${sebDeskReview.id} = ${input.deskReviewId}
        AND ${sebDeskReview.applicationId} = ${input.applicationId}
        AND ${sebDeskReview.submissionId} = ${input.submissionId}
        AND ${sebDeskReview.outcome} = 'ADVANCE_TO_BANK'
    )`,
  )).returning({ id: sebApplication.id })
  const guard = sql`${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}`
  const [changed] = await batch(context.db, (tx) => [
    update,
    tx.insert(sebPartnerBankReferral).select(sql`
      SELECT ${id}, ${input.applicationId}, ${input.submissionId}, ${input.deskReviewId},
        ${input.bankName}, ${input.bankBranch}, ${input.referralReference},
        ${input.referralDate}, 'OPEN', ${input.internalNote}, ${input.actorId},
        1, ${input.now}, ${input.now}, NULL, NULL, NULL
      WHERE ${guard}
    `),
    tx.insert(sebPartnerBankReferralVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${id}, 1, 'OPEN', 'REFERRED', NULL,
        ${input.actorId}, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebPartnerBankReferral} WHERE ${sebPartnerBankReferral.id} = ${id})
    `),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_REFERRAL_CREATED',
        ${input.actorId}, NULL, ${input.submissionId}, NULL,
        'PARTNER_BANK_EVALUATION', 'PARTNER_BANK_EVALUATION', NULL,
        ${input.applicantMessage}, NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebPartnerBankReferral} WHERE ${sebPartnerBankReferral.id} = ${id})
    `),
    auditSelect(context, {
      actorId: input.actorId,
      action: 'SEB.BANK_REFERRED',
      type: 'SEB_PARTNER_BANK_REFERRAL',
      id,
      now: input.now,
      guard: sql`EXISTS (SELECT 1 FROM ${sebPartnerBankReferral} WHERE ${sebPartnerBankReferral.id} = ${id})`,
    }),
  ])
  return changedExactlyOne(changed)
}

export const recordBankOutcomeWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    referralId: string
    expectedStatusVersion: number
    expectedReferralVersion: number
    actorId: string
    outcome: BankOutcome
    decisionReference: string
    decisionDate: string
    availableLoanAmountPaise: number | null
    applicantSummary: string
    internalNote: string | null
    revisions: Array<{ stageKey: string; reasonCategoryId: string; note: string }>
    now: Date
  },
): Promise<boolean> => {
  const outcomeId = crypto.randomUUID()
  const nextStatus = input.outcome === 'MORE_INFORMATION_REQUIRED'
    ? 'REVISION_REQUIRED' : 'AWAITING_DECISION'
  const nextStatusVersion = input.expectedStatusVersion + 1
  const nextReferralVersion = input.expectedReferralVersion + 1
  const updateApplication = context.db.update(sebApplication).set({
    status: nextStatus,
    statusVersion: nextStatusVersion,
    statusChangedAt: input.now,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'PARTNER_BANK_EVALUATION'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    isNull(sebApplication.deletedAt),
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebProgrammeDecision}
      WHERE ${sebProgrammeDecision.applicationId} = ${input.applicationId}
    )`,
    sql`EXISTS (
      SELECT 1 FROM ${sebPartnerBankReferral}
      WHERE ${sebPartnerBankReferral.id} = ${input.referralId}
        AND ${sebPartnerBankReferral.applicationId} = ${input.applicationId}
        AND ${sebPartnerBankReferral.status} = 'OPEN'
        AND ${sebPartnerBankReferral.currentVersion} = ${input.expectedReferralVersion}
    )`,
  )).returning({ id: sebApplication.id })
  const updateReferral = context.db.update(sebPartnerBankReferral).set({
    status: 'RESPONDED',
    currentVersion: nextReferralVersion,
    updatedAt: input.now,
  }).where(and(
    eq(sebPartnerBankReferral.id, input.referralId),
    eq(sebPartnerBankReferral.applicationId, input.applicationId),
    eq(sebPartnerBankReferral.status, 'OPEN'),
    eq(sebPartnerBankReferral.currentVersion, input.expectedReferralVersion),
    sql`${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}`,
  )).returning({ id: sebPartnerBankReferral.id })
  const referralGuard = sql`EXISTS (
    SELECT 1 FROM ${sebPartnerBankReferral}
    WHERE ${sebPartnerBankReferral.id} = ${input.referralId}
      AND ${sebPartnerBankReferral.currentVersion} = ${nextReferralVersion}
      AND ${sebPartnerBankReferral.status} = 'RESPONDED'
  )`
  const [changed] = await batch(context.db, (tx) => [
    updateApplication,
    updateReferral,
    tx.insert(sebPartnerBankReferralVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.referralId}, ${nextReferralVersion},
        'RESPONDED', 'RESPONDED', NULL, ${input.actorId}, ${input.now}
      WHERE ${referralGuard}
    `),
    tx.insert(sebPartnerBankOutcome).select(sql`
      SELECT ${outcomeId}, ${input.applicationId}, ${input.referralId}, 1,
        ${input.outcome}, ${input.decisionReference}, ${input.decisionDate},
        ${input.availableLoanAmountPaise}, ${input.applicantSummary},
        ${input.internalNote}, NULL, NULL, NULL, ${input.actorId}, ${input.now}
      WHERE ${referralGuard}
    `),
    ...input.revisions.map((revision) => tx.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, referral.submission_id,
        ${revision.stageKey}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now}, NULL, NULL, NULL, NULL, NULL
      FROM ${sebPartnerBankReferral} AS referral
      WHERE referral.id = ${input.referralId}
        AND EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE id = ${outcomeId})
    `)),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_OUTCOME_RECORDED',
        ${input.actorId}, NULL, NULL, NULL, 'PARTNER_BANK_EVALUATION',
        ${nextStatus}, NULL, ${input.applicantSummary}, NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE ${sebPartnerBankOutcome.id} = ${outcomeId})
    `),
    auditSelect(context, {
      actorId: input.actorId,
      action: 'SEB.BANK_OUTCOME_RECORDED',
      type: 'SEB_PARTNER_BANK_OUTCOME',
      id: outcomeId,
      now: input.now,
      guard: sql`EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE ${sebPartnerBankOutcome.id} = ${outcomeId})`,
    }),
  ])
  return changedExactlyOne(changed)
}

/** Cancels an open referral without deleting the bank identity or evidence. */
export const cancelBankReferralWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    referralId: string
    expectedReferralVersion: number
    actorId: string
    reasonCategoryId: string
    reason: string
    applicantMessage: string
    now: Date
  },
): Promise<boolean> => {
  const next = input.expectedReferralVersion + 1
  const updated = context.db.update(sebPartnerBankReferral).set({
    status: 'CANCELLED', currentVersion: next, updatedAt: input.now,
  }).where(and(
    eq(sebPartnerBankReferral.id, input.referralId),
    eq(sebPartnerBankReferral.applicationId, input.applicationId),
    eq(sebPartnerBankReferral.status, 'OPEN'),
    eq(sebPartnerBankReferral.currentVersion, input.expectedReferralVersion),
    isNull(sebPartnerBankReferral.deletedAt),
    sql`EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.applicationId}
        AND ${sebApplication.status} = 'PARTNER_BANK_EVALUATION'
    )`,
  )).returning({ id: sebPartnerBankReferral.id })
  const [changed] = await batch(context.db, (tx) => [
    updated,
    tx.insert(sebPartnerBankReferralVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.referralId}, ${next}, 'CANCELLED',
        'CANCELLED', ${input.reason}, ${input.actorId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebPartnerBankReferral}
        WHERE ${sebPartnerBankReferral.id} = ${input.referralId}
          AND ${sebPartnerBankReferral.currentVersion} = ${next}
      )
    `),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_REFERRAL_CANCELLED',
        ${input.actorId}, NULL, NULL, NULL, 'PARTNER_BANK_EVALUATION',
        'PARTNER_BANK_EVALUATION', NULL, ${input.applicantMessage}, NULL,
        ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebPartnerBankReferral}
        WHERE ${sebPartnerBankReferral.id} = ${input.referralId}
          AND ${sebPartnerBankReferral.status} = 'CANCELLED'
      )
    `),
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.BANK_REFERRAL_CANCELLED',
      type: 'SEB_PARTNER_BANK_REFERRAL', id: input.referralId, now: input.now,
      guard: sql`EXISTS (
        SELECT 1 FROM ${sebPartnerBankReferral}
        WHERE ${sebPartnerBankReferral.id} = ${input.referralId}
          AND ${sebPartnerBankReferral.currentVersion} = ${next}
      )`,
    }),
  ])
  return changedExactlyOne(changed)
}

/** Appends a superseding bank outcome, while no decision has been taken on it. */
export const correctBankOutcomeWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    referralId: string
    supersedesOutcomeId: string
    expectedStatusVersion: number
    actorId: string
    outcome: BankOutcome
    decisionReference: string
    decisionDate: string
    availableLoanAmountPaise: number | null
    applicantSummary: string
    internalNote: string | null
    correctionReasonCategoryId: string
    correctionReason: string
    revisions: Array<{ stageKey: string; reasonCategoryId: string; note: string }>
    now: Date
  },
): Promise<boolean> => {
  const id = crypto.randomUUID()
  const nextStatus = input.outcome === 'MORE_INFORMATION_REQUIRED'
    ? 'REVISION_REQUIRED' : 'AWAITING_DECISION'
  const nextVersion = input.expectedStatusVersion + 1
  const updated = context.db.update(sebApplication).set({
    status: nextStatus, statusVersion: nextVersion,
    statusChangedAt: input.now, updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    sql`${sebApplication.status} IN ('AWAITING_DECISION', 'REVISION_REQUIRED')`,
    isNull(sebApplication.deletedAt),
    sql`EXISTS (
      SELECT 1 FROM ${sebPartnerBankOutcome} AS previous
      WHERE previous.id = ${input.supersedesOutcomeId}
        AND previous.application_id = ${input.applicationId}
        AND previous.referral_id = ${input.referralId}
        AND NOT EXISTS (
          SELECT 1 FROM ${sebPartnerBankOutcome} AS newer
          WHERE newer.referral_id = previous.referral_id
            AND newer.outcome_number > previous.outcome_number
        )
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebProgrammeDecision}
      WHERE ${sebProgrammeDecision.applicationId} = ${input.applicationId}
    )`,
  )).returning({ id: sebApplication.id })
  const [changed] = await batch(context.db, (tx) => [
    updated,
    tx.update(sebRevisionRequest).set({
      cancelledAt: input.now,
      cancelledByUserId: input.actorId,
      cancellationReason: input.correctionReason,
    }).where(and(
      eq(sebRevisionRequest.applicationId, input.applicationId),
      isNull(sebRevisionRequest.resolvedAt),
      isNull(sebRevisionRequest.cancelledAt),
      sql`${headJustMovedTo(input.applicationId, nextVersion, input.now)}`,
    )),
    tx.insert(sebPartnerBankOutcome).select(sql`
      SELECT ${id}, previous.application_id, previous.referral_id,
        previous.outcome_number + 1, ${input.outcome}, ${input.decisionReference},
        ${input.decisionDate}, ${input.availableLoanAmountPaise},
        ${input.applicantSummary}, ${input.internalNote}, previous.id,
        ${input.correctionReasonCategoryId}, ${input.correctionReason},
        ${input.actorId}, ${input.now}
      FROM ${sebPartnerBankOutcome} AS previous
      WHERE previous.id = ${input.supersedesOutcomeId}
        AND ${headJustMovedTo(input.applicationId, nextVersion, input.now)}
    `),
    ...input.revisions.map((revision) => tx.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, referral.submission_id,
        ${revision.stageKey}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now}, NULL, NULL, NULL, NULL, NULL
      FROM ${sebPartnerBankReferral} AS referral
      WHERE referral.id = ${input.referralId}
        AND EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE id = ${id})
    `)),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_OUTCOME_CORRECTED',
        ${input.actorId}, NULL, NULL, NULL, NULL, ${nextStatus}, NULL,
        ${input.applicantSummary}, NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE id = ${id})
    `),
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.BANK_OUTCOME_CORRECTED',
      type: 'SEB_PARTNER_BANK_OUTCOME', id, now: input.now,
      guard: sql`EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE id = ${id})`,
    }),
  ])
  return changedExactlyOne(changed)
}

/** One source of truth for the application state produced by any outcome. */
const decisionOutcomeState = (outcome: DecisionOutcome) => ({
  status: outcome === 'APPROVED'
    ? 'APPROVED' as const
    : outcome === 'REJECTED'
      ? 'REJECTED' as const
      : outcome === 'REVISION_REQUIRED'
        ? 'REVISION_REQUIRED' as const
        : 'AWAITING_DECISION' as const,
  releasesAssignment: outcome === 'REJECTED',
})

const decisionAssignmentValues = (
  releasesAssignment: boolean,
  actorId: string,
  now: Date,
) => releasesAssignment
  ? {
      assignedToUserId: null,
      assignedAt: null,
      assignmentVersion: sql`${sebApplication.assignmentVersion} + 1`,
    }
  : {
      assignedToUserId: actorId,
      assignedAt: now,
      assignmentVersion: sebApplication.assignmentVersion,
    }

/**
 * An approval is positive and no larger than what the applicant asked for.
 *
 * **Every side is cast.** Written as `${approved} > 0 AND ${approved} <=
 * ${requested}` it read correctly and was wrong: the value appears twice, so
 * the driver binds two separate parameters, and the second comparison then has
 * an untyped parameter on *both* sides. Postgres resolves that pair as `text`,
 * so the bound was applied to the decimal digits as a string.
 *
 * The result was inverted for ordinary amounts, in both directions. What was
 * *observed* is the refusing half: approving ₹9,000 against a ₹100,000 request
 * was rejected, because `'900000' <= '10000000'` is false as text — and since
 * a guarded write reports only "did a row change", the officer was told "The
 * record changed. Reload and try again." about a record nothing had touched.
 *
 * The permitting half — `'5000000' <= '900000'` being *true* — did not reach
 * money, because `approvalProblem` in the controller applies the same bound in
 * JavaScript first and refuses there. That is exactly the redundancy this
 * layer exists to provide, which is the point: it had silently stopped
 * providing it, and nothing would have said so until the day the controller
 * check was the one that was wrong.
 *
 * Both halves are demonstrated against a real Postgres in
 * `test/service/decision-bound.test.ts`, the permitting half by calling this
 * layer directly, since the controller refuses before it.
 */
const approvalGuard = (
  outcome: DecisionOutcome,
  approvedAmountPaise: number | null,
  requestedAmountPaise: number,
) => outcome === 'APPROVED'
  ? sql`${approvedAmountPaise}::bigint > 0
      AND ${approvedAmountPaise}::bigint <= ${requestedAmountPaise}::bigint`
  : undefined

const rejectedAssignmentEvent = (
  context: AdminOperationContext,
  input: {
    applicationId: string
    actorId: string
    reasonCategoryId: string | null
    applicantMessage: string
    now: Date
  },
  statusVersion: number,
  releasesAssignment: boolean,
) => releasesAssignment
  ? [context.db.insert(sebApplicationAssignmentEvent).select(sql`
      SELECT ${crypto.randomUUID()}, application.id, 'RELEASED', application.assignment_version,
        ${input.actorId}, NULL, ${input.reasonCategoryId}, ${input.applicantMessage},
        ${input.actorId}, ${input.now}
      FROM ${sebApplication} AS application
      WHERE application.id = ${input.applicationId}
        AND application.status_version = ${statusVersion}
        AND application.status = 'REJECTED'
    `)]
  : []

/**
 * Records the programme's decision on an application.
 *
 * The gate is the application's own state — `AWAITING_DECISION` at the version
 * the officer read — and holding `DECIDE`. There is no second, time-bounded
 * permission of the kind a sitting committee would give; that reduction in
 * control is deliberate and is recorded in `docs/policy-alignment.md`.
 *
 * The decision stores which submission and which bank appraisal were read,
 * because nothing else on the file records what was in front of the decider,
 * and every revision request it raises is scoped to that submission.
 */
/*
 * Which submission was decided, proved again in the write.
 *
 * The composite foreign key on the decision only says the submission belongs to
 * this application; it cannot say it is the one the officer was reading. Without
 * this term a decision recorded while the applicant is mid-resubmission would
 * name the wrong evidence, and nothing downstream could notice.
 */
const latestSubmissionIs = (applicationId: string, submissionId: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${sebApplicationSubmission} AS decided
  WHERE decided.id = ${submissionId}
    AND decided.application_id = ${applicationId}
    AND NOT EXISTS (
      SELECT 1 FROM ${sebApplicationSubmission} AS later
      WHERE later.application_id = ${applicationId}
        AND later.submission_number > decided.submission_number
    )
)`

/*
 * The bank appraisal the decision considered.
 *
 * Derived rather than supplied: the officer never chooses one, and a caller
 * that could name it could attach a superseded appraisal to a live decision.
 * Empty — so NULL — for a cycle that refers to no bank.
 */
const consideredBankOutcome = (applicationId: string): SQL => sql`(
  SELECT outcome.id FROM ${sebPartnerBankOutcome} AS outcome
  WHERE outcome.application_id = ${applicationId}
  ORDER BY outcome.created_at DESC, outcome.outcome_number DESC
  LIMIT 1
)`

/*
 * Decisions are numbered per application, and the number never restarts.
 *
 * An application sent back for revisions and decided again must not collide with
 * its own first decision. Computed inside the insert rather than read
 * beforehand, or two officers deciding at once both read the same maximum.
 */
const nextDecisionNumber = (applicationId: string): SQL => sql`(
  SELECT COALESCE(MAX(existing.decision_number), 0) + 1
  FROM ${sebProgrammeDecision} AS existing
  WHERE existing.application_id = ${applicationId}
)`

export const recordDecisionWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    submissionId: string
    expectedStatusVersion: number
    actorId: string
    outcome: DecisionOutcome
    reference: string
    date: string
    approvedAmountPaise: number | null
    conditions: string | null
    reasonCategoryId: string | null
    applicantMessage: string
    revisions: Array<{ stageKey: string; reasonCategoryId: string; note: string }>
    requestedAmountPaise: number
    /** True only where the officer is the applicant and said so. */
    conflictAcknowledged?: boolean | null
    now: Date
  },
): Promise<boolean> => {
  const id = crypto.randomUUID()
  // Read from the application rather than from the caller — see
  // `disclosedSelfReview`.
  const disclosed = disclosedSelfReview(
    input.applicationId, input.actorId, input.conflictAcknowledged,
  )
  const { status: nextStatus, releasesAssignment } = decisionOutcomeState(input.outcome)
  const assignment = decisionAssignmentValues(releasesAssignment, input.actorId, input.now)
  const nextStatusVersion = input.expectedStatusVersion + 1
  const updateApplication = context.db.update(sebApplication).set({
    status: nextStatus,
    statusVersion: nextStatusVersion,
    statusChangedAt: input.now,
    ...assignment,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'AWAITING_DECISION'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    isNull(sebApplication.deletedAt),
    approvalGuard(input.outcome, input.approvedAmountPaise, input.requestedAmountPaise),
    latestSubmissionIs(input.applicationId, input.submissionId),
  )).returning({ id: sebApplication.id })
  const decided = sql`EXISTS (
    SELECT 1 FROM ${sebProgrammeDecision} WHERE ${sebProgrammeDecision.id} = ${id}
  )`
  const [changed] = await batch(context.db, (tx) => [
    updateApplication,
    tx.insert(sebProgrammeDecision).select(sql`
      SELECT ${id}, ${input.applicationId}, ${input.submissionId},
        ${consideredBankOutcome(input.applicationId)},
        ${nextDecisionNumber(input.applicationId)},
        ${input.outcome}, ${input.reference}, ${input.date}, ${input.approvedAmountPaise},
        ${input.conditions}, ${input.reasonCategoryId}, ${input.applicantMessage},
        NULL, NULL, NULL,
        ${input.actorId}, ${input.now}, ${disclosed}
      WHERE ${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}
    `),
    ...input.revisions.map((revision) => tx.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, ${input.submissionId},
        ${revision.stageKey}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now}, NULL, NULL, NULL, NULL, NULL
      WHERE ${decided}
    `)),
    ...rejectedAssignmentEvent(context, input, nextStatusVersion, releasesAssignment),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'DECISION_RECORDED',
        ${input.actorId}, NULL, ${input.submissionId}, NULL,
        'AWAITING_DECISION', ${nextStatus}, NULL,
        ${input.applicantMessage}, NULL, ${input.now}
      WHERE ${decided}
    `),
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.DECISION_RECORDED',
      type: 'SEB_PROGRAMME_DECISION', id, now: input.now,
      guard: decided,
    }),
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.SELF_REVIEW_DISCLOSED',
      type: 'SEB_PROGRAMME_DECISION', id, now: input.now,
      guard: sql`${disclosed} AND ${decided}`,
    }),
  ])
  return changedExactlyOne(changed)
}

/**
 * Corrects a decision by appending a superseding one. The write is blocked once
 * an award or later phase retry exists because those downstream facts must be
 * corrected through award/recovery records instead.
 */
export const correctDecisionWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    supersedesDecisionId: string
    expectedStatusVersion: number
    actorId: string
    outcome: DecisionOutcome
    reference: string
    date: string
    approvedAmountPaise: number | null
    conditions: string | null
    reasonCategoryId: string | null
    correctionReasonCategoryId: string
    correctionReason: string
    applicantMessage: string
    revisions: Array<{ stageKey: string; reasonCategoryId: string; note: string }>
    requestedAmountPaise: number
    /** True only where the officer is the applicant and said so. */
    conflictAcknowledged?: boolean | null
    now: Date
  },
): Promise<boolean> => {
  const id = crypto.randomUUID()
  // Read from the application rather than from the caller — see
  // `disclosedSelfReview`.
  const disclosed = disclosedSelfReview(
    input.applicationId, input.actorId, input.conflictAcknowledged,
  )
  const { status: nextStatus, releasesAssignment } = decisionOutcomeState(input.outcome)
  const assignment = decisionAssignmentValues(releasesAssignment, input.actorId, input.now)
  const nextVersion = input.expectedStatusVersion + 1
  const updated = context.db.update(sebApplication).set({
    status: nextStatus,
    statusVersion: nextVersion,
    statusChangedAt: input.now,
    ...assignment,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    sql`${sebApplication.status} IN ('APPROVED', 'REJECTED', 'AWAITING_DECISION', 'REVISION_REQUIRED')`,
    isNull(sebApplication.deletedAt),
    approvalGuard(input.outcome, input.approvedAmountPaise, input.requestedAmountPaise),
    /* Only the application's most recent decision may be superseded. */
    sql`EXISTS (
      SELECT 1 FROM ${sebProgrammeDecision} AS previous
      WHERE previous.id = ${input.supersedesDecisionId}
        AND previous.application_id = ${input.applicationId}
        AND NOT EXISTS (
          SELECT 1 FROM ${sebProgrammeDecision} AS newer
          WHERE newer.application_id = previous.application_id
            AND newer.decision_number > previous.decision_number
        )
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebFundingAward}
      WHERE ${sebFundingAward.applicationId} = ${input.applicationId}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebApplication} AS retry
      INNER JOIN ${sebProgrammeDecision} AS previous
        ON previous.id = ${input.supersedesDecisionId}
      WHERE retry.funding_case_id = ${sebApplication.fundingCaseId}
        AND retry.phase_number = ${sebApplication.phaseNumber}
        AND retry.id <> ${input.applicationId}
        AND retry.created_at > previous.created_at
    )`,
  )).returning({ id: sebApplication.id })
  const corrected = sql`EXISTS (
    SELECT 1 FROM ${sebProgrammeDecision} WHERE ${sebProgrammeDecision.id} = ${id}
  )`
  const [changed] = await batch(context.db, (tx) => [
    updated,
    tx.update(sebRevisionRequest).set({
      cancelledAt: input.now,
      cancelledByUserId: input.actorId,
      cancellationReason: input.correctionReason,
    }).where(and(
      eq(sebRevisionRequest.applicationId, input.applicationId),
      isNull(sebRevisionRequest.resolvedAt),
      isNull(sebRevisionRequest.cancelledAt),
      sql`${headJustMovedTo(input.applicationId, nextVersion, input.now)}`,
    )),
    /*
     * The evidence pins are copied from the decision being superseded rather
     * than taken from the caller. A correction restates what was considered; it
     * does not get to change it.
     */
    tx.insert(sebProgrammeDecision).select(sql`
      SELECT ${id}, previous.application_id, previous.submission_id,
        previous.bank_outcome_id, previous.decision_number + 1,
        ${input.outcome}, ${input.reference},
        ${input.date}, ${input.approvedAmountPaise}, ${input.conditions},
        ${input.reasonCategoryId}, ${input.applicantMessage},
        previous.id, ${input.correctionReasonCategoryId}, ${input.correctionReason},
        ${input.actorId}, ${input.now}, ${disclosed}
      FROM ${sebProgrammeDecision} AS previous
      WHERE previous.id = ${input.supersedesDecisionId}
        AND ${headJustMovedTo(input.applicationId, nextVersion, input.now)}
    `),
    ...input.revisions.map((revision) => tx.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, corrected.application_id, corrected.submission_id,
        ${revision.stageKey}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now}, NULL, NULL, NULL, NULL, NULL
      FROM ${sebProgrammeDecision} AS corrected
      WHERE corrected.id = ${id}
    `)),
    ...rejectedAssignmentEvent(context, input, nextVersion, releasesAssignment),
    /*
     * The submission is read off the correction rather than taken from the
     * caller, so the timeline and the decision cannot name different ones.
     */
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'DECISION_CORRECTED',
        ${input.actorId}, NULL, corrected.submission_id, NULL, NULL, ${nextStatus},
        NULL, ${input.applicantMessage}, NULL, ${input.now}
      FROM ${sebProgrammeDecision} AS corrected
      WHERE corrected.id = ${id}
    `),
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.DECISION_CORRECTED',
      type: 'SEB_PROGRAMME_DECISION', id, now: input.now,
      guard: corrected,
    }),
    /*
     * A correction is its own act, so it carries its own disclosure. A
     * disclosure made when the original decision was recorded says nothing
     * about who is superseding it, possibly months later.
     */
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.SELF_REVIEW_DISCLOSED',
      type: 'SEB_PROGRAMME_DECISION', id, now: input.now,
      guard: sql`${disclosed} AND ${corrected}`,
    }),
  ])
  return changedExactlyOne(changed)
}
