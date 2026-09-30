/**
 * The office-wide list of submitted applications, one application's workspace,
 * its documents, and staff-only notes.
 *
 * Moving a file between stages is the pipeline's and lives in
 * `services/pipeline`; this is the read side every stage shares.
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
  or,
  sql,
  lt,
  lte,
  type SQL,
} from 'drizzle-orm'
import type { PgSelect } from 'drizzle-orm/pg-core'
import { COUNT_MISSING, requireInvariant } from '../../application/support'

import { batch, recordFromJsonb, type Database } from '../../../db'
import {
  sebApplication,
  sebApplicationDocumentScan,
  sebApplicationDocumentVersion,
  sebApplicationEvent,
  sebApplicationInternalNote,
  sebApplicationSubmission,
  sebApplicationSubmissionDocument,
  sebApplicationVersion,
  sebApplicationVersionAnswer,
  sebEnterprise,
  sebEnterpriseVersion,
  sebProgrammeCycle,
  sebRevisionRequest,
} from '../../../db/schema'
import { roleAnswerText } from '../../application/queries/answer-sql'
import type { PinnedFormReader } from '../../application/queries/form-template'
import { changedStageKeys, pinnedFilesOf } from '../../application/form/answers'
import type { AnswerMap } from '../../application/form/types'
import {
  answersByVersion,
} from '../../application/queries/form-template'
import { MAX_COLLECTION_ROWS } from '../../application/pagination'
import { encodeAdminCursor, type SortKey } from '../pagination'
import { prefixMatchAny, prefixPattern } from '../../search'
import { insertAuditEventWhere } from '../../audit-event'
import { adminAudit } from '../support'
import { readScopeFilter, type ReadScope } from '../../pipeline/queries/stage-scope'
import type { AdminOperationContext, PageInfo } from '../types'

/**
 * One application's head, with its enterprise and cycle — or null when it
 * does not exist or lies outside `scope`. The scope is part of the `WHERE`,
 * so the two refusals cannot be told apart.
 */
export const loadApplicationHead = async (db: Database, id: string, scope: ReadScope) => {
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
    .where(and(eq(sebApplication.id, id), readScopeFilter(scope)))
    .limit(1)
  return row ?? null
}

/**
 * The grant amount a submission asked for, read from the answer it was given
 * in — the queue's amount filters and the analytics totals both read it.
 *
 * The path is a literal because a role-bound field must use its canonical key:
 * that constraint exists so code which is not template-aware can still find
 * the amount across every cycle. A cycle that asks no grant has no such answer,
 * and its applications simply never match an amount bound.
 */
export const requestedAmountText = roleAnswerText('SEED_FUND_REQUESTED_PAISE')

/** The loan amount a submission asked for, by the same canonical-key rule. */
const loanAmountText = roleAnswerText('LOAN_REQUESTED_PAISE')

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
  phaseNumber?: number | null
  applicationKind?: string | null
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
  loanRequestedMinPaise?: number | null
  loanRequestedMaxPaise?: number | null
  /** Only applications worked in this pipeline. */
  pipelineId?: string | null
  /** Only applications at any of these stages; given with `pipelineId`. */
  stageKeys?: readonly string[] | null
  /** Only applications holding **every** one of these status flags. */
  flags?: readonly string[] | null
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
/** A stored amount as a number, or null when it is absent or not a whole number of paise. */
const amountOf = (amount: SQL): SQL<number | null> =>
  sql<number | null>`CASE WHEN ${amount} ~ '^[0-9]+$' THEN (${amount})::bigint END`.mapWith(
    (value: string | number | null) => (value === null ? null : Number(value)),
  )

const amountBound = (amount: SQL, bound: number, comparator: '>=' | '<='): SQL => sql`(
  ${amount} ~ '^[0-9]+$'
  AND (${amount})::bigint ${sql.raw(comparator)} ${bound}
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
      ? amountBound(requestedAmountText, input.requestedMinPaise, '>=') : undefined,
    input.requestedMaxPaise != null
      ? amountBound(requestedAmountText, input.requestedMaxPaise, '<=') : undefined,
    input.loanRequestedMinPaise != null
      ? amountBound(loanAmountText, input.loanRequestedMinPaise, '>=') : undefined,
    input.loanRequestedMaxPaise != null
      ? amountBound(loanAmountText, input.loanRequestedMaxPaise, '<=') : undefined,
    ...pipelineFilters(input),
  )
}

/*
 * Where the file is in its pipeline. Flags are containment on the array, which
 * is the GIN index's question; a stage is equality on the stage-queue index's
 * leading columns.
 */
const pipelineFilters = (input: IntakeQueueFilterInput): (SQL | undefined)[] => [
  input.pipelineId ? eq(sebApplication.pipelineId, input.pipelineId) : undefined,
  input.stageKeys?.length
    ? inArray(sebApplication.currentStageKey, [...input.stageKeys])
    : undefined,
  input.flags?.length
    ? sql`${sebApplication.statusFlags} @> ARRAY[${sql.join(input.flags.map((flag) => sql`${flag}`), sql`, `)}]::text[]`
    : undefined,
]

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
  input.phaseNumber ? eq(sebApplication.phaseNumber, input.phaseNumber) : undefined,
  input.applicationKind
    ? eq(sebApplication.applicationKind, input.applicationKind)
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
    /** Who is reading; office-wide when absent. Applied to the page and its count alike. */
    scope?: ReadScope
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
  const filters = and(intakeQueueFilters(input), readScopeFilter(input.scope ?? { kind: 'OFFICE' }))
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
      applicationKind: sebApplication.applicationKind,
      status: sebApplication.status,
      statusVersion: sebApplication.statusVersion,
      pipelineId: sebApplication.pipelineId,
      pipelineVersion: sebApplication.pipelineVersion,
      currentStageKey: sebApplication.currentStageKey,
      stageEnteredAt: sebApplication.stageEnteredAt,
      statusFlags: sebApplication.statusFlags,
      firstSubmittedAt: sebApplication.firstSubmittedAt,
      submissionNumber: sebApplicationSubmission.submissionNumber,
      submittedAt: sebApplicationSubmission.submittedAt,
      statusChangedAt: sebApplication.statusChangedAt,
      updatedAt: sebApplication.updatedAt,
      // What was asked for, from the submitted version's role-bound answers —
      // the same expressions the range filters compare, so a row shows the
      // amount it was filtered on. Null when the form did not ask.
      requestedGrantPaise: amountOf(requestedAmountText),
      requestedLoanPaise: amountOf(loanAmountText),
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

type JsonRow = Record<string, unknown>

/**
 * Everything the workspace shows about one application beyond its head, in one
 * statement: submissions, the files each froze, revision requests, the
 * timeline, internal notes, the submitted versions with their answers, the
 * funding case's other attempts, and the cycle version the current version is
 * pinned to.
 *
 * These were eleven statements, one after another, on the page an officer
 * opens most. Each collection is its own correlated aggregate — never a join
 * across them, which would multiply rows — and each row comes back whole as
 * `to_jsonb`, mapped to its record by `recordFromJsonb`, so a column added to
 * a table arrives here without this having to learn it.
 */
const findWorkspaceCollections = async (db: Database, applicationId: string) => {
  const result = await db.execute<{
    pinnedCycleVersion: number | null
    submissions: JsonRow[]
    documents: Array<{ pin: JsonRow; file: JsonRow }>
    revisions: JsonRow[]
    timeline: JsonRow[]
    notes: JsonRow[]
    snapshots: JsonRow[]
    answerRows: Array<{ applicationVersionId: string; fieldKey: string; entryIndex: number; valueOrdinal: number; valueText: string }>
    caseHistory: Array<Omit<CaseHistoryEntry, 'createdAt'> & { createdAt: string }>
  }>(sql`
    WITH head AS (
      SELECT id, current_version, funding_case_id FROM ${sebApplication} WHERE id = ${applicationId}
    ),
    submitted AS (
      SELECT s.* FROM ${sebApplicationSubmission} s WHERE s.application_id = ${applicationId}
    ),
    snapshot AS (
      SELECT v.* FROM ${sebApplicationVersion} v
      WHERE v.application_id = ${applicationId}
        AND v.version IN (SELECT application_version FROM submitted)
    )
    SELECT
      (SELECT v.programme_cycle_version FROM ${sebApplicationVersion} v, head
        WHERE v.application_id = head.id AND v.version = head.current_version) AS "pinnedCycleVersion",
      COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.submission_number) FROM submitted s), '[]'::jsonb)
        AS "submissions",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('pin', to_jsonb(p), 'file', to_jsonb(f)))
        FROM ${sebApplicationSubmissionDocument} p
        JOIN ${sebApplicationDocumentVersion} f
          ON f.document_id = p.document_id AND f.version = p.document_version
        WHERE p.application_id = ${applicationId}
      ), '[]'::jsonb) AS "documents",
      COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at)
        FROM ${sebRevisionRequest} r WHERE r.application_id = ${applicationId}
      ), '[]'::jsonb) AS "revisions",
      -- Newest first, so the cap keeps the recent end of a long history.
      COALESCE((
        SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC)
        FROM (
          SELECT * FROM ${sebApplicationEvent} WHERE application_id = ${applicationId}
          ORDER BY created_at DESC LIMIT ${MAX_COLLECTION_ROWS}
        ) e
      ), '[]'::jsonb) AS "timeline",
      COALESCE((
        SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC)
        FROM (
          SELECT * FROM ${sebApplicationInternalNote} WHERE application_id = ${applicationId}
          ORDER BY created_at DESC LIMIT ${MAX_COLLECTION_ROWS}
        ) n
      ), '[]'::jsonb) AS "notes",
      COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.version) FROM snapshot v), '[]'::jsonb)
        AS "snapshots",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'applicationVersionId', a.application_version_id, 'fieldKey', a.field_key,
          'entryIndex', a.entry_index, 'valueOrdinal', a.value_ordinal, 'valueText', a.value_text
        ))
        FROM ${sebApplicationVersionAnswer} a
        WHERE a.application_version_id IN (SELECT id FROM snapshot)
      ), '[]'::jsonb) AS "answerRows",
      -- The whole journey of this funding case, oldest first.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', c.id, 'referenceNumber', c.reference_number,
          'applicationKind', c.application_kind, 'phaseNumber', c.phase_number,
          'status', c.status, 'statusFlags', to_jsonb(c.status_flags),
          'cycleCode', pc.cycle_code, 'createdAt', c.created_at
        ) ORDER BY c.created_at)
        FROM ${sebApplication} c
        JOIN ${sebProgrammeCycle} pc ON pc.id = c.programme_cycle_id
        WHERE c.funding_case_id = (SELECT funding_case_id FROM head)
          AND c.deleted_at IS NULL
      ), '[]'::jsonb) AS "caseHistory"
  `)
  const row = result.rows[0]!
  return {
    pinnedCycleVersion: row.pinnedCycleVersion,
    submissions: row.submissions.map((each) => recordFromJsonb(sebApplicationSubmission, each)),
    documents: row.documents.map((each) => ({
      pin: recordFromJsonb(sebApplicationSubmissionDocument, each.pin),
      file: recordFromJsonb(sebApplicationDocumentVersion, each.file),
    })),
    revisions: row.revisions.map((each) => recordFromJsonb(sebRevisionRequest, each)),
    timeline: row.timeline.map((each) => recordFromJsonb(sebApplicationEvent, each)),
    notes: row.notes.map((each) => recordFromJsonb(sebApplicationInternalNote, each)),
    snapshots: row.snapshots.map((each) => recordFromJsonb(sebApplicationVersion, each)),
    answerRows: row.answerRows,
    caseHistory: row.caseHistory.map((each) => ({ ...each, createdAt: new Date(each.createdAt) })),
  }
}

type CaseHistoryEntry = {
  id: string
  referenceNumber: string | null
  applicationKind: string
  phaseNumber: number
  status: typeof sebApplication.$inferSelect['status']
  statusFlags: string[]
  cycleCode: string
  createdAt: Date
}

/**
 * An officer's file: four round trips — the session, the head (which decides
 * whether this reader may see it at all), everything else about it in one
 * statement, and the pinned form, which the request's reader serves twice for
 * the price of once when the latest submission shares the head's version.
 */
export const loadWorkspace = async (
  db: Database,
  readForm: PinnedFormReader,
  applicationId: string,
  scope: ReadScope,
) => {
  const head = await loadApplicationHead(db, applicationId, scope)
  if (!head || head.application.status === 'DRAFT') return null
  const {
    pinnedCycleVersion, submissions, documents, revisions, timeline, notes, snapshots, answerRows, caseHistory,
  } = await findWorkspaceCollections(db, applicationId)
  /*
   * The form this application was filled against.
   *
   * The workspace needs it for the same reason the applicant's own screens do:
   * every stage and field on this page is named by the cycle, not by the
   * software. A reviewer choosing which stages to reopen must be choosing from
   * this application's own — the API refuses any other, so offering a fixed list
   * would offer refusals.
   */
  const rules = pinnedCycleVersion === null
    ? null
    : await readForm(head.application.programmeCycleId, pinnedCycleVersion)
  const snapshotsByVersion = new Map(snapshots.map((snapshot) => [snapshot.version, snapshot]))
  // A draft returned above, so anything here was submitted at least once, and
  // the snapshots were selected for exactly these submissions' versions.
  const frozenSnapshot = snapshotsByVersion.get(
    submissions[submissions.length - 1]!.applicationVersion,
  )!
  /*
   * The answers each submission froze, read against the form they were given
   * against — recorded on the snapshot, not the application. Reading the
   * cycle's current form instead would be wrong: editing a cycle would change
   * what an already submitted application is read against.
   *
   * Grouped by version before anything reads them. Folding rows from several
   * submissions into one map would merge them — every value plausible, nothing
   * thrown — which is exactly what `answersByVersion` exists to make
   * impossible to express.
   */
  const pinnedRules = await readForm(frozenSnapshot.programmeCycleId, frozenSnapshot.programmeCycleVersion)
  const answersByVersionId = pinnedRules
    ? answersByVersion(pinnedRules.template, answerRows)
    : new Map<string, AnswerMap>()
  const answersOf = (version: number): AnswerMap =>
    answersByVersionId.get(snapshotsByVersion.get(version)?.id ?? '') ?? {}

  // The files each submission froze, so a replaced document counts as a change.
  const filesOf = (submissionId: string) =>
    pinnedFilesOf(
      documents.filter((row) => row.pin.submissionId === submissionId).map((row) => row.pin),
    )
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
            { previous: filesOf(previousSubmission.id), next: filesOf(submission.id) },
          ),
        }
      })
    : []

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
    // Read newest-first for the cap, and reversed because the screen reads a
    // file from the top down.
    timeline: [...timeline].reverse(),
    internalNotes: [...notes].reverse(),
    formTemplate: rules?.template ?? null,
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
    /** Who is writing: a note may be added only to a file its author may read. */
    scope: ReadScope
  },
) => {
  const id = crypto.randomUUID()
  const readable = readScopeFilter(input.scope)
  const [inserted] = await batch(context.db, (tx) => [
    tx.insert(sebApplicationInternalNote).select(sql`
      SELECT ${id}, ${input.applicationId}, ${input.correctionOfNoteId ?? null},
        ${input.note}, ${input.actorUserId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.id} = ${input.applicationId}
          AND ${sebApplication.deletedAt} IS NULL
          AND ${sebApplication.status} <> 'DRAFT'
          ${readable ? sql`AND ${readable}` : sql``}
      )
    `).returning({ id: sebApplicationInternalNote.id }),
    // The note's text is office-only and is not copied into the history.
    insertAuditEventWhere(tx, adminAudit(context, {
      actorUserId: input.actorUserId,
      action: 'SEB.INTERNAL_NOTE_ADDED',
      entityType: 'SEB_APPLICATION_INTERNAL_NOTE',
      entityId: id,
      applicationId: input.applicationId,
      now: input.now,
      payload: { correctionOfNoteId: input.correctionOfNoteId ?? undefined },
    }), sql`EXISTS (
      SELECT 1 FROM ${sebApplicationInternalNote}
      WHERE ${sebApplicationInternalNote.id} = ${id}
    )`),
  ])
  if (!Array.isArray(inserted) || inserted.length !== 1) return null
  const [row] = await context.db.select().from(sebApplicationInternalNote)
    .where(eq(sebApplicationInternalNote.id, id)).limit(1)
  // The guarded insert returned this exact primary key, so the row cannot be
  // absent without a database violation inside the same request.
  return row!
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
