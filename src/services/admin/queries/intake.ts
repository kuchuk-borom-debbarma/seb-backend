import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  or,
  sql,
  lt,
  lte,
  type SQL,
} from 'drizzle-orm'
import { COUNT_MISSING, requireInvariant } from '../../application/support'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  sebApplication,
  sebApplicationAssignmentEvent,
  sebApplicationDocumentScan,
  sebApplicationDocumentVersion,
  sebApplicationEvent,
  sebApplicationInternalNote,
  sebApplicationSubmission,
  sebApplicationSubmissionDocument,
  sebApplicationVersion,
  sebDeskReview,
  sebDeskReviewCheck,
  sebEnterprise,
  sebPartnerBankOutcome,
  sebPartnerBankReferral,
  sebProgrammeCycle,
  sebProgrammeCycleReason,
  sebRecoveryCase,
  sebRevisionRequest,
  sebTtmAgendaItem,
  sebTtmDecision,
  sebFundingAward,
  sebDisbursement,
  sebAwardAssessment,
} from '../../../db/schema'
import { changedSections } from '../../application/sections'
import { MAX_COLLECTION_ROWS } from '../../application/pagination'
import { encodeAdminCursor, type SortKey } from '../pagination'
import { prefixMatchAny, prefixPattern } from '../../search'
import { adminAudit } from '../support'
import { intakeQueueKeys } from '../types'
import type {
  AdminOperationContext,
  DeskReviewCheckInput,
  DeskReviewOutcome,
  IntakeQueueKey,
  PageInfo,
  RevisionRequestInput,
} from '../types'

export const loadApplicationHead = async (db: Database, id: string) => {
  const [row] = await db
    .select({
      application: sebApplication,
      enterpriseName: sebEnterprise.currentName,
      cycleCode: sebProgrammeCycle.cycleCode,
      cycleDisplayName: sebProgrammeCycle.displayName,
    })
    .from(sebApplication)
    .innerJoin(sebEnterprise, eq(sebEnterprise.id, sebApplication.enterpriseId))
    .innerJoin(sebProgrammeCycle, eq(sebProgrammeCycle.id, sebApplication.programmeCycleId))
    .where(eq(sebApplication.id, id))
    .limit(1)
  return row ?? null
}

export const latestSubmission = async (db: Database, applicationId: string) => {
  const [row] = await db
    .select({ submission: sebApplicationSubmission, snapshot: sebApplicationVersion })
    .from(sebApplicationSubmission)
    .innerJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplicationSubmission.applicationId),
        eq(sebApplicationVersion.version, sebApplicationSubmission.applicationVersion),
      ),
    )
    .where(eq(sebApplicationSubmission.applicationId, applicationId))
    .orderBy(desc(sebApplicationSubmission.submissionNumber))
    .limit(1)
  return row ?? null
}


const queueKeyPredicate = (queue: IntakeQueueKey): SQL => {
  if (queue === 'NEW_SUBMISSIONS') {
    return and(
      eq(sebApplication.status, 'SUBMITTED'),
      eq(sebApplicationSubmission.submissionNumber, 1),
    )!
  }
  if (queue === 'REVISION_RESPONSES') {
    return and(
      eq(sebApplication.status, 'SUBMITTED'),
      gt(sebApplicationSubmission.submissionNumber, 1),
    )!
  }
  return eq(sebApplication.status, queue)
}


export type IntakeOrder = 'OLDEST_WAITING' | 'NEWEST_SUBMISSION' | 'LAST_ACTIVITY'

/**
 * The column each ordering seeks on.
 *
 * Named rather than derived twice: the cursor carries this key, and the encode
 * and decode sides used to compute it from `order` independently. When they
 * disagreed the cursor seeked the wrong column and returned a wrong page with
 * no error.
 */
export const intakeSortKey = (order: IntakeOrder | null | undefined): SortKey =>
  order === 'NEWEST_SUBMISSION'
    ? 'submittedAt'
    : order === 'LAST_ACTIVITY'
      ? 'updatedAt'
      : 'statusChangedAt'

export const listIntakeQueue = async (
  db: Database,
  input: {
    first: number
    after: { timestamp: Date; id: string } | null
    cycleId?: string | null
    status?: typeof sebApplication.$inferSelect.status | null
    phaseNumber?: number | null
    applicationType?: typeof sebApplication.$inferSelect.applicationType | null
    assigneeUserId?: string | null
    referenceNumber?: string | null
    sector?: string | null
    category?: typeof sebApplicationVersion.$inferSelect.applicationCategory | null
    submittedFrom?: Date | null
    submittedTo?: Date | null
    order?: 'OLDEST_WAITING' | 'NEWEST_SUBMISSION' | 'LAST_ACTIVITY' | null
    queue?: IntakeQueueKey | null
    search?: string | null
  },
): Promise<{ nodes: unknown[]; pageInfo: PageInfo }> => {
  const order = input.order ?? 'OLDEST_WAITING'
  const sortKey = intakeSortKey(order)
  const timestampColumn = sortKey === 'submittedAt'
    ? sebApplicationSubmission.submittedAt
    : sortKey === 'updatedAt' ? sebApplication.updatedAt : sebApplication.statusChangedAt
  const descending = sortKey === 'submittedAt' || sortKey === 'updatedAt'
  const cursor = input.after
    ? or(
        descending
          ? lt(timestampColumn, input.after.timestamp)
          : gt(timestampColumn, input.after.timestamp),
        and(
          eq(timestampColumn, input.after.timestamp),
          descending ? lt(sebApplication.id, input.after.id) : gt(sebApplication.id, input.after.id),
        ),
      )
    : undefined
  /*
   * Everything the filters say, without the cursor — the page seeks from a
   * position, the total counts the whole matching set.
   */
  const pattern = prefixPattern(input.search)
  const filters = and(
    isNull(sebApplication.deletedAt),
    sql`${sebApplication.status} <> 'DRAFT'`,
    input.cycleId ? eq(sebApplication.programmeCycleId, input.cycleId) : undefined,
    input.status ? eq(sebApplication.status, input.status) : undefined,
    input.queue ? queueKeyPredicate(input.queue) : undefined,
    input.phaseNumber ? eq(sebApplication.phaseNumber, input.phaseNumber) : undefined,
    input.applicationType
      ? eq(sebApplication.applicationType, input.applicationType)
      : undefined,
    input.assigneeUserId
      ? eq(sebApplication.assignedToUserId, input.assigneeUserId)
      : undefined,
    input.referenceNumber
      ? eq(sebApplication.referenceNumber, input.referenceNumber)
      : undefined,
    // The reference number or the enterprise name: the two things somebody
    // holding a piece of paper would type.
    pattern
      ? prefixMatchAny([sebApplication.referenceNumber, sebEnterprise.currentName], pattern)
      : undefined,
    input.sector ? sql`${sebApplicationVersion.businessSector} = ${input.sector}` : undefined,
    input.category ? eq(sebApplicationVersion.applicationCategory, input.category) : undefined,
    input.submittedFrom
      ? gte(sebApplicationSubmission.submittedAt, input.submittedFrom) : undefined,
    input.submittedTo
      ? lte(sebApplicationSubmission.submittedAt, input.submittedTo) : undefined,
  )
  const rows = await db
    .select({
      id: sebApplication.id,
      referenceNumber: sebApplication.referenceNumber,
      enterpriseId: sebApplication.enterpriseId,
      enterpriseName: sebEnterprise.currentName,
      applicantUserId: sebApplication.applicantUserId,
      programmeCycleId: sebApplication.programmeCycleId,
      cycleCode: sebProgrammeCycle.cycleCode,
      sector: sebApplicationVersion.businessSector,
      category: sebApplicationVersion.applicationCategory,
      phaseNumber: sebApplication.phaseNumber,
      applicationType: sebApplication.applicationType,
      status: sebApplication.status,
      statusVersion: sebApplication.statusVersion,
      assignedToUserId: sebApplication.assignedToUserId,
      assignedAt: sebApplication.assignedAt,
      assignmentVersion: sebApplication.assignmentVersion,
      firstSubmittedAt: sebApplication.firstSubmittedAt,
      submissionNumber: sebApplicationSubmission.submissionNumber,
      submittedAt: sebApplicationSubmission.submittedAt,
      statusChangedAt: sebApplication.statusChangedAt,
      updatedAt: sebApplication.updatedAt,
    })
    .from(sebApplication)
    .innerJoin(sebEnterprise, eq(sebEnterprise.id, sebApplication.enterpriseId))
    .innerJoin(sebProgrammeCycle, eq(sebProgrammeCycle.id, sebApplication.programmeCycleId))
    .innerJoin(
      sebApplicationSubmission,
      and(
        eq(sebApplicationSubmission.applicationId, sebApplication.id),
        sql`NOT EXISTS (
          SELECT 1 FROM ${sebApplicationSubmission} AS newer_submission
          WHERE newer_submission.application_id = ${sebApplication.id}
            AND newer_submission.submission_number > ${sebApplicationSubmission.submissionNumber}
        )`,
      ),
    )
    .innerJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplication.id),
        eq(sebApplicationVersion.version, sebApplicationSubmission.applicationVersion),
      ),
    )
    .where(and(filters, cursor))
    .orderBy(
      descending ? desc(timestampColumn) : asc(timestampColumn),
      descending ? desc(sebApplication.id) : asc(sebApplication.id),
    )
    .limit(input.first + 1)
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)
  /*
   * The same joins as the page, because the filters reach into all of them —
   * the sector and category live on the submitted version, the search reaches
   * the enterprise name, and the submitted-between range is on the submission.
   */
  const [total] = await db
    .select({ value: count() })
    .from(sebApplication)
    .innerJoin(sebEnterprise, eq(sebEnterprise.id, sebApplication.enterpriseId))
    .innerJoin(
      sebApplicationSubmission,
      and(
        eq(sebApplicationSubmission.applicationId, sebApplication.id),
        sql`NOT EXISTS (
          SELECT 1 FROM ${sebApplicationSubmission} AS newer_submission
          WHERE newer_submission.application_id = ${sebApplication.id}
            AND newer_submission.submission_number > ${sebApplicationSubmission.submissionNumber}
        )`,
      ),
    )
    .innerJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplication.id),
        eq(sebApplicationVersion.version, sebApplicationSubmission.applicationVersion),
      ),
    )
    .where(filters)
  return {
    nodes: selected,
    pageInfo: {
      hasNextPage: rows.length > input.first,
      totalCount: requireInvariant(total, COUNT_MISSING).value,
      endCursor: last ? encodeAdminCursor(
        sortKey,
        sortKey === 'submittedAt'
          ? last.submittedAt
          : sortKey === 'updatedAt' ? last.updatedAt : last.statusChangedAt,
        last.id,
      ) : null,
    },
  }
}

/**
 * Counts the applications waiting in each named queue.
 *
 * One grouped aggregate rather than one query per queue. The two `SUBMITTED`
 * queues are separated by the same submission-number rule the list uses, so a
 * chip count can never disagree with the queue it opens.
 */
export const intakeQueueSummary = async (
  db: Database,
  cycleId?: string | null,
): Promise<Array<{ queue: IntakeQueueKey; count: number }>> => {
  const rows = await db
    .select({
      status: sebApplication.status,
      submissionNumber: sebApplicationSubmission.submissionNumber,
      count: sql<number>`count(*)`,
    })
    .from(sebApplication)
    .innerJoin(
      sebApplicationSubmission,
      and(
        eq(sebApplicationSubmission.applicationId, sebApplication.id),
        sql`NOT EXISTS (
          SELECT 1 FROM ${sebApplicationSubmission} AS newer_submission
          WHERE newer_submission.application_id = ${sebApplication.id}
            AND newer_submission.submission_number > ${sebApplicationSubmission.submissionNumber}
        )`,
      ),
    )
    .where(
      and(
        isNull(sebApplication.deletedAt),
        sql`${sebApplication.status} <> 'DRAFT'`,
        cycleId ? eq(sebApplication.programmeCycleId, cycleId) : undefined,
      ),
    )
    .groupBy(sebApplication.status, sebApplicationSubmission.submissionNumber)

  // Every queue is reported, including empty ones, so the caller renders a
  // stable set of chips instead of one that appears and disappears.
  const counts = new Map<IntakeQueueKey, number>(
    intakeQueueKeys.map((queue) => [queue, 0]),
  )
  for (const row of rows) {
    const queue: IntakeQueueKey | undefined = row.status === 'SUBMITTED'
      ? (row.submissionNumber === 1 ? 'NEW_SUBMISSIONS' : 'REVISION_RESPONSES')
      : intakeQueueKeys.find((key) => key === row.status)
    // CANCELLED has no queue: it is a terminal state nobody works from.
    if (!queue) continue
    // Seeded above, so every queue key is already present.
    counts.set(queue, counts.get(queue)! + Number(row.count))
  }
  return intakeQueueKeys.map((queue) => ({ queue, count: counts.get(queue)! }))
}

export const loadWorkspace = async (db: Database, applicationId: string) => {
  const head = await loadApplicationHead(db, applicationId)
  if (!head || head.application.status === 'DRAFT') return null
  const [submissions, documents, revisions, timeline, assignments, notes, reviews,
    reviewChecks, referrals, bankOutcomeRows, agenda, decisions, awards, releases,
    assessments, recoveries] = await Promise.all([
    db.select().from(sebApplicationSubmission)
      .where(eq(sebApplicationSubmission.applicationId, applicationId))
      .orderBy(asc(sebApplicationSubmission.submissionNumber)),
    db.select({
      pin: sebApplicationSubmissionDocument,
      file: sebApplicationDocumentVersion,
    }).from(sebApplicationSubmissionDocument)
      .innerJoin(
        sebApplicationDocumentVersion,
        and(
          eq(sebApplicationDocumentVersion.documentId, sebApplicationSubmissionDocument.documentId),
          eq(sebApplicationDocumentVersion.version, sebApplicationSubmissionDocument.documentVersion),
        ),
      )
      .where(eq(sebApplicationSubmissionDocument.applicationId, applicationId)),
    db.select().from(sebRevisionRequest)
      .where(eq(sebRevisionRequest.applicationId, applicationId))
      .orderBy(asc(sebRevisionRequest.requestedAt)),
    db.select().from(sebApplicationEvent)
      .where(eq(sebApplicationEvent.applicationId, applicationId))
      .orderBy(desc(sebApplicationEvent.createdAt))
      .limit(MAX_COLLECTION_ROWS),
    db.select().from(sebApplicationAssignmentEvent)
      .where(eq(sebApplicationAssignmentEvent.applicationId, applicationId))
      .orderBy(desc(sebApplicationAssignmentEvent.assignmentVersion))
      .limit(MAX_COLLECTION_ROWS),
    db.select().from(sebApplicationInternalNote)
      .where(eq(sebApplicationInternalNote.applicationId, applicationId))
      .orderBy(desc(sebApplicationInternalNote.createdAt))
      .limit(MAX_COLLECTION_ROWS),
    db.select().from(sebDeskReview)
      .where(eq(sebDeskReview.applicationId, applicationId))
      .orderBy(asc(sebDeskReview.reviewedAt)),
    db.select({ check: sebDeskReviewCheck, reviewApplicationId: sebDeskReview.applicationId })
      .from(sebDeskReviewCheck)
      .innerJoin(sebDeskReview, eq(sebDeskReview.id, sebDeskReviewCheck.deskReviewId))
      .where(eq(sebDeskReview.applicationId, applicationId)),
    db.select().from(sebPartnerBankReferral)
      .where(eq(sebPartnerBankReferral.applicationId, applicationId))
      .orderBy(asc(sebPartnerBankReferral.createdAt)),
    db.select().from(sebPartnerBankOutcome)
      .where(eq(sebPartnerBankOutcome.applicationId, applicationId))
      .orderBy(asc(sebPartnerBankOutcome.createdAt)),
    db.select().from(sebTtmAgendaItem)
      .where(eq(sebTtmAgendaItem.applicationId, applicationId))
      .orderBy(asc(sebTtmAgendaItem.createdAt)),
    db.select().from(sebTtmDecision)
      .where(eq(sebTtmDecision.applicationId, applicationId))
      .orderBy(asc(sebTtmDecision.createdAt)),
    db.select().from(sebFundingAward)
      .where(eq(sebFundingAward.applicationId, applicationId)),
    db.select({ entry: sebDisbursement, awardApplicationId: sebFundingAward.applicationId })
      .from(sebDisbursement)
      .innerJoin(sebFundingAward, eq(sebFundingAward.id, sebDisbursement.fundingAwardId))
      .where(eq(sebFundingAward.applicationId, applicationId)),
    db.select({ assessment: sebAwardAssessment, awardApplicationId: sebFundingAward.applicationId })
      .from(sebAwardAssessment)
      .innerJoin(sebFundingAward, eq(sebFundingAward.id, sebAwardAssessment.fundingAwardId))
      .where(eq(sebFundingAward.applicationId, applicationId)),
    db.select().from(sebRecoveryCase)
      .where(eq(sebRecoveryCase.applicationId, applicationId)),
  ])
  // A non-draft application can only be produced by a formal submission batch,
  // so at least one submission is a database/service invariant here.
  const snapshots = await db.select().from(sebApplicationVersion).where(and(
    eq(sebApplicationVersion.applicationId, applicationId),
    inArray(
      sebApplicationVersion.version,
      submissions.map((submission) => submission.applicationVersion),
    ),
  )).orderBy(asc(sebApplicationVersion.version))
  const snapshotsByVersion = new Map(snapshots.map((snapshot) => [snapshot.version, snapshot]))
  const submissionChanges = submissions.slice(1).map((submission, index) => {
    const previousSubmission = submissions[index]!
    return {
      fromSubmissionNumber: previousSubmission.submissionNumber,
      toSubmissionNumber: submission.submissionNumber,
      // Shared with the applicant's pre-resubmission review, so staff and
      // applicant can never be shown a different set of changed sections.
      sections: changedSections(
        snapshotsByVersion.get(previousSubmission.applicationVersion)!,
        snapshotsByVersion.get(submission.applicationVersion)!,
      ),
    }
  })
  return {
    ...head,
    submissions,
    snapshots,
    submissionChanges,
    documents,
    revisions,
    /*
     * Read newest-first so the cap keeps the recent end of a long history, then
     * reversed here because the screen reads a file from the top down.
     */
    timeline: [...timeline].reverse(),
    assignments: [...assignments].reverse(),
    internalNotes: [...notes].reverse(),
    reviews,
    reviewChecks,
    referrals,
    bankOutcomes: bankOutcomeRows,
    agenda,
    decisions,
    awards,
    releases,
    assessments,
    recoveries,
  }
}

const assignmentEventInsert = (
  context: AdminOperationContext,
  value: typeof sebApplicationAssignmentEvent.$inferInsert,
  expectedNewVersion: number,
) => context.db.insert(sebApplicationAssignmentEvent).select(sql`
  SELECT ${value.id}, ${value.applicationId}, ${value.eventType},
    ${value.assignmentVersion}, ${value.fromUserId ?? null}, ${value.toUserId ?? null},
    ${value.reasonCategoryId ?? null}, ${value.reason ?? null},
    ${value.conflictAcknowledged ? 1 : 0}, ${value.actorUserId},
    ${(value.createdAt as Date).getTime()}
  WHERE EXISTS (
    SELECT 1 FROM ${sebApplication}
    WHERE ${sebApplication.id} = ${value.applicationId}
      AND ${sebApplication.assignmentVersion} = ${expectedNewVersion}
  )
`)

export const changeAssignment = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    actorUserId: string
    expectedVersion: number
    fromUserId: string | null
    toUserId: string | null
    eventType: 'CLAIMED' | 'RELEASED' | 'REASSIGNED'
    reasonCategoryId?: string | null
    reason?: string | null
    conflictAcknowledged: boolean
    now: Date
  },
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const updated = context.db.update(sebApplication).set({
    assignedToUserId: input.toUserId,
    assignedAt: input.toUserId ? input.now : null,
    assignmentVersion: nextVersion,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.assignmentVersion, input.expectedVersion),
    input.fromUserId === null
      ? isNull(sebApplication.assignedToUserId)
      : eq(sebApplication.assignedToUserId, input.fromUserId),
    isNull(sebApplication.deletedAt),
    sql`${sebApplication.status} <> 'DRAFT'`,
  )).returning({ id: sebApplication.id })
  const event = {
    id: crypto.randomUUID(),
    applicationId: input.applicationId,
    eventType: input.eventType,
    assignmentVersion: nextVersion,
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    reasonCategoryId: input.reasonCategoryId ?? null,
    reason: input.reason ?? null,
    conflictAcknowledged: input.conflictAcknowledged,
    actorUserId: input.actorUserId,
    createdAt: input.now,
  } satisfies typeof sebApplicationAssignmentEvent.$inferInsert
  const [changed] = await context.db.batch([
    updated,
    assignmentEventInsert(context, event, nextVersion),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId},
        ${`SEB.APPLICATION_${input.eventType}`}, 'SEB_APPLICATION',
        ${input.applicationId}, 'SUCCESS', NULL, NULL, NULL, NULL,
        ${JSON.stringify({ assignmentVersion: nextVersion })}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.assignmentVersion} = ${nextVersion}
      )
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const insertInternalNote = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    correctionOfNoteId?: string | null
    note: string
    actorUserId: string
    now: Date
  },
) => {
  const id = crypto.randomUUID()
  const [inserted] = await context.db.batch([
    context.db.insert(sebApplicationInternalNote).select(sql`
      SELECT ${id}, ${input.applicationId}, ${input.correctionOfNoteId ?? null},
        ${input.note}, ${input.actorUserId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.assignedToUserId} = ${input.actorUserId}
          AND ${sebApplication.deletedAt} IS NULL
          AND ${sebApplication.status} <> 'DRAFT'
      )
    `).returning({ id: sebApplicationInternalNote.id }),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.INTERNAL_NOTE_ADDED',
        'SEB_APPLICATION_INTERNAL_NOTE', ${id}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplicationInternalNote}
        WHERE ${sebApplicationInternalNote.id} = ${id}
      )
    `),
  ])
  if (!Array.isArray(inserted) || inserted.length !== 1) return null
  const [row] = await context.db.select().from(sebApplicationInternalNote)
    .where(eq(sebApplicationInternalNote.id, id)).limit(1)
  // The guarded insert returned this exact primary key, so the row cannot be
  // absent without a database violation inside the same request.
  return row!
}

export const startDeskReviewWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    expectedStatusVersion: number
    actorUserId: string
    now: Date
  },
): Promise<boolean> => {
  const nextStatusVersion = input.expectedStatusVersion + 1
  const updated = context.db.update(sebApplication).set({
    status: 'DESK_REVIEW',
    statusVersion: nextStatusVersion,
    statusChangedAt: input.now,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'SUBMITTED'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    eq(sebApplication.assignedToUserId, input.actorUserId),
    isNull(sebApplication.deletedAt),
  )).returning({ id: sebApplication.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'DESK_REVIEW_STARTED',
        ${input.actorUserId}, NULL, NULL, NULL, 'SUBMITTED', 'DESK_REVIEW',
        NULL, 'Desk review started.', NULL, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.statusVersion} = ${nextStatusVersion}
          AND ${sebApplication.status} = 'DESK_REVIEW'
      )
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.DESK_REVIEW_STARTED',
        'SEB_APPLICATION', ${input.applicationId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.statusVersion} = ${nextStatusVersion}
          AND ${sebApplication.status} = 'DESK_REVIEW'
      )
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const unacceptedSubmissionDocumentCount = async (
  db: Database,
  submissionId: string,
): Promise<number> => {
  const [row] = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count
    FROM ${sebApplicationSubmissionDocument} AS pinned
    WHERE pinned.submission_id = ${submissionId}
      AND NOT EXISTS (
        SELECT 1 FROM ${sebApplicationDocumentScan} AS scan
        INNER JOIN ${sebApplicationDocumentVersion} AS file
          ON file.id = scan.document_version_id
        WHERE file.document_id = pinned.document_id
          AND file.version = pinned.document_version
          AND scan.sequence_number = (
            SELECT MAX(latest.sequence_number)
            FROM ${sebApplicationDocumentScan} AS latest
            WHERE latest.document_version_id = file.id
          )
          AND scan.status = 'ACCEPTED'
      )
  `)
  // COUNT always yields one row, including when the count is zero.
  return Number(row!.count)
}

export const completeDeskReviewWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    submissionId: string
    expectedStatusVersion: number
    actorUserId: string
    outcome: DeskReviewOutcome
    checks: DeskReviewCheckInput[]
    reasonCategoryId?: string | null
    applicantMessage?: string | null
    revisions: RevisionRequestInput[]
    now: Date
  },
): Promise<boolean> => {
  const reviewId = crypto.randomUUID()
  const nextStatus = input.outcome === 'ADVANCE_TO_BANK'
    ? 'PARTNER_BANK_EVALUATION'
    : input.outcome === 'REQUEST_REVISION' ? 'REVISION_REQUIRED' : 'REJECTED'
  const nextStatusVersion = input.expectedStatusVersion + 1
  const releasesAssignment = input.outcome === 'REJECT'
  const update = context.db.update(sebApplication).set({
    status: nextStatus,
    statusVersion: nextStatusVersion,
    statusChangedAt: input.now,
    assignedToUserId: releasesAssignment ? null : input.actorUserId,
    assignedAt: releasesAssignment ? null : input.now,
    assignmentVersion: releasesAssignment
      ? sql`${sebApplication.assignmentVersion} + 1`
      : sebApplication.assignmentVersion,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'DESK_REVIEW'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    eq(sebApplication.assignedToUserId, input.actorUserId),
    isNull(sebApplication.deletedAt),
  )).returning({ id: sebApplication.id })
  const statements = [
    update,
    context.db.insert(sebDeskReview).select(sql`
      SELECT ${reviewId}, ${input.applicationId}, ${input.submissionId},
        ${input.outcome}, ${input.reasonCategoryId ?? null},
        ${input.applicantMessage ?? null}, ${input.actorUserId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.statusVersion} = ${nextStatusVersion}
          AND ${sebApplication.status} = ${nextStatus}
      )
    `),
    ...input.checks.map((check) => context.db.insert(sebDeskReviewCheck).select(sql`
      SELECT ${crypto.randomUUID()}, ${reviewId}, ${check.checkType}, ${check.result},
        ${check.internalNote ?? null}, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `)),
    ...input.revisions.map((revision) => context.db.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, ${input.submissionId},
        ${revision.section}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorUserId}, ${input.now.getTime()}, NULL, NULL, NULL, NULL, NULL
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `)),
    ...(releasesAssignment ? [context.db.insert(sebApplicationAssignmentEvent).select(sql`
      SELECT ${crypto.randomUUID()}, application.id, 'RELEASED', application.assignment_version,
        ${input.actorUserId}, NULL, ${input.reasonCategoryId!},
        ${input.applicantMessage!}, 0,
        ${input.actorUserId}, ${input.now.getTime()}
      FROM ${sebApplication} AS application
      WHERE application.id = ${input.applicationId}
        AND application.status_version = ${nextStatusVersion}
        AND application.status = 'REJECTED'
    `)] : []),
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId},
        ${input.outcome === 'ADVANCE_TO_BANK'
          ? 'DESK_REVIEW_COMPLETED'
          : input.outcome === 'REQUEST_REVISION' ? 'REVISION_REQUESTED' : 'APPLICATION_REJECTED'},
        ${input.actorUserId}, NULL, ${input.submissionId}, NULL, 'DESK_REVIEW',
        ${nextStatus}, NULL, ${input.applicantMessage ?? 'Desk review completed.'},
        NULL, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.DESK_REVIEW_COMPLETED',
        'SEB_DESK_REVIEW', ${reviewId}, 'SUCCESS', NULL, NULL, NULL, NULL,
        ${JSON.stringify({ outcome: input.outcome })}, ${input.now.getTime()}
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `),
  ]
  const [changed] = await context.db.batch(
    statements as [typeof statements[number], ...Array<typeof statements[number]>],
  )
  return Array.isArray(changed) && changed.length === 1
}

export const approvedReason = async (
  db: Database,
  input: { id: string; cycleId: string; version: number; context: string },
) => {
  const [row] = await db.select().from(sebProgrammeCycleReason).where(and(
    eq(sebProgrammeCycleReason.id, input.id),
    eq(sebProgrammeCycleReason.programmeCycleId, input.cycleId),
    eq(sebProgrammeCycleReason.programmeCycleVersion, input.version),
    sql`${sebProgrammeCycleReason.context} = ${input.context}`,
  )).limit(1)
  return row ?? null
}

export const cancelRevisionRequestWrite = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    revisionRequestId: string
    expectedStatusVersion: number
    actorUserId: string
    reason: string
    now: Date
  },
): Promise<boolean> => {
  const nextStatusVersion = input.expectedStatusVersion + 1
  const cancel = context.db.update(sebRevisionRequest).set({
    cancelledAt: input.now,
    cancelledByUserId: input.actorUserId,
    cancellationReason: input.reason,
  }).where(and(
    eq(sebRevisionRequest.id, input.revisionRequestId),
    eq(sebRevisionRequest.applicationId, input.applicationId),
    isNull(sebRevisionRequest.resolvedAt),
    isNull(sebRevisionRequest.cancelledAt),
    sql`EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.applicationId}
        AND ${sebApplication.status} = 'REVISION_REQUIRED'
        AND ${sebApplication.statusVersion} = ${input.expectedStatusVersion}
        AND ${sebApplication.assignedToUserId} = ${input.actorUserId}
    )`,
  )).returning({ id: sebRevisionRequest.id })
  const returnToReview = context.db.update(sebApplication).set({
    status: 'DESK_REVIEW',
    statusVersion: nextStatusVersion,
    statusChangedAt: input.now,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'REVISION_REQUIRED'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    eq(sebApplication.assignedToUserId, input.actorUserId),
    sql`EXISTS (
      SELECT 1 FROM ${sebRevisionRequest}
      WHERE ${sebRevisionRequest.id} = ${input.revisionRequestId}
        AND ${sebRevisionRequest.cancelledAt} = ${input.now.getTime()}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebRevisionRequest}
      WHERE ${sebRevisionRequest.applicationId} = ${input.applicationId}
        AND ${sebRevisionRequest.resolvedAt} IS NULL
        AND ${sebRevisionRequest.cancelledAt} IS NULL
    )`,
  )).returning({ id: sebApplication.id })
  const [cancelled] = await context.db.batch([
    cancel,
    returnToReview,
    context.db.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'REVISION_CANCELLED',
        ${input.actorUserId}, NULL, NULL, ${input.revisionRequestId},
        'REVISION_REQUIRED',
        CASE WHEN EXISTS (
          SELECT 1 FROM ${sebApplication}
          WHERE ${sebApplication.id} = ${input.applicationId}
            AND ${sebApplication.statusVersion} = ${nextStatusVersion}
        ) THEN 'DESK_REVIEW' ELSE 'REVISION_REQUIRED' END,
        NULL, 'A mistaken revision request was cancelled.', NULL, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRevisionRequest}
        WHERE ${sebRevisionRequest.id} = ${input.revisionRequestId}
          AND ${sebRevisionRequest.cancelledAt} = ${input.now.getTime()}
      )
    `),
  ])
  return Array.isArray(cancelled) && cancelled.length === 1
}

export const acceptedPinnedDocument = async (
  db: Database,
  input: { applicationId: string; submissionDocumentId: string },
) => {
  const [row] = await db
    .select({ pin: sebApplicationSubmissionDocument, file: sebApplicationDocumentVersion })
    .from(sebApplicationSubmissionDocument)
    .innerJoin(
      sebApplicationDocumentVersion,
      and(
        eq(sebApplicationDocumentVersion.documentId, sebApplicationSubmissionDocument.documentId),
        eq(sebApplicationDocumentVersion.version, sebApplicationSubmissionDocument.documentVersion),
      ),
    )
    .where(and(
      eq(sebApplicationSubmissionDocument.id, input.submissionDocumentId),
      eq(sebApplicationSubmissionDocument.applicationId, input.applicationId),
      sql`EXISTS (
        SELECT 1 FROM ${sebApplicationDocumentScan} AS scan
        WHERE scan.document_version_id = ${sebApplicationDocumentVersion.id}
          AND scan.sequence_number = (
            SELECT MAX(latest.sequence_number)
            FROM ${sebApplicationDocumentScan} AS latest
            WHERE latest.document_version_id = ${sebApplicationDocumentVersion.id}
          )
          AND scan.status = 'ACCEPTED'
      )`,
    ))
    .limit(1)
  return row ?? null
}
