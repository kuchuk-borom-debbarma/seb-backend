/**
 * Guarded persistence for queues, assignment, notes, and desk review.
 *
 * Every transition begins with an optimistic update and makes the append-only
 * evidence depend on the resulting version, so a concurrent winner leaves no
 * partial review, identifier, revision request, timeline entry, or audit row.
 *
 * The queue reads seek on a cursor that names its own sort column, because
 * deriving that column separately on the encode and decode sides once let a
 * cursor seek the wrong column and return a wrong page with no error.
 */
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
  ne,
  or,
  sql,
  lt,
  lte,
  type SQL,
} from 'drizzle-orm'
import type { PgSelect } from 'drizzle-orm/pg-core'
import { COUNT_MISSING, requireInvariant } from '../../application/support'

/** A submitted application without a reference number cannot happen. */
const REFERENCE_MISSING = 'A reviewed application has no reference number.'
import { batch, type Database, type Transaction } from '../../../db'
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
  sebApplicationVersionAnswer,
  sebDeskReview,
  sebDeskReviewIdentifier,
  sebDeskReviewCheck,
  sebEnterprise,
  sebEnterpriseVersion,
  sebPartnerBankOutcome,
  sebPartnerBankReferral,
  sebProgrammeCycle,
  sebProgrammeCycleIdentifierRule,
  sebProgrammeCycleReason,
  sebRecoveryCase,
  sebRevisionRequest,
  sebProgrammeDecision,
  sebFundingAward,
  sebDisbursement,
  sebAwardAssessment,
} from '../../../db/schema'
import { roleAnswerText } from '../../application/queries/answer-sql'
import { findPinnedRulesForApplication } from '../../application/queries/form-template'
import { changedStageKeys } from '../../application/form/answers'
import type { AnswerMap } from '../../application/form/types'
import {
  answersByVersion,
  findAnswerRows,
  findPinnedCycleRules,
} from '../../application/queries/form-template'
import { MAX_COLLECTION_ROWS } from '../../application/pagination'
import { encodeAdminCursor, type SortKey } from '../pagination'
import { prefixMatchAny, prefixPattern } from '../../search'
import { adminAudit, disclosedSelfReview, headJustMovedTo } from '../support'
import { intakeQueueKeys } from '../types'
import type { IdentifierKind } from '../identifiers'
import type {
  AdminOperationContext,
  DeskReviewCheckInput,
  IdentifierRule,
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
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
    .innerJoin(sebProgrammeCycle, eq(sebProgrammeCycle.id, sebApplication.programmeCycleId))
    .where(eq(sebApplication.id, id))
    .limit(1)
  return row ?? null
}

/**
 * The amount this submission asked for, read from the answer it was given in.
 *
 * Resolved here, once, rather than at the three places that bound a decision by
 * it. The path is a literal because a role-bound field must use its canonical
 * key — that constraint exists precisely so code which is not template-aware,
 * like the amount a decision is bounded by, can still find its input across
 * every cycle.
 *
 * Read as text and parsed in JavaScript rather than cast in SQL: a `::bigint`
 * on a column that is text by design raises on any non-numeric row, turning a
 * corrupt answer into a failed read of the whole submission instead of one
 * refusal the officer can act on.
 */
export const requestedAmountText = roleAnswerText('SEED_FUND_REQUESTED_PAISE')

export const latestSubmission = async (db: Database, applicationId: string) => {
  const [row] = await db
    .select({
      submission: sebApplicationSubmission,
      snapshot: sebApplicationVersion,
      requestedAmountText,
    })
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
  if (!row) return null
  const parsed = Number(row.requestedAmountText)
  return {
    ...row,
    /** Null when unanswered or unreadable; the caller refuses rather than guessing. */
    requestedAmountPaise:
      row.requestedAmountText !== null && Number.isSafeInteger(parsed) && parsed > 0
        ? parsed
        : null,
  }
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

/**
 * Every filter the queue accepts, shared verbatim with the analytics summary.
 *
 * The plural fields supersede their singular counterparts when given: a caller
 * migrating one filter at a time must never have `category` and `categories`
 * silently intersected into an empty page. An empty list is treated as absent
 * — "no filter", not "a filter matching nothing".
 */
export type IntakeQueueFilterInput = {
  cycleId?: string | null
  cycleIds?: readonly string[] | null
  status?: typeof sebApplication.$inferSelect.status | null
  statuses?: readonly (typeof sebApplication.$inferSelect.status)[] | null
  queue?: IntakeQueueKey | null
  phaseNumber?: number | null
  applicationType?: typeof sebApplication.$inferSelect.applicationType | null
  assigneeUserId?: string | null
  referenceNumber?: string | null
  search?: string | null
  sector?: typeof sebEnterpriseVersion.$inferSelect.businessSector | null
  sectors?: readonly NonNullable<typeof sebEnterpriseVersion.$inferSelect.businessSector>[] | null
  category?: typeof sebApplicationVersion.$inferSelect.applicationCategory | null
  categories?: readonly NonNullable<typeof sebApplicationVersion.$inferSelect.applicationCategory>[] | null
  districts?: readonly NonNullable<typeof sebEnterpriseVersion.$inferSelect.businessDistrict>[] | null
  registrationTypes?: readonly (typeof sebEnterpriseVersion.$inferSelect.registrationType)[] | null
  submittedFrom?: Date | null
  submittedTo?: Date | null
  requestedMinPaise?: number | null
  requestedMaxPaise?: number | null
  decidedFrom?: Date | null
  decidedTo?: Date | null
}

/**
 * A predicate on the requested amount, guarded against corrupt answers.
 *
 * The answer column is text by design, so the comparison must cast — and a
 * bare `::bigint` raises on any non-numeric row, turning one corrupt answer
 * into a failed read of the whole queue. The regex keeps the cast off those
 * rows: they simply never match an amount bound, which is the honest answer
 * for a value that is not an amount.
 */
const requestedAtLeast = (bound: number, comparator: '>=' | '<='): SQL => sql`(
  ${requestedAmountText} ~ '^[0-9]+$'
  AND (${requestedAmountText})::bigint ${sql.raw(comparator)} ${bound}
)`

/**
 * The queue's whole WHERE clause, from one filter set.
 *
 * One function rather than a block repeated in the page, the count and the
 * analytics summary: the summary must describe exactly the set the queue
 * lists, and two spellings of the same filter is how they would drift apart
 * with right-looking results and no error.
 */
export const intakeQueueFilters = (input: IntakeQueueFilterInput): SQL | undefined => {
  const pattern = prefixPattern(input.search)
  /*
   * "Decided between" means at least one recorded decision in the range. The
   * decision's own timestamp, because a correction appends a second row: the
   * application was decided at both moments, and either belongs to a report
   * about that period. Probes `seb_programme_decision_application_idx`
   * (application_id, created_at), so no new index is needed for it.
   */
  const decided = input.decidedFrom || input.decidedTo
    ? sql`EXISTS (
        SELECT 1 FROM ${sebProgrammeDecision}
        WHERE ${and(
          eq(sebProgrammeDecision.applicationId, sebApplication.id),
          input.decidedFrom
            ? gte(sebProgrammeDecision.createdAt, input.decidedFrom) : undefined,
          input.decidedTo
            ? lte(sebProgrammeDecision.createdAt, input.decidedTo) : undefined,
        )}
      )`
    : undefined
  return and(
    isNull(sebApplication.deletedAt),
    sql`${sebApplication.status} <> 'DRAFT'`,
    ...headFilters(input, pattern),
    ...enterpriseFilters(input),
    input.categories?.length
      ? inArray(sebApplicationVersion.applicationCategory, [...input.categories])
      : input.category
        ? eq(sebApplicationVersion.applicationCategory, input.category) : undefined,
    input.submittedFrom
      ? gte(sebApplicationSubmission.submittedAt, input.submittedFrom) : undefined,
    input.submittedTo
      ? lte(sebApplicationSubmission.submittedAt, input.submittedTo) : undefined,
    // Inclusive at both ends: a bound equal to the answer still matches it.
    input.requestedMinPaise != null
      ? requestedAtLeast(input.requestedMinPaise, '>=') : undefined,
    input.requestedMaxPaise != null
      ? requestedAtLeast(input.requestedMaxPaise, '<=') : undefined,
    decided,
  )
}

/* The application-head dimensions. A plural filter supersedes its singular. */
const headFilters = (
  input: IntakeQueueFilterInput,
  pattern: ReturnType<typeof prefixPattern>,
): (SQL | undefined)[] => [
  input.cycleIds?.length
    ? inArray(sebApplication.programmeCycleId, [...input.cycleIds])
    : input.cycleId ? eq(sebApplication.programmeCycleId, input.cycleId) : undefined,
  input.statuses?.length
    ? inArray(sebApplication.status, [...input.statuses])
    : input.status ? eq(sebApplication.status, input.status) : undefined,
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
]

/*
 * Sector, district and registration type are read live from the enterprise
 * (like the name above); none of them are answers since the enterprise
 * section left the form.
 */
const enterpriseFilters = (input: IntakeQueueFilterInput): (SQL | undefined)[] => [
  input.sectors?.length
    ? inArray(sebEnterpriseVersion.businessSector, [...input.sectors])
    : input.sector ? eq(sebEnterpriseVersion.businessSector, input.sector) : undefined,
  input.districts?.length
    ? inArray(sebEnterpriseVersion.businessDistrict, [...input.districts])
    : undefined,
  input.registrationTypes?.length
    ? inArray(sebEnterpriseVersion.registrationType, [...input.registrationTypes])
    : undefined,
]

/**
 * The joins every filtered intake read stands on.
 *
 * Shared because the filters reach into all of them — the sector and the
 * district live on the enterprise's current version, the category on the
 * frozen submitted version, the search on the enterprise name and the
 * submitted-between range on the newest submission. The page, its count and
 * every analytics grouping must stand on the same rows or their totals
 * disagree.
 */
export const joinIntakeQueueTables = <T extends PgSelect>(query: T): T =>
  query
    .innerJoin(sebEnterprise, eq(sebEnterprise.id, sebApplication.enterpriseId))
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
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
      /*
       * Joins refine a builder's row type with the joined tables' nullability,
       * so the return type is not literally `T` and the cast has to say so.
       * Every caller names its columns explicitly in `select(...)`, and every
       * join here is inner — so nothing a caller selected changed shape.
       */
    ) as unknown as T

export const listIntakeQueue = async (
  db: Database,
  input: IntakeQueueFilterInput & {
    first: number
    after: { timestamp: Date; id: string } | null
    order?: 'OLDEST_WAITING' | 'NEWEST_SUBMISSION' | 'LAST_ACTIVITY' | null
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
  const filters = intakeQueueFilters(input)
  const rows = await joinIntakeQueueTables(db
    .select({
      id: sebApplication.id,
      referenceNumber: sebApplication.referenceNumber,
      enterpriseId: sebApplication.enterpriseId,
      enterpriseName: sebEnterprise.currentName,
      applicantUserId: sebApplication.applicantUserId,
      programmeCycleId: sebApplication.programmeCycleId,
      cycleCode: sebProgrammeCycle.cycleCode,
      sector: sebEnterpriseVersion.businessSector,
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
    .$dynamic())
    .where(and(filters, cursor))
    .orderBy(
      descending ? desc(timestampColumn) : asc(timestampColumn),
      descending ? desc(sebApplication.id) : asc(sebApplication.id),
    )
    .limit(input.first + 1)
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)
  // The same joins as the page: the filters reach into all of them.
  const [total] = await joinIntakeQueueTables(
    db.select({ value: count() }).from(sebApplication).$dynamic(),
  ).where(filters)
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
  /*
   * The form this application was filled against.
   *
   * The workspace needs it for the same reason the applicant's own screens do:
   * every stage and field on this page is named by the cycle, not by the
   * software. A reviewer choosing which stages to reopen must be choosing from
   * this application's own — the API refuses any other, so offering a fixed list
   * would offer refusals.
   */
  const rules = await findPinnedRulesForApplication(
    db, applicationId, head.application.currentVersion,
  )
  const [submissions, documents, revisions, timeline, assignments, notes, reviews,
    reviewChecks, referrals, bankOutcomeRows, decisions, awards, releases,
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
    db.select().from(sebProgrammeDecision)
      .where(eq(sebProgrammeDecision.applicationId, applicationId))
      .orderBy(asc(sebProgrammeDecision.createdAt)),
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
  /*
   * The identifier rules the newest submission was frozen against.
   *
   * This is a third round trip rather than a member of either batch above, and
   * it has to be: the frozen cycle *version* is recorded on the snapshot, not
   * on the application, so it is not known until the snapshots have loaded.
   * Reading the cycle's current rules instead would be one call cheaper and
   * wrong — editing a cycle would retroactively change what an already
   * submitted application is judged by, which is the property the freezing
   * exists to provide.
   *
   * It is a single-table read against the composite primary key.
   *
   * Both lookups are total rather than defensive: a draft returned above, so
   * anything reaching here has been submitted at least once, and the snapshots
   * were selected for exactly these submissions' versions.
   */
  const frozenSnapshot = snapshotsByVersion.get(
    submissions[submissions.length - 1]!.applicationVersion,
  )!
  const identifierRules = await findIdentifierRules(
    db, frozenSnapshot.programmeCycleId, frozenSnapshot.programmeCycleVersion,
  )
  /*
   * The approved reasons of the same frozen cycle version. Read here, keyed by
   * the snapshot's version, because `approvedReason` validates reason ids
   * against exactly this version — a picker built from the cycle's *current*
   * version would offer ids that stop validating the moment the cycle is
   * revised, since a revision re-mints every reason row with a fresh id.
   */
  const reasons = await db.select().from(sebProgrammeCycleReason).where(and(
    eq(sebProgrammeCycleReason.programmeCycleId, frozenSnapshot.programmeCycleId),
    eq(
      sebProgrammeCycleReason.programmeCycleVersion,
      frozenSnapshot.programmeCycleVersion,
    ),
  )).orderBy(asc(sebProgrammeCycleReason.context), asc(sebProgrammeCycleReason.code))
  /*
   * The answers each submission froze, and the form they were given against.
   *
   * Read here for the same reason the identifier rules are: the cycle version
   * is on the snapshot rather than on the application, so it is not known until
   * the snapshots have loaded.
   *
   * Grouped by version before anything reads them. Folding rows from several
   * submissions into one map would merge them — every value plausible, nothing
   * thrown — which is exactly what `answersByVersion` exists to make
   * impossible to express.
   */
  const pinnedRules = await findPinnedCycleRules(
    db, frozenSnapshot.programmeCycleId, frozenSnapshot.programmeCycleVersion,
  )
  const answersByVersionId = pinnedRules
    ? answersByVersion(
        pinnedRules.template,
        await findAnswerRows(db, snapshots.map((snapshot) => snapshot.id)),
      )
    : new Map<string, AnswerMap>()
  const answersOf = (version: number): AnswerMap =>
    answersByVersionId.get(snapshotsByVersion.get(version)?.id ?? '') ?? {}

  const submissionChanges = pinnedRules
    ? submissions.slice(1).map((submission, index) => {
        const previousSubmission = submissions[index]!
        return {
          fromSubmissionNumber: previousSubmission.submissionNumber,
          toSubmissionNumber: submission.submissionNumber,
          // Shared with the applicant's pre-resubmission review, so staff and
          // applicant can never be shown a different set of changed stages.
          stageKeys: changedStageKeys(
            pinnedRules.template,
            answersOf(previousSubmission.applicationVersion),
            answersOf(submission.applicationVersion),
          ),
        }
      })
    : []
  /*
   * The whole journey of this funding case, oldest first. Lean on purpose —
   * a reviewer needs to place the attempt, not to open its siblings here.
   */
  const caseHistory = await db
    .select({
      id: sebApplication.id,
      referenceNumber: sebApplication.referenceNumber,
      applicationType: sebApplication.applicationType,
      phaseNumber: sebApplication.phaseNumber,
      status: sebApplication.status,
      cycleCode: sebProgrammeCycle.cycleCode,
      createdAt: sebApplication.createdAt,
    })
    .from(sebApplication)
    .innerJoin(
      sebProgrammeCycle,
      eq(sebProgrammeCycle.id, sebApplication.programmeCycleId),
    )
    .where(
      and(
        eq(sebApplication.fundingCaseId, head.application.fundingCaseId),
        isNull(sebApplication.deletedAt),
      ),
    )
    .orderBy(asc(sebApplication.createdAt))

  return {
    ...head,
    caseHistory,
    submissions,
    /*
     * Each frozen version, carrying what was answered against it. Without the
     * answers a reviewer is shown the labels, the evidence and the dates and
     * nothing the applicant wrote — which is most of what a desk review is.
     */
    snapshots: snapshots.map((snapshot) => ({
      ...snapshot,
      answers: answersByVersionId.get(snapshot.id) ?? {},
    })),
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
    identifierRules,
    reasons,
    formTemplate: rules?.template ?? null,
    referrals,
    bankOutcomes: bankOutcomeRows,
    decisions,
    awards,
    releases,
    assessments,
    recoveries,
  }
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
  const [inserted] = await batch(context.db, (tx) => [
    tx.insert(sebApplicationInternalNote).select(sql`
      SELECT ${id}, ${input.applicationId}, ${input.correctionOfNoteId ?? null},
        ${input.note}, ${input.actorUserId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.deletedAt} IS NULL
          AND ${sebApplication.status} <> 'DRAFT'
      )
    `).returning({ id: sebApplicationInternalNote.id }),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.INTERNAL_NOTE_ADDED',
        'SEB_APPLICATION_INTERNAL_NOTE', ${id}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now}
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
    /*
     * Starting the review is what records who is working the file. It is not a
     * lock — anybody with the capability may still act — but it is the first
     * moment there is anything true to say, and the workspace shows it so a
     * second officer can decide whether to duplicate the effort.
     *
     * Without this the record would only be written when a review *completes*,
     * leaving it empty for the whole period it is actually useful.
     */
    assignedToUserId: input.actorUserId,
    assignedAt: input.now,
    assignmentVersion: sql`${sebApplication.assignmentVersion} + 1`,
    updatedAt: input.now,
  }).where(and(
    eq(sebApplication.id, input.applicationId),
    eq(sebApplication.status, 'SUBMITTED'),
    eq(sebApplication.statusVersion, input.expectedStatusVersion),
    isNull(sebApplication.deletedAt),
  )).returning({ id: sebApplication.id })
  const [changed] = await batch(context.db, (tx) => [
    updated,
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'DESK_REVIEW_STARTED',
        ${input.actorUserId}, NULL, NULL, NULL, 'SUBMITTED', 'DESK_REVIEW',
        NULL, 'Desk review started.', NULL, ${input.now}
      WHERE ${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.DESK_REVIEW_STARTED',
        'SEB_APPLICATION', ${input.applicationId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now}
      WHERE ${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const unacceptedSubmissionDocumentCount = async (
  db: Database,
  submissionId: string,
): Promise<number> => {
  const { rows } = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
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
  return Number(rows[0]!.count)
}

/**
 * Which of these values have already been recorded against a different case.
 *
 * One indexed seek per identifier rather than a join walked from the review
 * side: this runs on every completed desk review, and the index is
 * `(kind, comparable_value, funding_case_id)` precisely so the answer is a
 * range lookup on a key that starts with what is being asked.
 *
 * The matching application's reference comes back with it, because a reviewer
 * cannot judge whether a match is a legitimate second phase or a duplicate
 * attempt without being able to go and look. Staff can already see every
 * application in the queue, so this discloses nothing new.
 */
export const identifierMatches = async (
  db: Database,
  fundingCaseId: string,
  candidates: { kind: IdentifierKind; comparableValue: string }[],
): Promise<Map<IdentifierKind, string>> => {
  /*
   * Asked together rather than one after another. The questions are independent
   * and this sits in the middle of completing a review, so four sequential
   * round trips would be three waits nobody needs. Order is preserved, so the
   * refusal still names whichever identifier the reviewer listed first.
   */
  const rows = await Promise.all(candidates.map((candidate) => db
    .select({ referenceNumber: sebApplication.referenceNumber })
    .from(sebDeskReviewIdentifier)
    .innerJoin(sebDeskReview, eq(sebDeskReview.id, sebDeskReviewIdentifier.deskReviewId))
    .innerJoin(sebApplication, eq(sebApplication.id, sebDeskReview.applicationId))
    .where(and(
      eq(sebDeskReviewIdentifier.kind, candidate.kind),
      eq(sebDeskReviewIdentifier.comparableValue, candidate.comparableValue),
      ne(sebDeskReviewIdentifier.fundingCaseId, fundingCaseId),
    ))
    .orderBy(desc(sebDeskReviewIdentifier.createdAt))
    .limit(1)))

  const found = new Map<IdentifierKind, string>()
  rows.forEach(([row], index) => {
    /*
     * A desk review only exists for a submitted application, and submission is
     * what issues the reference number — so a match always has one. Asserted
     * rather than defaulted, because a quiet fallback would hide a broken
     * invariant behind a plausible-looking message.
     */
    if (row) {
      found.set(
        candidates[index]!.kind,
        requireInvariant(row.referenceNumber, REFERENCE_MISSING),
      )
    }
  })
  return found
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
    identifiers: {
      kind: IdentifierKind
      comparableValue: string
      lastFour: string
      matchedReason: string | null
    }[]
    fundingCaseId: string
    /** True only where the reviewer is the applicant and said so. */
    conflictAcknowledged?: boolean | null
    now: Date
  },
): Promise<boolean> => {
  const reviewId = crypto.randomUUID()
  // Both the stored value and a term in the audit guard below. Read from the
  // application rather than from the caller — see `disclosedSelfReview`.
  const disclosed = disclosedSelfReview(
    input.applicationId, input.actorUserId, input.conflictAcknowledged,
  )
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
    isNull(sebApplication.deletedAt),
  )).returning({ id: sebApplication.id })
  const statements = (tx: Transaction) => [
    update,
    tx.insert(sebDeskReview).select(sql`
      SELECT ${reviewId}, ${input.applicationId}, ${input.submissionId},
        ${input.outcome}, ${input.reasonCategoryId ?? null},
        ${input.applicantMessage ?? null}, ${input.actorUserId}, ${input.now},
        ${disclosed}
      WHERE ${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}
    `),
    ...input.checks.map((check) => tx.insert(sebDeskReviewCheck).select(sql`
      SELECT ${crypto.randomUUID()}, ${reviewId}, ${check.checkType}, ${check.result},
        ${check.internalNote ?? null}, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `)),
    ...input.identifiers.map((identifier) => tx.insert(sebDeskReviewIdentifier).select(sql`
      SELECT ${crypto.randomUUID()}, ${reviewId}, ${input.fundingCaseId},
        ${identifier.kind}, ${identifier.comparableValue}, ${identifier.lastFour},
        ${identifier.matchedReason}, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `)),
    ...input.revisions.map((revision) => tx.insert(sebRevisionRequest).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, ${input.submissionId},
        ${revision.stageKey}, ${revision.reasonCategoryId}, ${revision.note},
        ${input.actorUserId}, ${input.now}, NULL, NULL, NULL, NULL, NULL
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `)),
    ...(releasesAssignment ? [tx.insert(sebApplicationAssignmentEvent).select(sql`
      SELECT ${crypto.randomUUID()}, application.id, 'RELEASED', application.assignment_version,
        ${input.actorUserId}, NULL, ${input.reasonCategoryId!},
        ${input.applicantMessage!},
        ${input.actorUserId}, ${input.now}
      FROM ${sebApplication} AS application
      WHERE application.id = ${input.applicationId}
        AND application.status = 'REJECTED'
        AND ${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)}
    `)] : []),
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId},
        ${input.outcome === 'ADVANCE_TO_BANK'
          ? 'DESK_REVIEW_COMPLETED'
          : input.outcome === 'REQUEST_REVISION' ? 'REVISION_REQUESTED' : 'APPLICATION_REJECTED'},
        ${input.actorUserId}, NULL, ${input.submissionId}, NULL, 'DESK_REVIEW',
        ${nextStatus}, NULL, ${input.applicantMessage ?? 'Desk review completed.'},
        NULL, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.DESK_REVIEW_COMPLETED',
        'SEB_DESK_REVIEW', ${reviewId}, 'SUCCESS', NULL, NULL, NULL, NULL,
        ${JSON.stringify({ outcome: input.outcome })}, ${input.now}
      WHERE EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `),
    /*
     * Its own action, and only where there was something to disclose — the
     * `disclosed` term is what makes an ordinary review write nothing here.
     * The column on the review is the record; this is what makes "every file
     * decided by its own applicant" a query on `action` rather than a join of
     * actor against applicant across every decided application.
     */
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.SELF_REVIEW_DISCLOSED',
        'SEB_DESK_REVIEW', ${reviewId}, 'SUCCESS', NULL, NULL, NULL, NULL,
        NULL, ${input.now}
      WHERE ${disclosed}
        AND EXISTS (SELECT 1 FROM ${sebDeskReview} WHERE ${sebDeskReview.id} = ${reviewId})
    `),
  ]
  const [changed] = await batch(context.db, statements)
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
    sql`EXISTS (
      SELECT 1 FROM ${sebRevisionRequest}
      WHERE ${sebRevisionRequest.id} = ${input.revisionRequestId}
        AND ${sebRevisionRequest.cancelledAt} = ${input.now}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sebRevisionRequest}
      WHERE ${sebRevisionRequest.applicationId} = ${input.applicationId}
        AND ${sebRevisionRequest.resolvedAt} IS NULL
        AND ${sebRevisionRequest.cancelledAt} IS NULL
    )`,
  )).returning({ id: sebApplication.id })
  const [cancelled] = await batch(context.db, (tx) => [
    cancel,
    returnToReview,
    tx.insert(sebApplicationEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.applicationId}, 'REVISION_CANCELLED',
        ${input.actorUserId}, NULL, NULL, ${input.revisionRequestId},
        'REVISION_REQUIRED',
        CASE WHEN ${headJustMovedTo(input.applicationId, nextStatusVersion, input.now)} THEN 'DESK_REVIEW' ELSE 'REVISION_REQUIRED' END,
        NULL, 'A mistaken revision request was cancelled.', NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRevisionRequest}
        WHERE ${sebRevisionRequest.id} = ${input.revisionRequestId}
          AND ${sebRevisionRequest.cancelledAt} = ${input.now}
      )
    `),
    /*
     * The applicant-facing event above says what happened to the application;
     * this says who did it. Withdrawing a correction request is the one
     * administrative act here that leaves the application exactly as it was, so
     * without this it left no trace of the officer at all.
     */
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, 'SEB.REVISION_CANCELLED',
        'SEB_APPLICATION', ${input.applicationId}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebRevisionRequest}
        WHERE ${sebRevisionRequest.id} = ${input.revisionRequestId}
          AND ${sebRevisionRequest.cancelledAt} = ${input.now}
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

/**
 * The identifier rules frozen into one cycle version.
 *
 * Its own read rather than part of `findSubmissionPolicy`, which is the
 * applicant-side submission policy and is not consulted on this path — folding
 * a reviewer's rules into an applicant's type would have bought nothing and
 * mixed two audiences.
 *
 * One statement, and a small one: at most four rows, seeked on the composite
 * key that freezes them to the version.
 */
export const findIdentifierRules = async (
  db: Database,
  cycleId: string,
  cycleVersion: number,
): Promise<IdentifierRule[]> =>
  db
    .select({
      kind: sebProgrammeCycleIdentifierRule.kind,
      requirement: sebProgrammeCycleIdentifierRule.requirement,
      duplicatePolicy: sebProgrammeCycleIdentifierRule.duplicatePolicy,
      checkType: sebProgrammeCycleIdentifierRule.checkType,
    })
    .from(sebProgrammeCycleIdentifierRule)
    .where(and(
      eq(sebProgrammeCycleIdentifierRule.programmeCycleId, cycleId),
      eq(sebProgrammeCycleIdentifierRule.programmeCycleVersion, cycleVersion),
    ))
