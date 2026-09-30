/**
 * Drizzle persistence for application heads, immutable snapshots, submissions,
 * revision requests, and applicant-visible timeline events.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { batch, changedExactlyOne, type Database, type Executor } from '../../../db'
import {
  coreAuditEvent,
  coreUser,
  sebApplication,
  sebApplicationDocument,
  sebApplicationSubmissionDocument,
  sebApplicationDocumentVersion,
  sebApplicationEvent,
  sebApplicationSubmission,
  sebApplicationVersion,
  sebApplicationVersionAnswer,
  sebCyclePolicyDocument,
  sebCyclePolicyDocumentScan,
  sebCyclePolicyDocumentVersion,
  sebEnterprise,
  sebEnterpriseVersion,
  sebFundingCase,
  sebProgrammeCycle,
  sebApplicationStageAction,
  sebPipeline,
  sebPipelineVersion,
  sebPipelineVersionStage,
  sebProgrammeCycleApplicationKind,
  sebProgrammeCycleApplicationKindRule,
  sebProgrammeCycleEvent,
  sebProgrammeCycleVersion,
  sebRevisionRequest,
} from '../../../db/schema'
import type { EligibilityHistory, EligibilityRule } from '../eligibility'
import type { EligibilityRuleType } from '../../catalogue/workflow.generated'
import { auditEventCteMember, insertAuditEventWhere } from '../../audit-event'
import { MAX_COLLECTION_ROWS } from '../pagination'
import { changedStageKeys, pinnedFilesOf } from '../form/answers'
import {
  answersByVersion,
  answersFromRows,
  answersToRows,
  findAnswerRows,
  findPinnedCycleRules,
  type PinnedCycleRules,
  type PinnedFormReader,
  type AnswerRow,
  type StoredAnswerRow,
} from './form-template'
import { encodeCursor } from '../pagination'
import { prefixMatch, prefixPattern } from '../../search'
import {
  COUNT_MISSING,
  requireInvariant,
  sqlNullable,
  type AuditRecord,
} from '../support'
import type { AnswerMap, AnswerValue } from '../form/types'
import type {
  Application,
  ApplicationDocument,
  ApplicationSection,
  ApplicationSnapshot,
  ApplicationStatus,
  ApplicationSummary,
  Connection,
  DocumentType,
  ProgrammeCycle,
  RevisionRequest,
  TimelineEvent,
} from '../types'
import {
  type SubmissionPolicy,
} from '../validation'

export type ApplicationHeadRecord = typeof sebApplication.$inferSelect
export type ApplicationVersionRecord = typeof sebApplicationVersion.$inferSelect
type ProgrammeCycleRecord = typeof sebProgrammeCycle.$inferSelect
type ApplicationMutationHead = Pick<
  ApplicationHeadRecord,
  | 'id'
  | 'fundingCaseId'
  | 'programmeCycleId'
  | 'applicationKind'
  | 'phaseNumber'
  | 'currentVersion'
  | 'statusVersion'
  | 'status'
  | 'referenceNumber'
  | 'firstSubmittedAt'
>

/**
 * One definition of an open policy window for reads and guarded writes.
 * Missing bounds mean unbounded; a closing instant is exclusive, matching the
 * applicant-visible cycle query and avoiding a one-millisecond ambiguity.
 */
const programmeCycleOpenAt = (now: Date): SQL => sql`
  ${sebProgrammeCycle.status} = 'OPEN'
  AND ${sebProgrammeCycle.deletedAt} IS NULL
  AND (${sebProgrammeCycle.opensAt} IS NULL
    OR ${sebProgrammeCycle.opensAt} <= ${now})
  AND (${sebProgrammeCycle.closesAt} IS NULL
    OR ${sebProgrammeCycle.closesAt} > ${now})
`

/**
 * One stored version, as the rest of the service sees it.
 *
 * The envelope — which version, which cycle it is pinned to, why it exists —
 * plus the facts the server owns. **The answers are not here**: they live one
 * row each and are read against the pinned template, because which questions
 * exist is a cycle's decision and no longer the schema's.
 *
 * A caller that needs the answers asks for them explicitly. That is deliberate:
 * a list of applications must not load a template and an answer set per row,
 * and making the answers a separate read is what stops that happening by
 * accident.
 */
/**
 * One stored version, as a person reads it.
 *
 * The answers are passed in rather than read here because they live in their
 * own rows and every caller has already loaded them — the applicant's screen
 * for the current version, the office's for every submitted one. Making this
 * fetch them would turn one query into one per snapshot.
 */
const snapshotFromRecord = (
  record: ApplicationVersionRecord,
  answers: AnswerMap,
): ApplicationSnapshot => ({
  answers,
  version: record.version,
  programmeCycleVersion: record.programmeCycleVersion,
  applicationKind: record.applicationKind,
  phaseNumber: record.phaseNumber,
  changeType: record.changeType,
  createdAt: record.createdAt,
  declarationAcceptedAt: record.declarationAcceptedAt,
  applicationCategory: record.applicationCategory,
})

const applicationBase = (head: ApplicationHeadRecord) => ({
  id: head.id,
  enterpriseId: head.enterpriseId,
  fundingCaseId: head.fundingCaseId,
  programmeCycleId: head.programmeCycleId,
  applicationKind: head.applicationKind,
  phaseNumber: head.phaseNumber,
  referenceNumber: head.referenceNumber,
  currentVersion: head.currentVersion,
  status: head.status,
  statusVersion: head.statusVersion,
  currentStageKey: head.currentStageKey,
  statusFlags: head.statusFlags,
  pipelineId: head.pipelineId,
  pipelineVersion: head.pipelineVersion,
  recordedValues: head.recordedValues as Record<string, AnswerValue>,
  firstSubmittedAt: head.firstSubmittedAt,
  createdAt: head.createdAt,
  updatedAt: head.updatedAt,
  deletedAt: head.deletedAt,
})

/**
 * The head alone, by id, for the signed confirmation link — which carries no
 * session and no owner, only a signature over this exact id.
 */
export const findApplicationHeadById = async (
  db: Database,
  applicationId: string,
): Promise<ApplicationHeadRecord | null> => {
  const [head] = await db
    .select()
    .from(sebApplication)
    .where(and(eq(sebApplication.id, applicationId), isNull(sebApplication.deletedAt)))
    .limit(1)
  return head ?? null
}

export const findOwnedApplicationHead = async (
  db: Database,
  userId: string,
  applicationId: string,
  includeDeleted = false,
): Promise<ApplicationHeadRecord | null> => {
  const [head] = await db
    .select()
    .from(sebApplication)
    .where(
      and(
        eq(sebApplication.id, applicationId),
        eq(sebApplication.applicantUserId, userId),
        includeDeleted ? undefined : isNull(sebApplication.deletedAt),
      ),
    )
    .limit(1)
  return head ?? null
}

/**
 * The head, with the cycle version its current version is pinned to — what a
 * caller needs to read the pinned form, in one statement rather than the head
 * and then the version. `null` pin only for a head whose current version is
 * missing, which is an invariant failure the caller reports.
 */
export const findOwnedApplicationHeadAndPin = async (
  db: Database,
  userId: string,
  applicationId: string,
): Promise<{ head: ApplicationHeadRecord; pinnedCycleVersion: number | null } | null> => {
  const [row] = await db
    .select({ head: sebApplication, pinnedCycleVersion: sebApplicationVersion.programmeCycleVersion })
    .from(sebApplication)
    .leftJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplication.id),
        eq(sebApplicationVersion.version, sebApplication.currentVersion),
      ),
    )
    .where(
      and(
        eq(sebApplication.id, applicationId),
        eq(sebApplication.applicantUserId, userId),
        isNull(sebApplication.deletedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

export const findApplicationVersion = async (
  db: Database,
  applicationId: string,
  version: number,
): Promise<ApplicationVersionRecord | null> => {
  const [record] = await db
    .select()
    .from(sebApplicationVersion)
    .where(
      and(
        eq(sebApplicationVersion.applicationId, applicationId),
        eq(sebApplicationVersion.version, version),
      ),
    )
    .limit(1)
  return sqlNullable(record)
}

export const findLatestSubmittedVersion = async (
  db: Database,
  applicationId: string,
): Promise<ApplicationVersionRecord | null> => {
  const [record] = await db
    .select({ version: sebApplicationVersion })
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
  return sqlNullable(record && record.version)
}

export const listOpenRevisionStageKeys = async (
  db: Database,
  applicationId: string,
): Promise<Set<ApplicationSection>> => {
  const rows = await db
    .select({ stageKey: sebRevisionRequest.stageKey })
    .from(sebRevisionRequest)
    .where(
      and(
        eq(sebRevisionRequest.applicationId, applicationId),
        isNull(sebRevisionRequest.resolvedAt),
        isNull(sebRevisionRequest.cancelledAt),
      ),
    )
  return new Set(rows.map((row) => row.stageKey))
}

/**
 * One application as its owner sees it, with everything read to build it.
 *
 * `loadOwnedApplication` answers the screen; this answers a write. A write
 * needs the version record, the pinned form, the answers last submitted (to
 * hold a revision to its scope), the enterprise's establishment date (for
 * validation and the category) and the cycle's name (for the confirmation)
 * — and a load that read them and then returned only the public
 * shape sent every step below it back to the database for them again. Read
 * once, passed down (docs/rules/performance.md, rule 2).
 */
export type LoadedApplication = {
  readonly application: Application
  readonly version: ApplicationVersionRecord
  readonly rules: PinnedCycleRules
  /** The answers the latest submission froze; null before the first. */
  readonly submittedAnswers: AnswerMap | null
  readonly establishmentDate: string | null
  /** How the cycle names itself to an applicant, for the confirmation. */
  readonly cycle: { readonly cycleCode: string; readonly displayName: string }
}

type StoredDocument = Omit<ApplicationDocument, 'createdAt' | 'deletedAt'> & {
  createdAt: string
  deletedAt: string | null
}
type StoredRevisionRequest = Omit<RevisionRequest, 'requestedAt' | 'resolvedAt' | 'cancelledAt'> & {
  requestedAt: string
  resolvedAt: string | null
  cancelledAt: string | null
}

/*
 * A timestamp inside `jsonb` arrives as ISO text under both drivers; the
 * head's own columns are mapped to `Date` by Drizzle.
 */
const optionalDate = (value: string | null): Date | null => (value === null ? null : new Date(value))

/** The version the latest submission froze, for the subqueries below. */
const latestSubmittedVersionId = sql`(
  SELECT sv.id
  FROM ${sebApplicationSubmission} sub
  JOIN ${sebApplicationVersion} sv
    ON sv.application_id = sub.application_id AND sv.version = sub.application_version
  WHERE sub.application_id = ${sebApplication.id}
  ORDER BY sub.submission_number DESC
  LIMIT 1
)`

/** Every answer row of one version, as `answersFromRows` reads them. */
const answerRowsOf = (versionId: SQL) => sql`COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'applicationVersionId', a.application_version_id, 'fieldKey', a.field_key,
    'entryIndex', a.entry_index, 'valueOrdinal', a.value_ordinal, 'valueText', a.value_text
  ))
  FROM ${sebApplicationVersionAnswer} a
  WHERE a.application_version_id = ${versionId}
), '[]'::jsonb)`

/**
 * The whole application in one statement: the head and its current version
 * as typed rows, and each collection as its own correlated aggregate — never
 * a join, which would multiply documents by revision requests by answers.
 */
const findOwnedApplicationAggregate = async (
  db: Database,
  userId: string,
  applicationId: string,
  includeDeleted: boolean,
) => {
  const [row] = await db
    .select({
      head: sebApplication,
      version: sebApplicationVersion,
      documents: sql<StoredDocument[]>`COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', d.id, 'fieldKey', d.field_key, 'currentVersion', d.current_version,
          'originalFilename', dv.original_filename, 'contentType', dv.content_type,
          'sizeBytes', dv.size_bytes, 'createdAt', d.created_at, 'deletedAt', d.deleted_at
        ) ORDER BY d.field_key)
        FROM ${sebApplicationDocument} d
        JOIN ${sebApplicationDocumentVersion} dv
          ON dv.document_id = d.id AND dv.version = d.current_version
        WHERE d.application_id = ${sebApplication.id}
      ), '[]'::jsonb)`,
      revisionRequests: sql<StoredRevisionRequest[]>`COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', r.id, 'stageKey', r.stage_key, 'note', r.note, 'requestedAt', r.requested_at,
          'resolvedAt', r.resolved_at, 'cancelledAt', r.cancelled_at
        ) ORDER BY r.requested_at)
        FROM ${sebRevisionRequest} r
        WHERE r.application_id = ${sebApplication.id}
      ), '[]'::jsonb)`,
      answerRows: sql<StoredAnswerRow[]>`${answerRowsOf(sql`${sebApplicationVersion.id}`)}`,
      submittedVersionId: sql<string | null>`${latestSubmittedVersionId}`,
      submittedAnswerRows: sql<StoredAnswerRow[]>`${answerRowsOf(latestSubmittedVersionId)}`,
      // As text: a bare `date` is a string under one driver and a Date under
      // the other.
      establishmentDate: sql<string | null>`(
        SELECT ev.establishment_date::text
        FROM ${sebEnterprise} e
        JOIN ${sebEnterpriseVersion} ev ON ev.enterprise_id = e.id AND ev.version = e.current_version
        WHERE e.id = ${sebApplication.enterpriseId}
      )`,
      cycleCode: sebProgrammeCycle.cycleCode,
      cycleDisplayName: sebProgrammeCycle.displayName,
    })
    .from(sebApplication)
    .innerJoin(sebProgrammeCycle, eq(sebProgrammeCycle.id, sebApplication.programmeCycleId))
    .leftJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplication.id),
        eq(sebApplicationVersion.version, sebApplication.currentVersion),
      ),
    )
    .where(
      and(
        eq(sebApplication.id, applicationId),
        eq(sebApplication.applicantUserId, userId),
        includeDeleted ? undefined : isNull(sebApplication.deletedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * One application as its owner sees it, answers included, and what was read
 * to build it.
 *
 * Two statements: the application, then its pinned form through `readForm`,
 * which a request memoises, so any later step that needs the form reads
 * nothing. The template is resolved here rather than by the caller because
 * three things on the application are derived from it — the answers, the
 * stages that may be edited, and therefore what the client is allowed to draw
 * — and they have to agree. A template that will not resolve is an invariant
 * failure rather than an empty form: the answers exist and would silently read
 * as unanswered.
 */
export const loadOwnedApplicationContext = async (
  db: Database,
  readForm: PinnedFormReader,
  userId: string,
  applicationId: string,
  includeDeleted = false,
): Promise<LoadedApplication | null> => {
  const row = await findOwnedApplicationAggregate(db, userId, applicationId, includeDeleted)
  if (!row) return null
  const current = requireInvariant(row.version, 'Application current version is missing.')
  const rules = requireInvariant(
    await readForm(current.programmeCycleId, current.programmeCycleVersion),
    'The form this application was filled against could not be read.',
  )
  const answers = answersFromRows(rules.template, current.id, row.answerRows)
  const revisionRequests: RevisionRequest[] = row.revisionRequests.map((request) => ({
    ...request,
    requestedAt: new Date(request.requestedAt),
    resolvedAt: optionalDate(request.resolvedAt),
    cancelledAt: optionalDate(request.cancelledAt),
  }))
  const application: Application = {
    ...applicationBase(row.head),
    // Derived from the revision requests already read rather than another
    // query, and from the same rule `saveApplicationDraft` enforces, so the
    // field can never invite an edit the write path would refuse.
    editableStageKeys: editableStageKeysFor(
      row.head.status,
      revisionRequests,
      rules.template.stages.map((stage) => stage.key),
    ),
    snapshot: snapshotFromRecord(current, answers),
    answers,
    documents: row.documents.map((document) => ({
      ...document,
      createdAt: new Date(document.createdAt),
      deletedAt: optionalDate(document.deletedAt),
    })),
    revisionRequests,
  }
  return {
    application,
    version: current,
    rules,
    submittedAnswers: row.submittedVersionId === null
      ? null
      : answersFromRows(rules.template, row.submittedVersionId, row.submittedAnswerRows),
    establishmentDate: row.establishmentDate,
    cycle: { cycleCode: row.cycleCode, displayName: row.cycleDisplayName },
  }
}

/** One application as its owner sees it, answers included. */
export const loadOwnedApplication = async (
  db: Database,
  readForm: PinnedFormReader,
  userId: string,
  applicationId: string,
  includeDeleted = false,
): Promise<Application | null> =>
  (await loadOwnedApplicationContext(db, readForm, userId, applicationId, includeDeleted))
    ?.application ?? null

/**
 * The application as a write left it, built from what was loaded and what the
 * write decided — never read back.
 *
 * A write already knows every value it changed: the new version number and
 * time it chose, the answers it stored, and whatever its statement returned.
 * Reading the whole application back cost as much as loading it in the first
 * place (docs/rules/performance.md, rule 4).
 *
 * The answers pass through the same rows a read would rebuild them from, so
 * the response is exactly what a reload would return: an unanswered question
 * reads `null`, a blank reads `null`, and a multiple choice is in the form's
 * order.
 *
 * What it cannot see is a change another request made meanwhile to something
 * this write did not touch — a document attached a moment ago. The next read
 * shows it; nothing is decided on this response.
 */
export const applicationAfterWrite = (
  loaded: LoadedApplication,
  change: {
    /** Head fields the write changed. */
    head: Partial<Pick<Application,
      | 'currentVersion' | 'statusVersion' | 'status' | 'referenceNumber' | 'firstSubmittedAt'
      | 'currentStageKey' | 'statusFlags' | 'updatedAt' | 'deletedAt'>>
    /** The version the write created, if it created one. */
    version?: Omit<ApplicationSnapshot, 'answers' | 'programmeCycleVersion' | 'applicationKind' | 'phaseNumber'>
      & { answers: AnswerMap }
    revisionRequests?: RevisionRequest[]
  },
): Application => {
  const before = loaded.application
  const template = loaded.rules.template
  const status = change.head.status ?? before.status
  const revisionRequests = change.revisionRequests ?? before.revisionRequests
  const snapshot = change.version
    ? {
      ...before.snapshot,
      ...change.version,
      answers: storedForm(template, change.version.answers),
    }
    : before.snapshot
  return {
    ...before,
    ...change.head,
    snapshot,
    answers: snapshot.answers,
    revisionRequests,
    editableStageKeys: editableStageKeysFor(
      status,
      revisionRequests,
      template.stages.map((stage) => stage.key),
    ),
  }
}

/** Answers as storing and reading them back leaves them. */
const storedForm = (template: PinnedCycleRules['template'], answers: AnswerMap): AnswerMap =>
  answersFromRows(template, 'written', answersToRows(template, answers)
    .map((row) => ({ ...row, applicationVersionId: 'written' })))

/** The stages that open revision requests name — what a correction may change. */
export const openRevisionStageKeys = (application: Pick<Application, 'revisionRequests'>) =>
  new Set(application.revisionRequests
    .filter((request) => request.resolvedAt === null && request.cancelledAt === null)
    .map((request) => request.stageKey))

/** The FILE questions a live document answers. */
export const activeDocumentFieldKeys = (application: Pick<Application, 'documents'>) =>
  new Set(application.documents
    .filter((document) => document.deletedAt === null)
    .map((document) => document.fieldKey))

/**
 * Which form stages the applicant may currently change.
 *
 * A draft is entirely open. Once submitted, only the stages named by open
 * revision requests may change — and only a stage action's REQUEST_REVISION
 * effect opens one, so "revision is required" is a fact about those rows rather
 * than a status of its own.
 */
const editableStageKeysFor = (
  status: ApplicationHeadRecord['status'],
  revisionRequests: ReadonlyArray<RevisionRequest>,
  /*
   * The stages this application's own pinned template declares.
   *
   * "A draft is entirely open" used to mean every member of a global enum; it
   * now means every stage this cycle asks, which is what it should always have
   * meant. It also resolves an inconsistency: the enum contained `EXPANSION`,
   * so a draft advertised it as editable while the controller quietly excluded
   * it — those facts are now the same one.
   */
  templateStageKeys: readonly string[],
): ApplicationSection[] => {
  if (status === 'DRAFT') return [...templateStageKeys]
  const open = new Set(
    revisionRequests
      .filter((request) => request.resolvedAt === null && request.cancelledAt === null)
      .map((request) => request.stageKey),
  )
  return templateStageKeys.filter((stage) => open.has(stage))
}

/**
 * Names the stages the current draft changes relative to the last submission.
 *
 * Returns null when nothing has been submitted yet, because there is nothing to
 * compare against — a first submission changes everything by definition. Uses
 * `changedStageKeys`, the one definition the administrative workspace also
 * reads, so an applicant reviewing their resubmission sees exactly the stages a
 * reviewer will.
 *
 * A template that no longer resolves reports no change rather than throwing:
 * this is a review aid beside the real diff, and a cycle edited by hand must not
 * take the application screen down with it.
 */
export const findDraftChanges = async (
  db: Database,
  readForm: PinnedFormReader,
  head: ApplicationHeadRecord,
): Promise<{ stageKeys: ApplicationSection[]; comparedToSubmissionNumber: number } | null> => {
  const [latest] = await db
    .select({
      id: sebApplicationSubmission.id,
      submissionNumber: sebApplicationSubmission.submissionNumber,
      applicationVersion: sebApplicationSubmission.applicationVersion,
    })
    .from(sebApplicationSubmission)
    .where(eq(sebApplicationSubmission.applicationId, head.id))
    .orderBy(desc(sebApplicationSubmission.submissionNumber))
    .limit(1)
  if (!latest) return null
  const versions = await db
    .select()
    .from(sebApplicationVersion)
    .where(
      and(
        eq(sebApplicationVersion.applicationId, head.id),
        inArray(sebApplicationVersion.version, [latest.applicationVersion, head.currentVersion]),
      ),
    )
  const submitted = versions.find((version) => version.version === latest.applicationVersion)
  const current = versions.find((version) => version.version === head.currentVersion)
  if (!submitted || !current) return null
  const rules = await readForm(current.programmeCycleId, current.programmeCycleVersion)
  if (!rules) {
    return { stageKeys: [], comparedToSubmissionNumber: latest.submissionNumber }
  }
  /*
   * The files the submission froze against the ones attached now, so a
   * replaced document shows as a change here exactly as it will to the office.
   * Read together with the answers: one round trip for all three.
   */
  const [rows, pinned, live] = await Promise.all([
    findAnswerRows(db, [submitted.id, current.id]),
    db
      .select({
        fieldKey: sebApplicationSubmissionDocument.fieldKey,
        documentId: sebApplicationSubmissionDocument.documentId,
        documentVersion: sebApplicationSubmissionDocument.documentVersion,
      })
      .from(sebApplicationSubmissionDocument)
      .where(eq(sebApplicationSubmissionDocument.submissionId, latest.id)),
    db
      .select({
        fieldKey: sebApplicationDocument.fieldKey,
        documentId: sebApplicationDocument.id,
        documentVersion: sebApplicationDocument.currentVersion,
      })
      .from(sebApplicationDocument)
      .where(
        and(
          eq(sebApplicationDocument.applicationId, head.id),
          isNull(sebApplicationDocument.deletedAt),
        ),
      ),
  ])
  const byVersion = answersByVersion(rules.template, rows)
  return {
    stageKeys: changedStageKeys(
      rules.template,
      byVersion.get(submitted.id) ?? {},
      byVersion.get(current.id) ?? {},
      { previous: pinnedFilesOf(pinned), next: pinnedFilesOf(live) },
    ),
    comparedToSubmissionNumber: latest.submissionNumber,
  }
}

export const listOwnedApplications = async (
  db: Database,
  input: {
    userId: string
    first: number
    cursor: { timestamp: Date; id: string } | null
    enterpriseId?: string | null
    status?: ApplicationStatus | null
    programmeCycleId?: string | null
    applicationKind?: string | null
    search?: string | null
    includeDeleted: boolean
  },
): Promise<Connection<ApplicationSummary>> => {
  const cursorPredicate = input.cursor
    ? or(
        gt(sebApplication.updatedAt, input.cursor.timestamp),
        and(
          eq(sebApplication.updatedAt, input.cursor.timestamp),
          gt(sebApplication.id, input.cursor.id),
        ),
      )
    : undefined
  // Without the cursor: the page seeks from a position, the total counts the
  // whole matching set.
  const pattern = prefixPattern(input.search)
  const filters = and(
    eq(sebApplication.applicantUserId, input.userId),
    input.enterpriseId ? eq(sebApplication.enterpriseId, input.enterpriseId) : undefined,
    input.status ? eq(sebApplication.status, input.status) : undefined,
    input.programmeCycleId
      ? eq(sebApplication.programmeCycleId, input.programmeCycleId)
      : undefined,
    input.applicationKind ? eq(sebApplication.applicationKind, input.applicationKind) : undefined,
    pattern ? prefixMatch(sebApplication.referenceNumber, pattern) : undefined,
    input.includeDeleted ? undefined : isNull(sebApplication.deletedAt),
  )
  const rows = await db
    .select({
      head: sebApplication,
      /*
       * Live from the enterprise, not a frozen answer: the business name left
       * the form when the enterprise entity became its single home, and the
       * list should say what the enterprise is called now — the same reasoning
       * as the queue's `currentName`.
       */
      businessName: sebEnterpriseVersion.name,
      cycleCode: sebProgrammeCycle.cycleCode,
      cycleYear: sebProgrammeCycle.cycleYear,
      /*
       * Whether the applicant holds the pen: an open correction request. One
       * probe of the open-stage partial index per row, rather than the whole
       * request list the detail view reads to name the stages.
       */
      awaitingCorrection: sql<boolean>`EXISTS (
        SELECT 1 FROM ${sebRevisionRequest}
        WHERE ${sebRevisionRequest.applicationId} = ${sebApplication.id}
          AND ${sebRevisionRequest.resolvedAt} IS NULL
          AND ${sebRevisionRequest.cancelledAt} IS NULL
      )`,
    })
    .from(sebApplication)
    .innerJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplication.id),
        eq(sebApplicationVersion.version, sebApplication.currentVersion),
      ),
    )
    .innerJoin(sebEnterprise, eq(sebEnterprise.id, sebApplication.enterpriseId))
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
    .innerJoin(sebProgrammeCycle, eq(sebProgrammeCycle.id, sebApplication.programmeCycleId))
    .where(and(filters, cursorPredicate))
    .orderBy(asc(sebApplication.updatedAt), asc(sebApplication.id))
    .limit(input.first + 1)
  const hasNextPage = rows.length > input.first
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)?.head
  const [total] = await db
    .select({ value: count() })
    .from(sebApplication)
    .where(filters)
  return {
    nodes: selected.map((row) => ({
      ...applicationBase(row.head),
      businessName: row.businessName,
      cycleCode: row.cycleCode,
      cycleYear: row.cycleYear,
      awaitingCorrection: row.awaitingCorrection,
    })),
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor('updatedAt', last.updatedAt, last.id) : null,
      totalCount: requireInvariant(total, COUNT_MISSING).value,
    },
  }
}

/**
 * Everything an applicant may see about a cycle. Policy rules stay internal,
 * except the Category A threshold: the category is computed at submission, and
 * telling the applicant which way their establishment date points needs the
 * months it is measured against.
 */
const publicProgrammeCycle = (
  row: typeof sebProgrammeCycle.$inferSelect,
  categoryAMaximumMonths: number | null,
  policyDocument: ProgrammeCycle['policyDocument'],
): ProgrammeCycle => ({
  id: row.id,
  cycleCode: row.cycleCode,
  displayName: row.displayName,
  cycleYear: row.cycleYear,
  policyDocument,
  applicantGuidance: row.applicantGuidance,
  categoryAMaximumMonths,
  status: row.status,
  currentVersion: row.currentVersion,
  opensAt: row.opensAt,
  closesAt: row.closesAt,
})

/**
 * The downloadable policy PDF of each named cycle, keyed by cycle id.
 *
 * Only versions whose *latest* scan verdict is ACCEPTED appear: the applicant
 * surface must never advertise a file the download path will refuse. Absence
 * of any scan reads as pending, the closed direction.
 */
const acceptedPolicyDocuments = async (
  db: Database,
  cycleIds: string[],
): Promise<Map<string, NonNullable<ProgrammeCycle['policyDocument']>>> => {
  if (cycleIds.length === 0) return new Map()
  const rows = await db
    .select({
      cycleId: sebCyclePolicyDocument.programmeCycleId,
      versionId: sebCyclePolicyDocumentVersion.id,
      version: sebCyclePolicyDocumentVersion.version,
      originalFilename: sebCyclePolicyDocumentVersion.originalFilename,
      sizeBytes: sebCyclePolicyDocumentVersion.sizeBytes,
      uploadedAt: sebCyclePolicyDocumentVersion.createdAt,
    })
    .from(sebCyclePolicyDocument)
    .innerJoin(
      sebCyclePolicyDocumentVersion,
      and(
        eq(sebCyclePolicyDocumentVersion.documentId, sebCyclePolicyDocument.id),
        eq(
          sebCyclePolicyDocumentVersion.version,
          sebCyclePolicyDocument.currentVersion,
        ),
      ),
    )
    .where(inArray(sebCyclePolicyDocument.programmeCycleId, cycleIds))
  if (rows.length === 0) return new Map()
  const scans = await db
    .select({
      documentVersionId: sebCyclePolicyDocumentScan.documentVersionId,
      sequenceNumber: sebCyclePolicyDocumentScan.sequenceNumber,
      status: sebCyclePolicyDocumentScan.status,
    })
    .from(sebCyclePolicyDocumentScan)
    .where(inArray(
      sebCyclePolicyDocumentScan.documentVersionId,
      rows.map((row) => row.versionId),
    ))
  const latestByVersion = new Map<string, { sequenceNumber: number; status: string }>()
  for (const scan of scans) {
    const held = latestByVersion.get(scan.documentVersionId)
    if (!held || scan.sequenceNumber > held.sequenceNumber) {
      latestByVersion.set(scan.documentVersionId, scan)
    }
  }
  return new Map(
    rows
      .filter((row) => latestByVersion.get(row.versionId)?.status === 'ACCEPTED')
      .map((row) => [row.cycleId, {
        version: row.version,
        originalFilename: row.originalFilename,
        sizeBytes: row.sizeBytes,
        uploadedAt: row.uploadedAt,
      }]),
  )
}

/**
 * The current policy PDF of one applicant-visible cycle, for download.
 *
 * Returns null for a draft or deleted cycle — an applicant must not learn a
 * cycle exists from its policy file — and for any version whose latest scan
 * verdict is not ACCEPTED.
 */
export const findDownloadablePolicyDocument = async (
  db: Database,
  cycleId: string,
): Promise<{ r2ObjectKey: string; originalFilename: string } | null> => {
  const [row] = await db
    .select({
      versionId: sebCyclePolicyDocumentVersion.id,
      r2ObjectKey: sebCyclePolicyDocumentVersion.r2ObjectKey,
      originalFilename: sebCyclePolicyDocumentVersion.originalFilename,
    })
    .from(sebCyclePolicyDocument)
    .innerJoin(
      sebProgrammeCycle,
      and(
        eq(sebProgrammeCycle.id, sebCyclePolicyDocument.programmeCycleId),
        ne(sebProgrammeCycle.status, 'DRAFT'),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .innerJoin(
      sebCyclePolicyDocumentVersion,
      and(
        eq(sebCyclePolicyDocumentVersion.documentId, sebCyclePolicyDocument.id),
        eq(
          sebCyclePolicyDocumentVersion.version,
          sebCyclePolicyDocument.currentVersion,
        ),
      ),
    )
    .where(eq(sebCyclePolicyDocument.programmeCycleId, cycleId))
    .limit(1)
  if (!row) return null
  const [latestScan] = await db
    .select({ status: sebCyclePolicyDocumentScan.status })
    .from(sebCyclePolicyDocumentScan)
    .where(eq(sebCyclePolicyDocumentScan.documentVersionId, row.versionId))
    .orderBy(desc(sebCyclePolicyDocumentScan.sequenceNumber))
    .limit(1)
  if (latestScan?.status !== 'ACCEPTED') return null
  return { r2ObjectKey: row.r2ObjectKey, originalFilename: row.originalFilename }
}

/** The head's current rule version, where the policy scalars live. */
const currentCycleVersionJoin = and(
  eq(sebProgrammeCycleVersion.programmeCycleId, sebProgrammeCycle.id),
  eq(sebProgrammeCycleVersion.version, sebProgrammeCycle.currentVersion),
)

/** Cycles a new application may be started in right now. */
export const listAvailableProgrammeCycles = async (
  db: Database,
  now: Date,
): Promise<ProgrammeCycle[]> => {
  const rows = await db
    .select({
      cycle: sebProgrammeCycle,
      categoryAMaximumMonths: sebProgrammeCycleVersion.categoryAMaximumMonths,
    })
    .from(sebProgrammeCycle)
    .innerJoin(sebProgrammeCycleVersion, currentCycleVersionJoin)
    .where(programmeCycleOpenAt(now))
    .orderBy(asc(sebProgrammeCycle.opensAt), asc(sebProgrammeCycle.cycleCode))
  const policyDocuments = await acceptedPolicyDocuments(
    db, rows.map((row) => row.cycle.id),
  )
  return rows.map((row) => publicProgrammeCycle(
    row.cycle, row.categoryAMaximumMonths, policyDocuments.get(row.cycle.id) ?? null,
  ))
}

/**
 * Cycles this applicant already has work in, whatever their state.
 *
 * Kept separate from the available list rather than merged with a flag, because
 * the two answer different questions: this one describes history that must
 * render read-only, and the other is the only list a "start application" action
 * may ever be offered from.
 */
export const listApplicantProgrammeCycles = async (
  db: Database,
  userId: string,
): Promise<ProgrammeCycle[]> => {
  const rows = await db
    .selectDistinct({
      cycle: sebProgrammeCycle,
      categoryAMaximumMonths: sebProgrammeCycleVersion.categoryAMaximumMonths,
    })
    .from(sebProgrammeCycle)
    .innerJoin(sebProgrammeCycleVersion, currentCycleVersionJoin)
    .innerJoin(
      sebApplication,
      eq(sebApplication.programmeCycleId, sebProgrammeCycle.id),
    )
    .where(
      and(
        eq(sebApplication.applicantUserId, userId),
        // Scoped to the applications this person can actually still see, and to
        // cycles an administrator has not removed. Without both terms a cycle
        // would appear in their history with nothing in it to look at.
        isNull(sebApplication.deletedAt),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .orderBy(desc(sebProgrammeCycle.cycleYear), asc(sebProgrammeCycle.cycleCode))
  const policyDocuments = await acceptedPolicyDocuments(
    db, rows.map((row) => row.cycle.id),
  )
  return rows.map((row) => publicProgrammeCycle(
    row.cycle, row.categoryAMaximumMonths, policyDocuments.get(row.cycle.id) ?? null,
  ))
}

export const findOpenProgrammeCycle = async (
  db: Database,
  cycleId: string,
  now: Date,
): Promise<ProgrammeCycleRecord | null> => {
  const [cycle] = await db
    .select()
    .from(sebProgrammeCycle)
    .where(
      and(
        eq(sebProgrammeCycle.id, cycleId),
        programmeCycleOpenAt(now),
      ),
    )
    .limit(1)
  return cycle ?? null
}

/**
 * How a cycle introduces itself on paper.
 *
 * `findOpenProgrammeCycle` above cannot serve this: it filters on the open
 * window, and a decision or sanction is routinely notified after the cycle
 * has closed — exactly when the letterhead still has to name it.
 */
export const findProgrammeCycleIdentity = async (
  db: Database,
  programmeCycleId: string,
): Promise<{ cycleCode: string; displayName: string } | null> => {
  const [row] = await db
    .select({
      cycleCode: sebProgrammeCycle.cycleCode,
      displayName: sebProgrammeCycle.displayName,
    })
    .from(sebProgrammeCycle)
    .where(eq(sebProgrammeCycle.id, programmeCycleId))
    .limit(1)
  return row ?? null
}

/** Loads the exact immutable rules pinned by an application snapshot. */
/**
 * The cycle scalars an application is judged by.
 *
 * Document rules are gone from here: a required document is a FILE field with
 * an ordinary conditional requirement, so it comes back with the template
 * rather than as a separate list. `findPinnedCycleRules` reads both together.
 */
export const findSubmissionPolicy = async (
  db: Database,
  cycleId: string,
  cycleVersion: number,
): Promise<SubmissionPolicy | null> => {
  const pinned = await findPinnedCycleRules(db, cycleId, cycleVersion)
  return pinned?.policy ?? null
}


export const findEnterpriseApplicationSource = async (
  db: Database,
  userId: string,
  enterpriseId: string,
) => {
  const [row] = await db
    .select({
      enterprise: sebEnterprise,
      version: sebEnterpriseVersion,
      fundingCase: sebFundingCase,
    })
    .from(sebEnterprise)
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
    .innerJoin(sebFundingCase, eq(sebFundingCase.enterpriseId, sebEnterprise.id))
    .where(
      and(
        eq(sebEnterprise.id, enterpriseId),
        eq(sebEnterprise.portalOwnerUserId, userId),
        isNull(sebEnterprise.deletedAt),
        isNull(sebFundingCase.deletedAt),
        eq(sebFundingCase.status, 'OPEN'),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Everything an eligibility rule may ask about one enterprise, in two reads.
 *
 * The rules themselves are pure (`../eligibility`), so what a kind allows is a
 * function of this history alone — which is what lets the applicant be shown
 * exactly the reasons that were evaluated. Every application of the
 * enterprise is read, across every cycle, because "an earlier application
 * holds a flag" does not care which cycle it was in. Deleted drafts are not
 * history.
 *
 * `excludeApplicationId` leaves one application out: re-checking a draft's own
 * kind at submission must not count that draft as the "open application" the
 * rule forbids.
 */
export const findEligibilityHistory = async (
  db: Database,
  enterpriseId: string,
  now: Date,
  excludeApplicationId?: string,
): Promise<EligibilityHistory> => {
  const [facts, rows, added] = await batch(db, (tx) => [
    tx
      .select({ establishmentDate: sebEnterpriseVersion.establishmentDate })
      .from(sebEnterprise)
      .innerJoin(
        sebEnterpriseVersion,
        and(
          eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
          eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
        ),
      )
      .where(eq(sebEnterprise.id, enterpriseId))
      .limit(1),
    tx
      .select({
        id: sebApplication.id,
        kind: sebApplication.applicationKind,
        pipelineKey: sebPipeline.key,
        status: sebApplication.status,
        currentStageKey: sebApplication.currentStageKey,
        flags: sebApplication.statusFlags,
        recorded: sebApplication.recordedValues,
      })
      .from(sebApplication)
      .innerJoin(sebPipeline, eq(sebPipeline.id, sebApplication.pipelineId))
      .where(and(
        eq(sebApplication.enterpriseId, enterpriseId),
        isNull(sebApplication.deletedAt),
        excludeApplicationId ? ne(sebApplication.id, excludeApplicationId) : undefined,
      ))
      .limit(MAX_COLLECTION_ROWS),
    /*
     * When each flag was last added, per application, from the action rows —
     * the head holds only which flags are held now. Grouped in SQL so the
     * cost is one row per (application, flag) rather than one per action.
     */
    tx
      .select({
        applicationId: sql<string>`action.application_id`,
        flag: sql<string>`added.flag`,
        addedAt: sql<Date>`max(action.created_at)`.mapWith(sebApplicationStageAction.createdAt),
      })
      // Raw FROM, so the columns above are named through its aliases too:
      // drizzle refuses a table column the query does not itself select from.
      .from(sql`${sebApplicationStageAction} AS action
        CROSS JOIN LATERAL unnest(action.flags_added) AS added(flag)`)
      .where(sql`action.application_id IN (
        SELECT ${sebApplication.id} FROM ${sebApplication}
         WHERE ${sebApplication.enterpriseId} = ${enterpriseId}
           AND ${sebApplication.deletedAt} IS NULL)`)
      .groupBy(sql`action.application_id, added.flag`),
  ])
  const addedAt = new Map<string, Record<string, Date>>()
  for (const row of added) {
    const byFlag = addedAt.get(row.applicationId) ?? {}
    byFlag[row.flag] = row.addedAt
    addedAt.set(row.applicationId, byFlag)
  }
  return {
    now,
    enterpriseEstablishedOn: facts[0]?.establishmentDate ?? null,
    applications: rows.map((row) => ({
      kind: row.kind,
      pipelineKey: row.pipelineKey,
      draft: row.status === 'DRAFT',
      // Submitted, and no stage holds it: an action ended its journey.
      finished: row.status === 'IN_PIPELINE' && row.currentStageKey === null,
      flags: row.flags,
      // Only flags still held have a time that matters; the rest are history.
      flagAddedAt: Object.fromEntries(
        Object.entries(addedAt.get(row.id) ?? {}).filter(([flag]) => row.flags.includes(flag)),
      ),
      recorded: (row.recorded ?? {}) as Record<string, AnswerValue>,
    })),
  }
}

/** The kinds a cycle version declares, in their order, each with its rules. */
export const findCycleApplicationKinds = async (
  db: Database,
  cycleId: string,
  cycleVersion: number,
): Promise<Array<{ kindKey: string; label: string; description: string | null; rules: EligibilityRule[] }>> => {
  const [kinds, rules] = await batch(db, (tx) => [
    tx.select().from(sebProgrammeCycleApplicationKind).where(and(
      eq(sebProgrammeCycleApplicationKind.programmeCycleId, cycleId),
      eq(sebProgrammeCycleApplicationKind.programmeCycleVersion, cycleVersion),
    )).orderBy(asc(sebProgrammeCycleApplicationKind.sortOrder)),
    tx.select().from(sebProgrammeCycleApplicationKindRule).where(and(
      eq(sebProgrammeCycleApplicationKindRule.programmeCycleId, cycleId),
      eq(sebProgrammeCycleApplicationKindRule.programmeCycleVersion, cycleVersion),
    )).orderBy(asc(sebProgrammeCycleApplicationKindRule.position)),
  ])
  return kinds.map((kind) => ({
    kindKey: kind.kindKey,
    label: kind.label,
    description: kind.description,
    rules: rules
      .filter((rule) => rule.kindKey === kind.kindKey)
      .map((rule) => ({ type: rule.ruleType as EligibilityRuleType, params: rule.params })),
  }))
}

const versionValues = (input: {
  id?: string
  applicationId: string
  version: number
  programmeCycleId: string
  programmeCycleVersion: number
  applicationKind: string
  phaseNumber: number
  changeType: 'INITIAL' | 'SAVE' | 'REVISION' | 'SUBMISSION' | 'RESUBMISSION'
  changedByUserId: string
  createdAt: Date
  declarationAcceptedAt: Date | null
  applicationCategory: 'CATEGORY_A' | 'CATEGORY_B' | null
}): typeof sebApplicationVersion.$inferInsert => ({
  id: input.id ?? crypto.randomUUID(),
  applicationId: input.applicationId,
  version: input.version,
  programmeCycleId: input.programmeCycleId,
  programmeCycleVersion: input.programmeCycleVersion,
  applicationKind: input.applicationKind,
  phaseNumber: input.phaseNumber,
  changeType: input.changeType,
  changeReason: null,
  changedByUserId: input.changedByUserId,
  createdAt: input.createdAt,
  declarationAcceptedAt: input.declarationAcceptedAt,
  // Computed by the server at submission; null on drafts. See the schema.
  applicationCategory: input.applicationCategory,
})

/**
 * Inserts the version, but only where the guard still holds.
 *
 * This used to list fifty-one values positionally, with no column list, so the
 * order of the Drizzle table definition was load-bearing and a mis-ordered
 * entry was a wrong value rather than an error. With the answers in their own
 * rows there are twelve columns, listed in the table's order below.
 *
 * Still an `INSERT … SELECT … WHERE`, because the predicate is what makes the
 * write lose cleanly to a concurrent one.
 */
const insertVersionWhere = (
  db: Executor,
  value: typeof sebApplicationVersion.$inferInsert,
  predicate: SQL,
) => db.insert(sebApplicationVersion).select(sql`
  SELECT ${value.id}, ${value.applicationId}, ${value.version},
    ${value.programmeCycleId}, ${value.programmeCycleVersion},
    ${value.applicationKind}, ${value.phaseNumber}, ${value.changeType},
    ${sqlNullable(value.changeReason)}, ${value.changedByUserId},
    ${value.createdAt},
    ${sqlNullable(value.declarationAcceptedAt as Date | null | undefined)},
    ${sqlNullable(value.applicationCategory)}
  FROM ${sebApplication}
  WHERE ${predicate}
`)

/**
 * The answer rows for one version, written in a single statement.
 *
 * Sparse — a cleared or unanswered question produces no row — so absence is the
 * one representation of "unanswered" in storage as well as in the engine.
 */
/**
 * The answers, written only if the version they belong to was written.
 *
 * **Guarded, like every other statement in these transactions.** It was a
 * plain multi-row `VALUES`, and that made it the one statement that fired
 * whatever the guarded `INSERT` ahead of it decided. When a start or a save is
 * legitimately refused — a stale version, an application that moved on — the
 * version row is not written, and these rows then had no parent: the composite
 * key aborted the transaction, so a refusal the caller was meant to receive as
 * `false` arrived as a thrown error and reached the applicant as a failure
 * rather than "reload and try again".
 *
 * One statement whatever the template asks, so a save costs one round trip
 * regardless of how many questions the cycle declares.
 */
const insertAnswerRows = (
  db: Executor,
  input: {
    applicationVersionId: string
    programmeCycleId: string
    programmeCycleVersion: number
    rows: readonly AnswerRow[]
    createdAt: Date
  },
) => {
  if (input.rows.length === 0) return null
  /*
   * The first row carries the casts. Inside a bare `VALUES` list Postgres has
   * nothing to infer a parameter's type from, and would resolve every column
   * as `text` — which the two ordinals are not.
   */
  const values = input.rows.map((row, index) => index === 0
    ? sql`(${row.fieldKey}::text, ${row.entryIndex}::int,
        ${row.valueOrdinal}::int, ${row.valueText}::text)`
    : sql`(${row.fieldKey}, ${row.entryIndex}, ${row.valueOrdinal}, ${row.valueText})`)
  return db.insert(sebApplicationVersionAnswer).select(sql`
    SELECT gen_random_uuid()::text, ${input.applicationVersionId},
      ${input.programmeCycleId}, ${input.programmeCycleVersion},
      answer.field_key, answer.entry_index, answer.value_ordinal, answer.value_text,
      ${input.createdAt}
    FROM (VALUES ${sql.join(values, sql`, `)})
      AS answer(field_key, entry_index, value_ordinal, value_text)
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationVersion}
      WHERE ${sebApplicationVersion.id} = ${input.applicationVersionId}
    )
  `)
}

/*
 * The members an application write is folded from.
 *
 * Each selects FROM the member it depends on — the guarded head update, or the
 * version that update produced — rather than re-checking the table. Members of
 * one statement see the database as it was before the statement, so a guard
 * like "the head is now at version n+1" would match nothing; the returned row
 * is the only way one member learns another wrote. A losing writer's head
 * update returns no row, so every member built on it writes nothing.
 *
 * The column lists are explicit because a raw insert has no declaration order
 * to lean on; `check:insert-arity` holds each list to its table.
 */
const applicationVersionMember = (
  value: typeof sebApplicationVersion.$inferInsert,
  source: SQL,
) => sql`
  INSERT INTO ${sebApplicationVersion} (
    id, application_id, version, programme_cycle_id, programme_cycle_version,
    application_kind, phase_number, change_type, change_reason, changed_by_user_id,
    created_at, declaration_accepted_at, application_category
  )
  SELECT ${value.id}, ${value.applicationId}, ${value.version}::int,
    ${value.programmeCycleId}, ${value.programmeCycleVersion}::int,
    ${value.applicationKind}, ${value.phaseNumber}::int, ${value.changeType},
    ${sqlNullable(value.changeReason)}, ${value.changedByUserId},
    ${value.createdAt},
    ${sqlNullable(value.declarationAcceptedAt as Date | null | undefined)},
    ${sqlNullable(value.applicationCategory)}
  FROM ${source}
  RETURNING id
`

/**
 * A version's answer rows, in the same statement as the version.
 *
 * Sparse — a cleared or unanswered question produces no row — so absence is
 * the one representation of "unanswered" in storage as well as in the engine.
 * Null when there is nothing to write, so the caller leaves the member out.
 */
const answerRowsMember = (input: {
  rows: readonly AnswerRow[]
  programmeCycleId: string
  programmeCycleVersion: number
  createdAt: Date
  /** The member that returned the version these rows belong to. */
  version: SQL
}) => {
  if (input.rows.length === 0) return null
  /*
   * The first row carries the casts. Inside a bare `VALUES` list Postgres has
   * nothing to infer a parameter's type from, and would resolve every column
   * as `text` — which the two ordinals are not.
   */
  const answerValues = sql.join(input.rows.map((row, index) => index === 0
    ? sql`(${row.fieldKey}::text, ${row.entryIndex}::int, ${row.valueOrdinal}::int, ${row.valueText}::text)`
    : sql`(${row.fieldKey}, ${row.entryIndex}, ${row.valueOrdinal}, ${row.valueText})`), sql`, `)
  return sql`
    INSERT INTO ${sebApplicationVersionAnswer} (
      id, application_version_id, programme_cycle_id, programme_cycle_version,
      field_key, entry_index, value_ordinal, value_text, created_at
    )
    SELECT gen_random_uuid()::text, written.id, ${input.programmeCycleId},
      ${input.programmeCycleVersion}::int, answer.field_key, answer.entry_index,
      answer.value_ordinal, answer.value_text, ${input.createdAt}
    FROM ${input.version} written
    CROSS JOIN (VALUES ${answerValues}) AS answer(field_key, entry_index, value_ordinal, value_text)
  `
}

/** One entry on the applicant's timeline, written only with its source. */
const applicationEventMember = (value: typeof sebApplicationEvent.$inferInsert, source: SQL) => sql`
  INSERT INTO ${sebApplicationEvent} (
    id, application_id, event_type, actor_user_id, application_version,
    submission_id, revision_request_id, from_status, to_status, stage_key,
    message, metadata_json, created_at, stage_action_id
  )
  SELECT ${value.id}, ${value.applicationId}, ${value.eventType}, ${value.actorUserId},
    ${sqlNullable(value.applicationVersion)}::int, ${sqlNullable(value.submissionId)}, NULL,
    ${sqlNullable(value.fromStatus)}, ${sqlNullable(value.toStatus)}, NULL,
    ${sqlNullable(value.message)}, NULL, ${value.createdAt}, NULL
  FROM ${source}
`

/**
 * Folds members into one statement and returns the row the head update
 * returned, or null when its guard lost and so nothing was written.
 */
const writeFolded = async <Head extends Record<string, unknown>>(
  db: Database,
  members: (SQL | null)[],
): Promise<Head | null> => {
  const present = members.filter((member): member is SQL => member !== null)
  const result = await db.execute(sql`
    WITH ${sql.join(present, sql`, `)}
    SELECT * FROM head
  `)
  return (result.rows[0] as Head | undefined) ?? null
}

const eventValues = (input: {
  id?: string
  applicationId: string
  eventType: string
  actorUserId: string
  applicationVersion?: number | null
  submissionId?: string | null
  fromStatus?: ApplicationStatus | null
  toStatus?: ApplicationStatus | null
  message?: string | null
  createdAt: Date
}): typeof sebApplicationEvent.$inferInsert => ({
  id: input.id ?? crypto.randomUUID(),
  applicationId: input.applicationId,
  eventType: input.eventType,
  actorUserId: input.actorUserId,
  applicationVersion: sqlNullable(input.applicationVersion),
  submissionId: sqlNullable(input.submissionId),
  revisionRequestId: null,
  fromStatus: sqlNullable(input.fromStatus),
  toStatus: sqlNullable(input.toStatus),
  stageKey: null,
  message: sqlNullable(input.message),
  metadataJson: null,
  createdAt: input.createdAt,
})

/**
 * The revision this write claims to be answering is still the open one.
 *
 * **The parameter name matters here in a way TypeScript could not see.** It
 * read `input.revisionSections` while both callers pass `revisionStageKeys` —
 * a rename that missed this one reader. The property is optional, so nothing
 * failed to compile; it simply arrived `undefined`, the scope became empty,
 * and `0 > 0` refused every save. **No applicant under revision could save or
 * resubmit at all**, and each was told "The application changed. Refresh it
 * and try again."
 */
const revisionScopeStillCurrent = (input: {
  head: ApplicationMutationHead
  revisionStageKeys?: ApplicationSection[]
}): SQL | undefined => {
  // A draft is open everywhere; only a submitted application saves in scope.
  if (input.head.status === 'DRAFT') return undefined
  const sections = input.revisionStageKeys ?? []
  const openRevision = (section: ApplicationSection) => sql`EXISTS (
    SELECT 1 FROM ${sebRevisionRequest}
    WHERE ${sebRevisionRequest.applicationId} = ${input.head.id}
      AND ${sebRevisionRequest.stageKey} = ${section}
      AND ${sebRevisionRequest.resolvedAt} IS NULL
      AND ${sebRevisionRequest.cancelledAt} IS NULL
  )`
  return and(
    // An empty scope is never a valid revision save or resubmission.
    sql`${sections.length} > 0`,
    sql`(
      SELECT COUNT(DISTINCT ${sebRevisionRequest.stageKey})
      FROM ${sebRevisionRequest}
      WHERE ${sebRevisionRequest.applicationId} = ${input.head.id}
        AND ${sebRevisionRequest.resolvedAt} IS NULL
        AND ${sebRevisionRequest.cancelledAt} IS NULL
    ) = ${sections.length}`,
    ...sections.map(openRevision),
  )
}

export const insertApplicationAggregate = async (
  db: Database,
  input: {
    applicationId: string
    applicantUserId: string
    enterpriseId: string
    fundingCaseId: string
    programmeCycleId: string
    programmeCycleVersion: number
    /** One of the kinds the pinned cycle version declares; the write re-checks it. */
    applicationKind: string
    phaseNumber: number
    /**
     * The prefilled answers, already turned into rows by the caller.
     *
     * Rows rather than an `AnswerMap`, because building them needs the pinned
     * template and the caller has already resolved it. Resolving it twice is how
     * a save and its validation come to disagree about what the form is.
     */
    answerRows: readonly AnswerRow[]
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const versionId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  /*
   * The pipeline is read from the cycle version, in the statement, rather than
   * passed in: the application is worked in whatever the cycle pinned when it
   * opened, and a caller cannot name a different one. An unpinned version — a
   * draft cycle — yields no row, so nothing is written.
   *
   * No "one live application" guard here any more. Which applications may
   * coexist is the kind's eligibility rules' decision, evaluated by the
   * controller; the unique `(case, cycle, phase)` index is the backstop that
   * refuses a duplicate attempt inside one cycle.
   */
  const insertHead = db
    .insert(sebApplication)
    .select(sql`
      SELECT ${input.applicationId}, ${input.applicantUserId}, ${input.enterpriseId},
        ${input.fundingCaseId}, ${input.programmeCycleId}, ${input.applicationKind},
        ${input.phaseNumber}, NULL, 1, ${input.now}, ${input.now},
        NULL, NULL, NULL, 'DRAFT', 1, ${input.now}, NULL,
        cycle_version.pipeline_id, cycle_version.pipeline_version,
        NULL, NULL, '{}'::text[], '{}'::text[], '{}'::jsonb
      FROM ${sebProgrammeCycleVersion} AS cycle_version
      WHERE cycle_version.programme_cycle_id = ${input.programmeCycleId}
        AND cycle_version.version = ${input.programmeCycleVersion}
        AND cycle_version.pipeline_version IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${sebProgrammeCycleApplicationKind} AS kind
          WHERE kind.programme_cycle_id = ${input.programmeCycleId}
            AND kind.programme_cycle_version = ${input.programmeCycleVersion}
            AND kind.kind_key = ${input.applicationKind}
        )
        AND EXISTS (
          SELECT 1
          FROM ${sebEnterprise}
          INNER JOIN ${sebFundingCase}
            ON ${sebFundingCase.id} = ${input.fundingCaseId}
            AND ${sebFundingCase.enterpriseId} = ${sebEnterprise.id}
          INNER JOIN ${sebProgrammeCycle}
            ON ${sebProgrammeCycle.id} = ${input.programmeCycleId}
          WHERE ${sebEnterprise.id} = ${input.enterpriseId}
            AND ${sebEnterprise.portalOwnerUserId} = ${input.applicantUserId}
            AND ${sebEnterprise.deletedAt} IS NULL
            AND ${sebFundingCase.status} = 'OPEN'
            AND ${sebFundingCase.deletedAt} IS NULL
            AND ${sebProgrammeCycle.currentVersion} = ${input.programmeCycleVersion}
            AND ${programmeCycleOpenAt(input.now)}
        )
    `)
    .returning({ id: sebApplication.id })
  const insertVersion = insertVersionWhere(
    db,
    versionValues({
      id: versionId,
      applicationId: input.applicationId,
      version: 1,
      programmeCycleId: input.programmeCycleId,
      programmeCycleVersion: input.programmeCycleVersion,
      applicationKind: input.applicationKind,
      phaseNumber: input.phaseNumber,
      changeType: 'INITIAL',
      changedByUserId: input.applicantUserId,
      createdAt: input.now,
      declarationAcceptedAt: null,
      applicationCategory: null,
    }),
    sql`${sebApplication.id} = ${input.applicationId}`,
  )
  const insertAnswers = insertAnswerRows(db, {
    applicationVersionId: versionId,
    programmeCycleId: input.programmeCycleId,
    programmeCycleVersion: input.programmeCycleVersion,
    rows: input.answerRows,
    createdAt: input.now,
  })
  const insertEvent = db.insert(sebApplicationEvent).select(sql`
    SELECT ${eventId}, ${input.applicationId}, 'APPLICATION_STARTED',
      ${input.applicantUserId}, 1, NULL, NULL, NULL, 'DRAFT', NULL,
      'Application draft started.', NULL, ${input.now}, NULL
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
    )
  `)
  const insertAudit = insertAuditEventWhere(db, input.audit, sql`EXISTS (
      SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
    )
  `)
  const statements = insertAnswers
    ? [insertHead, insertVersion, insertAnswers] as const
    : [insertHead, insertVersion] as const
  const [headResult] = await batch(db, () => [...statements, insertEvent, insertAudit])
  return headResult.length === 1
}

export const saveApplicationSnapshot = async (
  db: Database,
  input: {
    head: ApplicationMutationHead
    userId: string
    /** Built by the caller from the template it validated against. */
    answerRows: readonly AnswerRow[]
    revisionStageKeys?: ApplicationSection[]
    programmeCycleVersion: number
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const nextVersion = input.head.currentVersion + 1
  // A submitted application saves only inside an open revision, which the
  // scope guard below proves; a draft saves anywhere.
  const changeType = input.head.status === 'DRAFT' ? 'SAVE' : 'REVISION'
  /*
   * One statement: the guarded head update first, and the version, its
   * answers, the timeline entry and the audit row each selected from what it
   * returned. Every guard stays in the update's predicate, so a stale or
   * out-of-scope save updates nothing and writes nothing else.
   */
  const guard = and(
    eq(sebApplication.id, input.head.id),
    eq(sebApplication.applicantUserId, input.userId),
    eq(sebApplication.currentVersion, input.head.currentVersion),
    eq(sebApplication.statusVersion, input.head.statusVersion),
    eq(sebApplication.status, input.head.status),
    isNull(sebApplication.deletedAt),
    revisionScopeStillCurrent(input),
  )
  const answers = answerRowsMember({
    rows: input.answerRows,
    programmeCycleId: input.head.programmeCycleId,
    programmeCycleVersion: input.programmeCycleVersion,
    createdAt: input.now,
    version: sql`version`,
  })
  return (await writeFolded(db, [
    sql`head AS (
      UPDATE ${sebApplication}
      SET current_version = ${nextVersion}::int, updated_at = ${input.now}
      WHERE ${guard}
      RETURNING id
    )`,
    sql`version AS (${applicationVersionMember(versionValues({
      id: crypto.randomUUID(),
      applicationId: input.head.id,
      version: nextVersion,
      programmeCycleId: input.head.programmeCycleId,
      programmeCycleVersion: input.programmeCycleVersion,
      applicationKind: input.head.applicationKind,
      phaseNumber: input.head.phaseNumber,
      changeType,
      changedByUserId: input.userId,
      createdAt: input.now,
      declarationAcceptedAt: null,
      applicationCategory: null,
    }), sql`head`)})`,
    answers && sql`answers AS (${answers})`,
    sql`event AS (${applicationEventMember(eventValues({
      applicationId: input.head.id,
      eventType: 'APPLICATION_SAVED',
      actorUserId: input.userId,
      applicationVersion: nextVersion,
      message: 'Application draft saved.',
      createdAt: input.now,
    }), sql`head`)})`,
    sql`audit AS (${auditEventCteMember(input.audit, sql`head`)})`,
  ])) !== null
}

export const setApplicationDeleted = async (
  db: Database,
  input: {
    head: ApplicationHeadRecord
    userId: string
    deleted: boolean
    reason: string | null
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const statePredicate = input.deleted
    ? isNull(sebApplication.deletedAt)
    : isNotNull(sebApplication.deletedAt)
  /*
   * Restoring must re-establish what deletion released: the enterprise and its
   * funding case are still live. Whether the kind may still be started is the
   * kind's eligibility rules' question, re-asked by the controller; a second
   * attempt in the same cycle cannot exist, because the `(case, cycle, phase)`
   * key counts deleted drafts too.
   */
  const restoreRootEligibilityPredicate = !input.deleted
    ? sql`EXISTS (
        SELECT 1
        FROM ${sebEnterprise}
        INNER JOIN ${sebFundingCase}
          ON ${sebFundingCase.id} = ${input.head.fundingCaseId}
          AND ${sebFundingCase.enterpriseId} = ${sebEnterprise.id}
        WHERE ${sebEnterprise.id} = ${input.head.enterpriseId}
          AND ${sebEnterprise.portalOwnerUserId} = ${input.userId}
          AND ${sebEnterprise.deletedAt} IS NULL
          AND ${sebFundingCase.status} = 'OPEN'
          AND ${sebFundingCase.deletedAt} IS NULL
      )`
    : undefined
  /*
   * This append-only audit row is the transition's unique claim: it carries the
   * whole predicate, and every other statement here requires its exact id.
   *
   * Stronger than correlating on `updated_at`, which independent requests may
   * legitimately share to the millisecond — and the reason this transition,
   * unlike the others, is ordered audit-first rather than head-first.
   */
  const audit = insertAuditEventWhere(db, input.audit, sql`EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.head.id}
        AND ${sebApplication.applicantUserId} = ${input.userId}
        AND ${sebApplication.currentVersion} = ${input.head.currentVersion}
        AND ${sebApplication.statusVersion} = ${input.head.statusVersion}
        AND ${sebApplication.status} = 'DRAFT'
        AND ${statePredicate}
        AND ${restoreRootEligibilityPredicate ?? sql`1 = 1`}
    )
  `).returning({ id: coreAuditEvent.id })
  const updateHead = db
    .update(sebApplication)
    .set(
      input.deleted
        ? {
            deletedAt: input.now,
            deletedByUserId: input.userId,
            deleteReason: input.reason,
            updatedAt: input.now,
          }
        : {
            deletedAt: null,
            deletedByUserId: null,
            deleteReason: null,
            updatedAt: input.now,
          },
    )
    .where(
      and(
        eq(sebApplication.id, input.head.id),
        eq(sebApplication.applicantUserId, input.userId),
        eq(sebApplication.currentVersion, input.head.currentVersion),
        eq(sebApplication.statusVersion, input.head.statusVersion),
        eq(sebApplication.status, 'DRAFT'),
        statePredicate,
        restoreRootEligibilityPredicate,
        sql`EXISTS (
          SELECT 1 FROM ${coreAuditEvent}
          WHERE ${coreAuditEvent.id} = ${input.audit.id}
        )`,
      ),
    )
  const eventId = crypto.randomUUID()
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${eventId}, ${input.head.id},
      ${input.deleted ? 'APPLICATION_DELETED' : 'APPLICATION_RESTORED'},
      ${input.userId}, ${input.head.currentVersion}, NULL, NULL, 'DRAFT', 'DRAFT',
      NULL, ${input.deleted ? 'Application draft removed.' : 'Application draft restored.'},
      NULL, ${input.now}, NULL
    WHERE EXISTS (
      SELECT 1 FROM ${coreAuditEvent}
      WHERE ${coreAuditEvent.id} = ${input.audit.id}
    )
  `)
  const [updated] = await batch(db, () => [audit, updateHead, event] as const)
  return changedExactlyOne(updated)
}

/*
 * ─── The submission seam ────────────────────────────────────────────────────
 *
 * The only two places where applicant-side writes touch the pipeline. Both are
 * expressed in SQL over the application's own pinned pipeline version, so the
 * write cannot disagree with the version the file is worked in.
 */

/**
 * What a first submission sets: the file enters its pipeline at the pinned
 * version's initial stage, holding the flags the definition adds on submit.
 */
const pipelineEntry = (now: Date) => ({
  status: 'IN_PIPELINE' as const,
  currentStageKey: sql`(
    SELECT ${sebPipelineVersionStage.stageKey} FROM ${sebPipelineVersionStage}
    WHERE ${sebPipelineVersionStage.pipelineId} = ${sebApplication.pipelineId}
      AND ${sebPipelineVersionStage.version} = ${sebApplication.pipelineVersion}
      AND ${sebPipelineVersionStage.isInitial}
  )`,
  stageEnteredAt: now,
  stageTrail: sql`'{}'::text[]`,
  statusFlags: sql`ARRAY(
    SELECT DISTINCT jsonb_array_elements_text(
      COALESCE(${sebPipelineVersion.definition} -> 'onSubmit' -> 'addFlags', '[]'::jsonb))
    FROM ${sebPipelineVersion}
    WHERE ${sebPipelineVersion.pipelineId} = ${sebApplication.pipelineId}
      AND ${sebPipelineVersion.version} = ${sebApplication.pipelineVersion}
  )`,
})

/**
 * What a resubmission sets: the file stays at the stage that asked for the
 * correction — REQUEST_REVISION never moves it — and loses the flag that
 * unlocked the applicant's edit.
 *
 * Every held flag the pinned definition declares `REVISION_SCOPED` is removed,
 * which is the same as "the flag the latest revision request added": the
 * validator lets only REQUEST_REVISION add such a flag, and no action is
 * offered while one is held, so at most one can be. Order of the rest is kept.
 */
const resubmissionEntry = () => ({
  status: 'IN_PIPELINE' as const,
  statusFlags: sql`ARRAY(
    SELECT held.flag
    FROM unnest(${sebApplication.statusFlags}) WITH ORDINALITY AS held(flag, position)
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${sebPipelineVersion},
        jsonb_array_elements(${sebPipelineVersion.definition} -> 'statusFlags') AS declared
      WHERE ${sebPipelineVersion.pipelineId} = ${sebApplication.pipelineId}
        AND ${sebPipelineVersion.version} = ${sebApplication.pipelineVersion}
        AND declared ->> 'key' = held.flag
        AND declared ->> 'applicantEdit' = 'REVISION_SCOPED'
    )
    ORDER BY held.position
  )`,
})

/** What a submission's head update returned: the fields SQL decided. */
export type SubmittedHead = {
  currentStageKey: string | null
  statusFlags: string[]
}

export const submitApplicationSnapshot = async (
  db: Database,
  input: {
    head: ApplicationMutationHead
    userId: string
    /** Built by the caller from the template it validated against. */
    answerRows: readonly AnswerRow[]
    revisionStageKeys?: ApplicationSection[]
    programmeCycleVersion: number
    referenceNumber: string
    resubmission: boolean
    /** From the cycle's rules, computed once by the caller that validated. */
    requiredDocumentFieldKeys: readonly DocumentType[]
    /**
     * Computed by the caller from the enterprise's establishment date and the
     * cycle's threshold; null when the cycle sets none. Part of the frozen
     * snapshot — later enterprise edits must not re-sort a submission.
     */
    applicationCategory: 'CATEGORY_A' | 'CATEGORY_B' | null
    now: Date
    audit: AuditRecord
  },
): Promise<SubmittedHead | false> => {
  const nextVersion = input.head.currentVersion + 1
  const nextStatusVersion = input.head.statusVersion + 1
  const submissionId = crypto.randomUUID()
  const cycleStillOpen = input.resubmission
    ? undefined
    : sql`EXISTS (
        SELECT 1 FROM ${sebProgrammeCycle}
        WHERE ${sebProgrammeCycle.id} = ${input.head.programmeCycleId}
          AND ${programmeCycleOpenAt(input.now)}
      )`
  // A pinned pipeline version always has one, but the write says so rather
  // than trusting it: without an initial stage the file would sit nowhere.
  const initialStageExists = sql`EXISTS (
    SELECT 1 FROM ${sebPipelineVersionStage}
    WHERE ${sebPipelineVersionStage.pipelineId} = ${sebApplication.pipelineId}
      AND ${sebPipelineVersionStage.version} = ${sebApplication.pipelineVersion}
      AND ${sebPipelineVersionStage.isInitial}
  )`
  /*
   * Repeated inside the write so a document deleted between validation and
   * submission cannot slip past — using the list the validator computed from
   * the cycle's own rules. Deriving it again here from the snapshot alone made
   * the two disagree whenever a cycle asked for fewer documents than the
   * default, and the submission was refused with a message about the
   * application having changed, which it had not.
   */
  const requiredDocumentsStillExist = and(
    ...input.requiredDocumentFieldKeys.map((fieldKey) => sql`EXISTS (
      SELECT 1 FROM ${sebApplicationDocument}
      WHERE ${sebApplicationDocument.applicationId} = ${input.head.id}
        AND ${sebApplicationDocument.fieldKey} = ${fieldKey}
        AND ${sebApplicationDocument.deletedAt} IS NULL
    )`),
  )
  const guard = and(
    eq(sebApplication.id, input.head.id),
    eq(sebApplication.applicantUserId, input.userId),
    eq(sebApplication.currentVersion, input.head.currentVersion),
    eq(sebApplication.statusVersion, input.head.statusVersion),
    eq(sebApplication.status, input.resubmission ? 'IN_PIPELINE' : 'DRAFT'),
    isNull(sebApplication.deletedAt),
    cycleStillOpen,
    input.resubmission ? undefined : initialStageExists,
    requiredDocumentsStillExist,
    revisionScopeStillCurrent(input),
  )
  /*
   * A first submission enters the pipeline at the pinned version's initial
   * stage with the flags its definition adds on submit; a resubmission stays
   * at the stage that asked and loses the flag that let the applicant edit.
   * Both are SQL over the application's own pinned version, so the write
   * cannot disagree with the version the file is worked in.
   */
  const entry = input.resubmission
    ? sql`status_flags = ${resubmissionEntry().statusFlags}`
    : sql`current_stage_key = ${pipelineEntry(input.now).currentStageKey},
        stage_entered_at = ${input.now},
        stage_trail = '{}'::text[],
        status_flags = ${pipelineEntry(input.now).statusFlags}`
  /*
   * The next submission number: always one for a first submission, and one
   * past the last for a resubmission. The unique index on the number is the
   * backstop against two resubmissions racing, which the head's version guard
   * already refuses.
   */
  const submissionNumber = input.resubmission
    ? sql`(SELECT COALESCE(MAX(prior.submission_number), 0) + 1
        FROM ${sebApplicationSubmission} prior WHERE prior.application_id = ${input.head.id})`
    : sql`1`
  const answers = answerRowsMember({
    rows: input.answerRows,
    programmeCycleId: input.head.programmeCycleId,
    programmeCycleVersion: input.programmeCycleVersion,
    createdAt: input.now,
    version: sql`version`,
  })
  const written = await writeFolded<{ current_stage_key: string | null; status_flags: string[] }>(db, [
    sql`head AS (
      UPDATE ${sebApplication} SET
        current_version = ${nextVersion}::int,
        status_version = ${nextStatusVersion}::int,
        status = 'IN_PIPELINE',
        status_changed_at = ${input.now},
        reference_number = COALESCE(reference_number, ${input.referenceNumber}),
        first_submitted_at = COALESCE(first_submitted_at, ${input.now}),
        updated_at = ${input.now},
        ${entry}
      WHERE ${guard}
      RETURNING id, current_stage_key, status_flags
    )`,
    sql`version AS (${applicationVersionMember(versionValues({
      id: crypto.randomUUID(),
      applicationId: input.head.id,
      version: nextVersion,
      programmeCycleId: input.head.programmeCycleId,
      programmeCycleVersion: input.programmeCycleVersion,
      applicationKind: input.head.applicationKind,
      phaseNumber: input.head.phaseNumber,
      changeType: input.resubmission ? 'RESUBMISSION' : 'SUBMISSION',
      changedByUserId: input.userId,
      createdAt: input.now,
      declarationAcceptedAt: input.now,
      applicationCategory: input.applicationCategory,
    }), sql`head`)})`,
    answers && sql`answers AS (${answers})`,
    sql`submission AS (
      INSERT INTO ${sebApplicationSubmission} (
        id, application_id, submission_number, application_version,
        submitted_by_user_id, submitted_at
      )
      SELECT ${submissionId}, head.id, ${submissionNumber}, ${nextVersion}::int,
        ${input.userId}, ${input.now}
      FROM version CROSS JOIN head
      RETURNING id
    )`,
    /*
     * Every live document, at the version it is at as this statement runs.
     * Read here rather than beforehand, so a document replaced between the
     * validation and this write is pinned at its new version — the one the
     * application now holds — instead of being silently left out.
     */
    sql`pins AS (
      INSERT INTO ${sebApplicationSubmissionDocument} (
        id, application_id, submission_id, document_id, document_version,
        field_key, created_at
      )
      SELECT gen_random_uuid()::text, live.application_id, submission.id, live.id,
        live.current_version, live.field_key, ${input.now}
      FROM submission
      CROSS JOIN ${sebApplicationDocument} live
      WHERE live.application_id = ${input.head.id} AND live.deleted_at IS NULL
    )`,
    input.resubmission
      ? sql`resolved AS (
        UPDATE ${sebRevisionRequest} SET
          resolved_by_submission_id = submission.id,
          resolved_at = ${input.now}
        FROM submission
        WHERE ${sebRevisionRequest.applicationId} = ${input.head.id}
          AND ${sebRevisionRequest.resolvedAt} IS NULL
          AND ${sebRevisionRequest.cancelledAt} IS NULL
      )`
      : null,
    sql`event AS (${applicationEventMember(eventValues({
      applicationId: input.head.id,
      eventType: input.resubmission ? 'APPLICATION_RESUBMITTED' : 'APPLICATION_SUBMITTED',
      actorUserId: input.userId,
      applicationVersion: nextVersion,
      submissionId,
      fromStatus: input.resubmission ? 'IN_PIPELINE' : 'DRAFT',
      toStatus: 'IN_PIPELINE',
      message: input.resubmission ? 'Application resubmitted.' : 'Application submitted.',
      createdAt: input.now,
    }), sql`submission`)})`,
    sql`audit AS (${auditEventCteMember(input.audit, sql`submission`)})`,
  ])
  return written === null
    ? false
    : { currentStageKey: written.current_stage_key, statusFlags: written.status_flags }
}

export const listApplicationTimeline = async (
  db: Database,
  input: {
    applicationId: string
    first: number
    cursor: { timestamp: Date; id: string } | null
  },
): Promise<Connection<TimelineEvent>> => {
  const cursorPredicate = input.cursor
    ? or(
        gt(sebApplicationEvent.createdAt, input.cursor.timestamp),
        and(
          eq(sebApplicationEvent.createdAt, input.cursor.timestamp),
          gt(sebApplicationEvent.id, input.cursor.id),
        ),
      )
    : undefined
  const [head] = await db.select({ cycleId: sebApplication.programmeCycleId })
    .from(sebApplication).where(eq(sebApplication.id, input.applicationId)).limit(1)
  const rows = await db
    .select()
    .from(sebApplicationEvent)
    .where(and(eq(sebApplicationEvent.applicationId, input.applicationId), cursorPredicate))
    .orderBy(asc(sebApplicationEvent.createdAt), asc(sebApplicationEvent.id))
    .limit(input.first + 1)
  const cycleCursor = input.cursor
    ? or(
        gt(sebProgrammeCycleEvent.createdAt, input.cursor.timestamp),
        and(
          eq(sebProgrammeCycleEvent.createdAt, input.cursor.timestamp),
          gt(sebProgrammeCycleEvent.id, input.cursor.id),
        ),
      )
    : undefined
  const cycleRows = head ? await db.select().from(sebProgrammeCycleEvent)
    .where(and(eq(sebProgrammeCycleEvent.programmeCycleId, head.cycleId), cycleCursor))
    .orderBy(asc(sebProgrammeCycleEvent.createdAt), asc(sebProgrammeCycleEvent.id))
    .limit(input.first + 1) : []
  // Shared notices are merged at read time so a guidance/closing update creates
  // one authoritative event rather than thousands of duplicated application
  // rows. The composite timestamp/ID order preserves stable pagination.
  const merged = [
    ...rows.map((row) => ({
      id: row.id, eventType: row.eventType, fromStatus: row.fromStatus,
      toStatus: row.toStatus, stageKey: row.stageKey, message: row.message,
      createdAt: row.createdAt,
    })),
    ...cycleRows.map((row) => ({
      id: row.id, eventType: `CYCLE_${row.eventType}`,
      fromStatus: null, toStatus: null,
      // A cycle-wide notice belongs to no stage of anybody's form.
      stageKey: null as string | null,
      message: row.message, createdAt: row.createdAt,
    })),
  ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id))
  const hasNextPage = merged.length > input.first
  const selected = merged.slice(0, input.first)
  const last = selected.at(-1)
  /*
   * The timeline is two sources merged at read time, so its total is two
   * counts added. Both are covered by their `(parent_id, created_at)` index, so
   * this is a pair of seeks rather than a scan.
   */
  const [applicationTotal] = await db
    .select({ value: count() })
    .from(sebApplicationEvent)
    .where(eq(sebApplicationEvent.applicationId, input.applicationId))
  const [cycleTotal] = head
    ? await db
        .select({ value: count() })
        .from(sebProgrammeCycleEvent)
        .where(eq(sebProgrammeCycleEvent.programmeCycleId, head.cycleId))
    : [{ value: 0 }]
  return {
    nodes: selected,
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor('createdAt', last.createdAt, last.id) : null,
      totalCount:
        requireInvariant(applicationTotal, COUNT_MISSING).value +
        requireInvariant(cycleTotal, COUNT_MISSING).value,
    },
  }
}

export const snapshotRecordToPublic = snapshotFromRecord
