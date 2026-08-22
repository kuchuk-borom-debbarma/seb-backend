/**
 * Guarded persistence for partner-bank evidence and formal TTM decisions.
 *
 * Every transition begins with an optimistic update and makes all append-only
 * evidence depend on the resulting version/state. D1 executes the bounded
 * batch atomically, so a concurrent winner leaves no partial referral,
 * meeting, agenda, decision, timeline, or audit record behind.
 */
import { and, asc, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  sebApplication,
  sebApplicationAssignmentEvent,
  sebApplicationEvent,
  sebDeskReview,
  sebFundingAward,
  sebPartnerBankOutcome,
  sebPartnerBankReferral,
  sebPartnerBankReferralVersion,
  sebRevisionRequest,
  sebTtmAgendaItem,
  sebTtmAgendaItemVersion,
  sebTtmDecision,
  sebTtmMeeting,
  sebTtmMeetingVersion,
} from '../../../db/schema'
import { changedExactlyOne } from '../support'
import type { AdminOperationContext, BankOutcome, TtmDecisionOutcome } from '../types'

const auditSelect = (
  context: AdminOperationContext,
  input: { actorId: string; action: string; type: string; id: string; now: Date; guard: ReturnType<typeof sql> },
) => context.db.insert(coreAuditEvent).select(sql`
  SELECT ${crypto.randomUUID()}, ${input.actorId}, ${input.action}, ${input.type},
    ${input.id}, 'SUCCESS', NULL, NULL, NULL, NULL, NULL, ${input.now.getTime()}
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
    eq(sebApplication.assignedToUserId, input.actorId),
    isNull(sebApplication.deletedAt),
    sql`EXISTS (
      SELECT 1 FROM ${sebDeskReview}
      WHERE ${sebDeskReview.id} = ${input.deskReviewId}
        AND ${sebDeskReview.applicationId} = ${input.applicationId}
        AND ${sebDeskReview.submissionId} = ${input.submissionId}
        AND ${sebDeskReview.outcome} = 'ADVANCE_TO_BANK'
    )`,
  )).returning({ id: sebApplication.id })
  const guard = sql`EXISTS (
    SELECT 1 FROM ${sebApplication}
    WHERE ${sebApplication.id} = ${input.applicationId}
      AND ${sebApplication.statusVersion} = ${nextStatusVersion}
  )`
  const [changed] = await context.db.batch([
    update,
    context.db.insert(sebPartnerBankReferral).select(sql`
      SELECT ${id}, ${input.applicationId}, ${input.submissionId}, ${input.deskReviewId},
        ${input.bankName}, ${input.bankBranch}, ${input.referralReference},
        ${input.referralDate}, 'OPEN', ${input.internalNote}, ${input.actorId},
        1, ${input.now.getTime()}, ${input.now.getTime()}, NULL, NULL, NULL
      WHERE ${guard}
    `),
    context.db.insert(sebPartnerBankReferralVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${id}, 1, 'OPEN', 'REFERRED', NULL,
        ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebPartnerBankReferral} WHERE ${sebPartnerBankReferral.id} = ${id})
    `),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_REFERRAL_CREATED',
        ${input.actorId}, NULL, ${input.submissionId}, NULL,
        'PARTNER_BANK_EVALUATION', 'PARTNER_BANK_EVALUATION', NULL,
        ${input.applicantMessage}, NULL, ${input.now.getTime()}
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
    revisions: Array<{ section: string; reasonCategoryId: string; note: string }>
    now: Date
  },
): Promise<boolean> => {
  const outcomeId = crypto.randomUUID()
  const nextStatus = input.outcome === 'MORE_INFORMATION_REQUIRED'
    ? 'REVISION_REQUIRED' : 'TTM_REVIEW'
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
    eq(sebApplication.assignedToUserId, input.actorId),
    isNull(sebApplication.deletedAt),
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebTtmDecision}
      WHERE ${sebTtmDecision.applicationId} = ${input.applicationId}
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
    sql`EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.applicationId}
        AND ${sebApplication.statusVersion} = ${nextStatusVersion}
    )`,
  )).returning({ id: sebPartnerBankReferral.id })
  const referralGuard = sql`EXISTS (
    SELECT 1 FROM ${sebPartnerBankReferral}
    WHERE ${sebPartnerBankReferral.id} = ${input.referralId}
      AND ${sebPartnerBankReferral.currentVersion} = ${nextReferralVersion}
      AND ${sebPartnerBankReferral.status} = 'RESPONDED'
  )`
  const [changed] = await context.db.batch([
    updateApplication,
    updateReferral,
    context.db.insert(sebPartnerBankReferralVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.referralId}, ${nextReferralVersion},
        'RESPONDED', 'RESPONDED', NULL, ${input.actorId}, ${input.now.getTime()}
      WHERE ${referralGuard}
    `),
    context.db.insert(sebPartnerBankOutcome).select(sql`
      SELECT ${outcomeId}, ${input.applicationId}, ${input.referralId}, 1,
        ${input.outcome}, ${input.decisionReference}, ${input.decisionDate},
        ${input.availableLoanAmountPaise}, ${input.applicantSummary},
        ${input.internalNote}, NULL, NULL, NULL, ${input.actorId}, ${input.now.getTime()}
      WHERE ${referralGuard}
    `),
    ...input.revisions.map((revision) => context.db.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, referral.submission_id,
        ${revision.section}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now.getTime()}, NULL, NULL, NULL, NULL, NULL
      FROM ${sebPartnerBankReferral} AS referral
      WHERE referral.id = ${input.referralId}
        AND EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE id = ${outcomeId})
    `)),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_OUTCOME_RECORDED',
        ${input.actorId}, NULL, NULL, NULL, 'PARTNER_BANK_EVALUATION',
        ${nextStatus}, NULL, ${input.applicantSummary}, NULL, ${input.now.getTime()}
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
        AND ${sebApplication.assignedToUserId} = ${input.actorId}
        AND ${sebApplication.status} = 'PARTNER_BANK_EVALUATION'
    )`,
  )).returning({ id: sebPartnerBankReferral.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.insert(sebPartnerBankReferralVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.referralId}, ${next}, 'CANCELLED',
        'CANCELLED', ${input.reason}, ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebPartnerBankReferral}
        WHERE ${sebPartnerBankReferral.id} = ${input.referralId}
          AND ${sebPartnerBankReferral.currentVersion} = ${next}
      )
    `),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_REFERRAL_CANCELLED',
        ${input.actorId}, NULL, NULL, NULL, 'PARTNER_BANK_EVALUATION',
        'PARTNER_BANK_EVALUATION', NULL, ${input.applicantMessage}, NULL,
        ${input.now.getTime()}
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

/** Appends a superseding bank outcome while TTM evidence is still unlocked. */
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
    revisions: Array<{ section: string; reasonCategoryId: string; note: string }>
    now: Date
  },
): Promise<boolean> => {
  const id = crypto.randomUUID()
  const nextStatus = input.outcome === 'MORE_INFORMATION_REQUIRED'
    ? 'REVISION_REQUIRED' : 'TTM_REVIEW'
  const nextVersion = input.expectedStatusVersion + 1
  const updated = context.db.update(sebApplication).set({
    status: nextStatus, statusVersion: nextVersion,
    statusChangedAt: input.now, updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    eq(sebApplication.assignedToUserId, input.actorId),
    sql`${sebApplication.status} IN ('TTM_REVIEW', 'REVISION_REQUIRED')`,
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
      SELECT 1 FROM ${sebTtmDecision}
      WHERE ${sebTtmDecision.applicationId} = ${input.applicationId}
    )`,
  )).returning({ id: sebApplication.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.update(sebRevisionRequest).set({
      cancelledAt: input.now,
      cancelledByUserId: input.actorId,
      cancellationReason: input.correctionReason,
    }).where(and(
      eq(sebRevisionRequest.applicationId, input.applicationId),
      isNull(sebRevisionRequest.resolvedAt),
      isNull(sebRevisionRequest.cancelledAt),
      sql`EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.statusVersion} = ${nextVersion}
      )`,
    )),
    context.db.insert(sebPartnerBankOutcome).select(sql`
      SELECT ${id}, previous.application_id, previous.referral_id,
        previous.outcome_number + 1, ${input.outcome}, ${input.decisionReference},
        ${input.decisionDate}, ${input.availableLoanAmountPaise},
        ${input.applicantSummary}, ${input.internalNote}, previous.id,
        ${input.correctionReasonCategoryId}, ${input.correctionReason},
        ${input.actorId}, ${input.now.getTime()}
      FROM ${sebPartnerBankOutcome} AS previous
      WHERE previous.id = ${input.supersedesOutcomeId}
        AND EXISTS (
          SELECT 1 FROM ${sebApplication}
          WHERE ${sebApplication.id} = ${input.applicationId}
            AND ${sebApplication.statusVersion} = ${nextVersion}
        )
    `),
    ...input.revisions.map((revision) => context.db.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, referral.submission_id,
        ${revision.section}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now.getTime()}, NULL, NULL, NULL, NULL, NULL
      FROM ${sebPartnerBankReferral} AS referral
      WHERE referral.id = ${input.referralId}
        AND EXISTS (SELECT 1 FROM ${sebPartnerBankOutcome} WHERE id = ${id})
    `)),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'BANK_OUTCOME_CORRECTED',
        ${input.actorId}, NULL, NULL, NULL, NULL, ${nextStatus}, NULL,
        ${input.applicantSummary}, NULL, ${input.now.getTime()}
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

export const listMeetings = (db: Database) => db.select().from(sebTtmMeeting)
  .orderBy(desc(sebTtmMeeting.scheduledAt), desc(sebTtmMeeting.id))

export const meetingWorkspace = async (db: Database, meetingId: string) => {
  const [meeting] = await db.select().from(sebTtmMeeting)
    .where(eq(sebTtmMeeting.id, meetingId)).limit(1)
  if (!meeting) return null
  const [versions, agenda, decisions] = await Promise.all([
    db.select().from(sebTtmMeetingVersion)
      .where(eq(sebTtmMeetingVersion.meetingId, meetingId))
      .orderBy(asc(sebTtmMeetingVersion.version)),
    db.select().from(sebTtmAgendaItem)
      .where(eq(sebTtmAgendaItem.meetingId, meetingId))
      .orderBy(asc(sebTtmAgendaItem.position)),
    db.select(getTableColumns(sebTtmDecision)).from(sebTtmDecision)
      .innerJoin(sebTtmAgendaItem, eq(sebTtmAgendaItem.id, sebTtmDecision.agendaItemId))
      .where(eq(sebTtmAgendaItem.meetingId, meetingId))
      .orderBy(asc(sebTtmDecision.createdAt)),
  ])
  return { meeting, versions, agenda, decisions }
}

export const createMeetingWrite = async (
  context: AdminOperationContext,
  input: { actorId: string; reference: string; scheduledAt: Date; venue: string; description: string | null; now: Date },
) => {
  const id = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  const [inserted] = await context.db.batch([
    context.db.insert(sebTtmMeeting).values({
      id,
      meetingReference: input.reference,
      scheduledAt: input.scheduledAt,
      venue: input.venue,
      description: input.description,
      status: 'DRAFT',
      currentVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
    }).returning({ id: sebTtmMeeting.id }),
    context.db.insert(sebTtmMeetingVersion).select(sql`
      SELECT ${versionId}, ${id}, 1, ${input.reference}, ${input.scheduledAt.getTime()},
        ${input.venue}, ${input.description}, 'DRAFT', 'CREATED', NULL,
        ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebTtmMeeting} WHERE ${sebTtmMeeting.id} = ${id})
    `),
    auditSelect(context, {
      actorId: input.actorId,
      action: 'SEB.TTM_MEETING_CHANGED',
      type: 'SEB_TTM_MEETING', id, now: input.now,
      guard: sql`EXISTS (SELECT 1 FROM ${sebTtmMeetingVersion} WHERE ${sebTtmMeetingVersion.id} = ${versionId})`,
    }),
  ])
  // The head insert is unconditional. It either returns this ID or raises a
  // uniqueness error, which the controller converts to a safe conflict.
  return id
}

/** One source of truth for the application state produced by any TTM outcome. */
const ttmOutcomeState = (outcome: TtmDecisionOutcome) => ({
  status: outcome === 'APPROVED'
    ? 'APPROVED' as const
    : outcome === 'REJECTED'
      ? 'REJECTED' as const
      : outcome === 'REVISION_REQUIRED'
        ? 'REVISION_REQUIRED' as const
        : 'TTM_REVIEW' as const,
  releasesAssignment: outcome === 'REJECTED',
})

const ttmAssignmentValues = (
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

const ttmApprovalGuard = (
  outcome: TtmDecisionOutcome,
  approvedAmountPaise: number | null,
  requestedAmountPaise: number,
) => outcome === 'APPROVED'
  ? sql`${approvedAmountPaise} > 0 AND ${approvedAmountPaise} <= ${requestedAmountPaise}`
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
        ${input.actorId}, NULL, ${input.reasonCategoryId}, ${input.applicantMessage}, 0,
        ${input.actorId}, ${input.now.getTime()}
      FROM ${sebApplication} AS application
      WHERE application.id = ${input.applicationId}
        AND application.status_version = ${statusVersion}
        AND application.status = 'REJECTED'
    `)]
  : []

export const updateDraftMeetingWrite = async (
  context: AdminOperationContext,
  input: { meetingId: string; expectedVersion: number; actorId: string; reference: string; scheduledAt: Date; venue: string; description: string | null; reason: string; now: Date },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const updated = context.db.update(sebTtmMeeting).set({
    meetingReference: input.reference, scheduledAt: input.scheduledAt,
    venue: input.venue, description: input.description,
    currentVersion: next, updatedAt: input.now,
  }).where(and(
    eq(sebTtmMeeting.id, input.meetingId),
    eq(sebTtmMeeting.status, 'DRAFT'),
    eq(sebTtmMeeting.currentVersion, input.expectedVersion),
    isNull(sebTtmMeeting.deletedAt),
  )).returning({ id: sebTtmMeeting.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.insert(sebTtmMeetingVersion).select(sql`
      SELECT ${crypto.randomUUID()}, meeting.id, ${next}, meeting.meeting_reference,
        meeting.scheduled_at, meeting.venue, meeting.description, meeting.status,
        'UPDATED', ${input.reason}, ${input.actorId}, ${input.now.getTime()}
      FROM ${sebTtmMeeting} AS meeting
      WHERE meeting.id = ${input.meetingId} AND meeting.current_version = ${next}
    `),
  ])
  return changedExactlyOne(changed)
}

export const cancelMeetingWrite = async (
  context: AdminOperationContext,
  input: { meetingId: string; expectedVersion: number; actorId: string; reason: string; now: Date },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const updated = context.db.update(sebTtmMeeting).set({
    status: 'CANCELLED', currentVersion: next, updatedAt: input.now,
  }).where(and(
    eq(sebTtmMeeting.id, input.meetingId),
    eq(sebTtmMeeting.currentVersion, input.expectedVersion),
    sql`${sebTtmMeeting.status} IN ('DRAFT', 'IN_SESSION')`,
    isNull(sebTtmMeeting.deletedAt),
  )).returning({ id: sebTtmMeeting.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.update(sebTtmAgendaItem).set({
      status: 'REMOVED', currentVersion: sql`${sebTtmAgendaItem.currentVersion} + 1`,
      updatedAt: input.now,
    }).where(and(
      eq(sebTtmAgendaItem.meetingId, input.meetingId),
      eq(sebTtmAgendaItem.status, 'ACTIVE'),
      sql`EXISTS (
        SELECT 1 FROM ${sebTtmMeeting}
        WHERE ${sebTtmMeeting.id} = ${input.meetingId}
          AND ${sebTtmMeeting.currentVersion} = ${next}
          AND ${sebTtmMeeting.status} = 'CANCELLED'
      )`,
    )),
    context.db.insert(sebTtmAgendaItemVersion).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || item.id, item.id, item.current_version,
        item.position, 'REMOVED', 'REMOVED', ${input.reason}, ${input.actorId},
        ${input.now.getTime()}
      FROM ${sebTtmAgendaItem} AS item
      WHERE item.meeting_id = ${input.meetingId} AND item.status = 'REMOVED'
        AND item.updated_at = ${input.now.getTime()}
    `),
    context.db.insert(sebTtmMeetingVersion).select(sql`
      SELECT ${crypto.randomUUID()}, meeting.id, ${next}, meeting.meeting_reference,
        meeting.scheduled_at, meeting.venue, meeting.description, 'CANCELLED',
        'CANCELLED', ${input.reason}, ${input.actorId}, ${input.now.getTime()}
      FROM ${sebTtmMeeting} AS meeting
      WHERE meeting.id = ${input.meetingId} AND meeting.current_version = ${next}
    `),
  ])
  return changedExactlyOne(changed)
}

export const addAgendaItemWrite = async (
  context: AdminOperationContext,
  input: { meetingId: string; applicationId: string; submissionId: string; bankOutcomeId: string; position: number; actorId: string; now: Date },
) => {
  const id = crypto.randomUUID()
  const [inserted] = await context.db.batch([
    context.db.insert(sebTtmAgendaItem).select(sql`
      SELECT ${id}, ${input.meetingId}, ${input.applicationId}, ${input.submissionId},
        ${input.bankOutcomeId}, ${input.position}, 'ACTIVE', 1,
        ${input.actorId}, ${input.now.getTime()}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebTtmMeeting}
        WHERE ${sebTtmMeeting.id} = ${input.meetingId} AND ${sebTtmMeeting.status} = 'DRAFT'
          AND (SELECT COUNT(*) FROM ${sebTtmAgendaItem}
            WHERE meeting_id = ${input.meetingId} AND status = 'ACTIVE') < 20
      ) AND EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.status} = 'TTM_REVIEW'
          AND ${sebApplication.assignedToUserId} = ${input.actorId}
      )
    `),
    context.db.insert(sebTtmAgendaItemVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${id}, 1, ${input.position}, 'ACTIVE',
        'ADDED', NULL, ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebTtmAgendaItem} WHERE ${sebTtmAgendaItem.id} = ${id})
    `),
  ])
  return changedExactlyOne(inserted) ? id : null
}

export const changeAgendaItemWrite = async (
  context: AdminOperationContext,
  input: { meetingId: string; agendaItemId: string; expectedVersion: number; position: number; remove: boolean; actorId: string; reason: string; now: Date },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const updated = context.db.update(sebTtmAgendaItem).set({
    position: input.remove ? sebTtmAgendaItem.position : input.position,
    status: input.remove ? 'REMOVED' : 'ACTIVE',
    currentVersion: next,
    updatedAt: input.now,
  }).where(and(
    eq(sebTtmAgendaItem.id, input.agendaItemId),
    eq(sebTtmAgendaItem.meetingId, input.meetingId),
    eq(sebTtmAgendaItem.status, 'ACTIVE'),
    eq(sebTtmAgendaItem.currentVersion, input.expectedVersion),
    sql`EXISTS (
      SELECT 1 FROM ${sebTtmMeeting}
      WHERE ${sebTtmMeeting.id} = ${input.meetingId} AND ${sebTtmMeeting.status} = 'DRAFT'
    )`,
  )).returning({ id: sebTtmAgendaItem.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.insert(sebTtmAgendaItemVersion).select(sql`
      SELECT ${crypto.randomUUID()}, item.id, ${next}, item.position, item.status,
        ${input.remove ? 'REMOVED' : 'REORDERED'}, ${input.reason},
        ${input.actorId}, ${input.now.getTime()}
      FROM ${sebTtmAgendaItem} AS item
      WHERE item.id = ${input.agendaItemId} AND item.current_version = ${next}
    `),
  ])
  return changedExactlyOne(changed)
}

export const transitionMeetingWrite = async (
  context: AdminOperationContext,
  input: { meetingId: string; expectedVersion: number; from: 'DRAFT' | 'IN_SESSION'; to: 'IN_SESSION' | 'FINALIZED'; actorId: string; now: Date },
): Promise<boolean> => {
  const next = input.expectedVersion + 1
  const changeType = input.to === 'IN_SESSION' ? 'STARTED' : 'FINALIZED'
  const updated = context.db.update(sebTtmMeeting).set({
    status: input.to,
    currentVersion: next,
    updatedAt: input.now,
  }).where(and(
    eq(sebTtmMeeting.id, input.meetingId),
    eq(sebTtmMeeting.currentVersion, input.expectedVersion),
    eq(sebTtmMeeting.status, input.from),
    isNull(sebTtmMeeting.deletedAt),
    input.to === 'FINALIZED'
      ? sql`NOT EXISTS (
          SELECT 1 FROM ${sebTtmAgendaItem}
          WHERE ${sebTtmAgendaItem.meetingId} = ${input.meetingId}
            AND ${sebTtmAgendaItem.status} = 'ACTIVE'
        )`
      : undefined,
  )).returning({ id: sebTtmMeeting.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.insert(sebTtmMeetingVersion).select(sql`
      SELECT ${crypto.randomUUID()}, meeting.id, ${next}, meeting.meeting_reference,
        meeting.scheduled_at, meeting.venue, meeting.description, ${input.to},
        ${changeType}, NULL, ${input.actorId}, ${input.now.getTime()}
      FROM ${sebTtmMeeting} AS meeting
      WHERE meeting.id = ${input.meetingId}
        AND meeting.current_version = ${next} AND meeting.status = ${input.to}
    `),
  ])
  return changedExactlyOne(changed)
}

export const recordTtmDecisionWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    agendaItemId: string
    expectedStatusVersion: number
    actorId: string
    outcome: TtmDecisionOutcome
    reference: string
    date: string
    approvedAmountPaise: number | null
    conditions: string | null
    reasonCategoryId: string | null
    applicantMessage: string
    nextAction: string | null
    revisions: Array<{ section: string; reasonCategoryId: string; note: string }>
    requestedAmountPaise: number
    now: Date
  },
): Promise<boolean> => {
  const id = crypto.randomUUID()
  const { status: nextStatus, releasesAssignment } = ttmOutcomeState(input.outcome)
  const assignment = ttmAssignmentValues(releasesAssignment, input.actorId, input.now)
  const nextStatusVersion = input.expectedStatusVersion + 1
  const updateApplication = context.db.update(sebApplication).set({
    status: nextStatus,
    statusVersion: nextStatusVersion,
    statusChangedAt: input.now,
    ...assignment,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'TTM_REVIEW'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    eq(sebApplication.assignedToUserId, input.actorId),
    isNull(sebApplication.deletedAt),
    ttmApprovalGuard(input.outcome, input.approvedAmountPaise, input.requestedAmountPaise),
    sql`EXISTS (
      SELECT 1 FROM ${sebTtmAgendaItem}
      INNER JOIN ${sebTtmMeeting}
        ON ${sebTtmMeeting.id} = ${sebTtmAgendaItem.meetingId}
      WHERE ${sebTtmAgendaItem.id} = ${input.agendaItemId}
        AND ${sebTtmAgendaItem.applicationId} = ${input.applicationId}
        AND ${sebTtmAgendaItem.status} = 'ACTIVE'
        AND ${sebTtmMeeting.status} = 'IN_SESSION'
    )`,
  )).returning({ id: sebApplication.id })
  const decideAgenda = context.db.update(sebTtmAgendaItem).set({
    status: 'DECIDED',
    currentVersion: sql`${sebTtmAgendaItem.currentVersion} + 1`,
    updatedAt: input.now,
  }).where(and(
    eq(sebTtmAgendaItem.id, input.agendaItemId),
    eq(sebTtmAgendaItem.applicationId, input.applicationId),
    eq(sebTtmAgendaItem.status, 'ACTIVE'),
    sql`EXISTS (
      SELECT 1 FROM ${sebTtmMeeting}
      WHERE ${sebTtmMeeting.id} = ${sebTtmAgendaItem.meetingId}
        AND ${sebTtmMeeting.status} = 'IN_SESSION'
    )`,
    sql`EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.applicationId}
        AND ${sebApplication.statusVersion} = ${nextStatusVersion}
    )`,
  )).returning({ id: sebTtmAgendaItem.id })
  const [changed] = await context.db.batch([
    updateApplication,
    decideAgenda,
    context.db.insert(sebTtmDecision).select(sql`
      SELECT ${id}, ${input.applicationId}, ${input.agendaItemId}, 1,
        ${input.outcome}, ${input.reference}, ${input.date}, ${input.approvedAmountPaise},
        ${input.conditions}, ${input.reasonCategoryId}, ${input.applicantMessage},
        ${input.nextAction}, NULL, NULL, NULL,
        ${input.actorId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebTtmAgendaItem}
        WHERE ${sebTtmAgendaItem.id} = ${input.agendaItemId}
          AND ${sebTtmAgendaItem.status} = 'DECIDED'
      )
    `),
    ...input.revisions.map((revision) => context.db.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, item.submission_id,
        ${revision.section}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now.getTime()}, NULL, NULL, NULL, NULL, NULL
      FROM ${sebTtmAgendaItem} AS item
      WHERE item.id = ${input.agendaItemId}
        AND EXISTS (SELECT 1 FROM ${sebTtmDecision} WHERE id = ${id})
    `)),
    ...rejectedAssignmentEvent(context, input, nextStatusVersion, releasesAssignment),
    context.db.insert(sebTtmAgendaItemVersion).select(sql`
      SELECT ${crypto.randomUUID()}, item.id, item.current_version, item.position,
        'DECIDED', 'DECIDED', NULL, ${input.actorId}, ${input.now.getTime()}
      FROM ${sebTtmAgendaItem} AS item
      WHERE item.id = ${input.agendaItemId} AND item.status = 'DECIDED'
    `),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'TTM_DECISION_RECORDED',
        ${input.actorId}, NULL, NULL, NULL, 'TTM_REVIEW', ${nextStatus}, NULL,
        ${input.applicantMessage}, NULL, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebTtmDecision} WHERE ${sebTtmDecision.id} = ${id})
    `),
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.TTM_DECISION_RECORDED',
      type: 'SEB_TTM_DECISION', id, now: input.now,
      guard: sql`EXISTS (SELECT 1 FROM ${sebTtmDecision} WHERE ${sebTtmDecision.id} = ${id})`,
    }),
  ])
  return changedExactlyOne(changed)
}

/**
 * Corrects a TTM record by appending a superseding decision. The write is
 * blocked once an award or later phase retry exists because those downstream
 * facts must be corrected through award/recovery records instead.
 */
export const correctTtmDecisionWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    agendaItemId: string
    supersedesDecisionId: string
    expectedStatusVersion: number
    actorId: string
    outcome: TtmDecisionOutcome
    reference: string
    date: string
    approvedAmountPaise: number | null
    conditions: string | null
    reasonCategoryId: string | null
    correctionReasonCategoryId: string
    correctionReason: string
    applicantMessage: string
    nextAction: string | null
    revisions: Array<{ section: string; reasonCategoryId: string; note: string }>
    requestedAmountPaise: number
    now: Date
  },
): Promise<boolean> => {
  const id = crypto.randomUUID()
  const { status: nextStatus, releasesAssignment } = ttmOutcomeState(input.outcome)
  const assignment = ttmAssignmentValues(releasesAssignment, input.actorId, input.now)
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
    eq(sebApplication.assignedToUserId, input.actorId),
    sql`${sebApplication.status} IN ('APPROVED', 'REJECTED', 'TTM_REVIEW', 'REVISION_REQUIRED')`,
    isNull(sebApplication.deletedAt),
    ttmApprovalGuard(input.outcome, input.approvedAmountPaise, input.requestedAmountPaise),
    sql`EXISTS (
      SELECT 1 FROM ${sebTtmDecision} AS previous
      WHERE previous.id = ${input.supersedesDecisionId}
        AND previous.application_id = ${input.applicationId}
        AND previous.agenda_item_id = ${input.agendaItemId}
        AND NOT EXISTS (
          SELECT 1 FROM ${sebTtmDecision} AS newer
          WHERE newer.agenda_item_id = previous.agenda_item_id
            AND newer.decision_number > previous.decision_number
        )
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebFundingAward}
      WHERE ${sebFundingAward.applicationId} = ${input.applicationId}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebApplication} AS retry
      INNER JOIN ${sebTtmDecision} AS previous
        ON previous.id = ${input.supersedesDecisionId}
      WHERE retry.funding_case_id = ${sebApplication.fundingCaseId}
        AND retry.phase_number = ${sebApplication.phaseNumber}
        AND retry.id <> ${input.applicationId}
        AND retry.created_at > previous.created_at
    )`,
  )).returning({ id: sebApplication.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.update(sebRevisionRequest).set({
      cancelledAt: input.now,
      cancelledByUserId: input.actorId,
      cancellationReason: input.correctionReason,
    }).where(and(
      eq(sebRevisionRequest.applicationId, input.applicationId),
      isNull(sebRevisionRequest.resolvedAt),
      isNull(sebRevisionRequest.cancelledAt),
      sql`EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.statusVersion} = ${nextVersion}
      )`,
    )),
    context.db.insert(sebTtmDecision).select(sql`
      SELECT ${id}, previous.application_id, previous.agenda_item_id,
        previous.decision_number + 1, ${input.outcome}, ${input.reference},
        ${input.date}, ${input.approvedAmountPaise}, ${input.conditions},
        ${input.reasonCategoryId}, ${input.applicantMessage}, ${input.nextAction},
        previous.id, ${input.correctionReasonCategoryId}, ${input.correctionReason},
        ${input.actorId}, ${input.now.getTime()}
      FROM ${sebTtmDecision} AS previous
      WHERE previous.id = ${input.supersedesDecisionId}
        AND EXISTS (
          SELECT 1 FROM ${sebApplication}
          WHERE ${sebApplication.id} = ${input.applicationId}
            AND ${sebApplication.statusVersion} = ${nextVersion}
        )
    `),
    ...input.revisions.map((revision) => context.db.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, item.submission_id,
        ${revision.section}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorId}, ${input.now.getTime()}, NULL, NULL, NULL, NULL, NULL
      FROM ${sebTtmAgendaItem} AS item
      WHERE item.id = ${input.agendaItemId}
        AND EXISTS (SELECT 1 FROM ${sebTtmDecision} WHERE id = ${id})
    `)),
    ...rejectedAssignmentEvent(context, input, nextVersion, releasesAssignment),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'TTM_DECISION_CORRECTED',
        ${input.actorId}, NULL, NULL, NULL, NULL, ${nextStatus}, NULL,
        ${input.applicantMessage}, NULL, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebTtmDecision} WHERE id = ${id})
    `),
    auditSelect(context, {
      actorId: input.actorId, action: 'SEB.TTM_DECISION_CORRECTED',
      type: 'SEB_TTM_DECISION', id, now: input.now,
      guard: sql`EXISTS (SELECT 1 FROM ${sebTtmDecision} WHERE id = ${id})`,
    }),
  ])
  return changedExactlyOne(changed)
}
