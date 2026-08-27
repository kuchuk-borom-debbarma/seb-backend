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
  sebAwardAssessment,
  sebApplication,
  sebApplicationDocument,
  sebApplicationSubmissionDocument,
  sebApplicationDocumentVersion,
  sebApplicationEvent,
  sebApplicationQualifyingAward,
  sebApplicationQualifyingAwardVersion,
  sebApplicationSubmission,
  sebApplicationVersion,
  sebApplicationVersionAnswer,
  sebDisbursement,
  sebEnterprise,
  sebEnterpriseVersion,
  sebFundingAward,
  sebFundingCase,
  sebProgrammeCycle,
  sebProgrammeCycleAssessmentRule,
  sebProgrammeCycleEvent,
  sebProgrammeCycleVersion,
  sebUtilizationObligation,
  sebRevisionRequest,
} from '../../../db/schema'
import { foldDisbursementLedger } from '../ledger'
import { MAX_COLLECTION_ROWS } from '../pagination'
import { changedStageKeys } from '../form/answers'
import { requiredDocumentFieldKeys } from '../form/engine'
import {
  answersByVersion,
  answersFromRows,
  answersToRows,
  findAnswerRows,
  findPinnedCycleRules,
  type AnswerRow,
} from './form-template'
import { encodeCursor } from '../pagination'
import { prefixMatch, prefixPattern } from '../../search'
import {
  COUNT_MISSING,
  requireInvariant,
  sqlNullable,
  type AuditRecord,
} from '../support'
import type { AnswerMap } from '../form/types'
import type {
  Application,
  ApplicationDocument,
  ApplicationSection,
  ApplicationSnapshot,
  ApplicationStatus,
  ApplicationSummary,
  ApplicationType,
  Connection,
  DocumentType,
  ExpansionClaim,
  ExpansionEligibility,
  ExpansionReason,
  ExpansionReasonCode,
  ProgrammeCycle,
  RevisionRequest,
  TimelineEvent,
} from '../types'
import {
  addUtcCalendarMonths,
  fullUtcCalendarMonths,
  type SubmissionPolicy,
} from '../validation'

export type ApplicationHeadRecord = typeof sebApplication.$inferSelect
export type ApplicationVersionRecord = typeof sebApplicationVersion.$inferSelect
export type ProgrammeCycleRecord = typeof sebProgrammeCycle.$inferSelect
type ApplicationMutationHead = Pick<
  ApplicationHeadRecord,
  | 'id'
  | 'fundingCaseId'
  | 'programmeCycleId'
  | 'applicationType'
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
  applicationType: record.applicationType,
  phaseNumber: record.phaseNumber,
  changeType: record.changeType,
  createdAt: record.createdAt,
  declarationAcceptedAt: record.declarationAcceptedAt,
  priorSanctionOrderNumber: record.priorSanctionOrderNumber,
  priorSanctionDate: record.priorSanctionDate,
  priorNetDisbursedAmountPaise: record.priorNetDisbursedAmountPaise,
  continuousOperationMonths: record.continuousOperationMonths,
  applicationCategory: record.applicationCategory,
})

const applicationBase = (head: ApplicationHeadRecord) => ({
  id: head.id,
  enterpriseId: head.enterpriseId,
  fundingCaseId: head.fundingCaseId,
  programmeCycleId: head.programmeCycleId,
  applicationType: head.applicationType,
  phaseNumber: head.phaseNumber,
  referenceNumber: head.referenceNumber,
  currentVersion: head.currentVersion,
  status: head.status,
  statusVersion: head.statusVersion,
  firstSubmittedAt: head.firstSubmittedAt,
  createdAt: head.createdAt,
  updatedAt: head.updatedAt,
  deletedAt: head.deletedAt,
})

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

export const listActiveDocumentFieldKeys = async (
  db: Database,
  applicationId: string,
): Promise<Set<DocumentType>> => {
  const rows = await db
    .select({ fieldKey: sebApplicationDocument.fieldKey })
    .from(sebApplicationDocument)
    .where(
      and(
        eq(sebApplicationDocument.applicationId, applicationId),
        isNull(sebApplicationDocument.deletedAt),
      ),
    )
  return new Set(rows.map((row) => row.fieldKey))
}

const listDocuments = async (
  db: Database,
  applicationId: string,
): Promise<ApplicationDocument[]> => {
  const rows = await db
    .select({ head: sebApplicationDocument, version: sebApplicationDocumentVersion })
    .from(sebApplicationDocument)
    .innerJoin(
      sebApplicationDocumentVersion,
      and(
        eq(sebApplicationDocumentVersion.documentId, sebApplicationDocument.id),
        eq(sebApplicationDocumentVersion.version, sebApplicationDocument.currentVersion),
      ),
    )
    .where(eq(sebApplicationDocument.applicationId, applicationId))
    .orderBy(asc(sebApplicationDocument.fieldKey))
  return rows.map(({ head, version }) => ({
    id: head.id,
    fieldKey: head.fieldKey,
    currentVersion: head.currentVersion,
    originalFilename: version.originalFilename,
    contentType: version.contentType,
    sizeBytes: version.sizeBytes,
    createdAt: head.createdAt,
    deletedAt: head.deletedAt,
  }))
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

const listRevisionRequests = async (db: Database, applicationId: string) =>
  db
    .select({
      id: sebRevisionRequest.id,
      stageKey: sebRevisionRequest.stageKey,
      note: sebRevisionRequest.note,
      requestedAt: sebRevisionRequest.requestedAt,
      resolvedAt: sebRevisionRequest.resolvedAt,
      cancelledAt: sebRevisionRequest.cancelledAt,
    })
    .from(sebRevisionRequest)
    .where(eq(sebRevisionRequest.applicationId, applicationId))
    .orderBy(asc(sebRevisionRequest.requestedAt))

/**
 * One application as its owner sees it, answers included.
 *
 * The template is resolved here rather than by the caller because three things
 * on this object are derived from it — the answers, the stages that may be
 * edited, and therefore what the client is allowed to draw — and they have to
 * agree. A template that will not resolve is an invariant failure rather than an
 * empty form: the answers exist and would silently read as unanswered.
 */
export const loadOwnedApplication = async (
  db: Database,
  userId: string,
  applicationId: string,
  includeDeleted = false,
): Promise<Application | null> => {
  const head = await findOwnedApplicationHead(db, userId, applicationId, includeDeleted)
  if (!head) return null
  const [version, documents, revisionRequests] = await Promise.all([
    findApplicationVersion(db, applicationId, head.currentVersion),
    listDocuments(db, applicationId),
    listRevisionRequests(db, applicationId),
  ])
  const current = requireInvariant(version, 'Application current version is missing.')
  const rules = requireInvariant(
    await findPinnedCycleRules(db, current.programmeCycleId, current.programmeCycleVersion),
    'The form this application was filled against could not be read.',
  )
  const rows = await findAnswerRows(db, [current.id])
  return {
    ...applicationBase(head),
    // Derived from the revision requests already read above rather than another
    // query, and from the same rule `saveApplicationDraft` enforces, so the
    // field can never invite an edit the write path would refuse.
    editableStageKeys: editableStageKeysFor(
      head.status,
      revisionRequests,
      rules.template.stages.map((stage) => stage.key),
    ),
    snapshot: snapshotFromRecord(current, answersFromRows(rules.template, current.id, rows)),
    answers: answersFromRows(rules.template, current.id, rows),
    documents,
    revisionRequests,
  }
}

/**
 * Which form stages the applicant may currently change.
 *
 * A draft is entirely open. While revision is required only the stages named by
 * unresolved requests may change, and every other status is read-only.
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
  if (status !== 'REVISION_REQUIRED') return []
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
  head: ApplicationHeadRecord,
): Promise<{ stageKeys: ApplicationSection[]; comparedToSubmissionNumber: number } | null> => {
  const [latest] = await db
    .select({
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
  const rules = await findPinnedCycleRules(
    db, current.programmeCycleId, current.programmeCycleVersion,
  )
  if (!rules) {
    return { stageKeys: [], comparedToSubmissionNumber: latest.submissionNumber }
  }
  const rows = await findAnswerRows(db, [submitted.id, current.id])
  const byVersion = answersByVersion(rules.template, rows)
  return {
    stageKeys: changedStageKeys(
      rules.template,
      byVersion.get(submitted.id) ?? {},
      byVersion.get(current.id) ?? {},
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
    applicationType?: ApplicationType | null
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
    input.applicationType ? eq(sebApplication.applicationType, input.applicationType) : undefined,
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
    })),
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor('updatedAt', last.updatedAt, last.id) : null,
      totalCount: requireInvariant(total, COUNT_MISSING).value,
    },
  }
}

/** Everything an applicant may see about a cycle. Policy rules stay internal. */
const publicProgrammeCycle = (
  row: typeof sebProgrammeCycle.$inferSelect,
): ProgrammeCycle => ({
  id: row.id,
  cycleCode: row.cycleCode,
  displayName: row.displayName,
  cycleYear: row.cycleYear,
  policyReference: row.policyReference,
  applicantGuidance: row.applicantGuidance,
  status: row.status,
  currentVersion: row.currentVersion,
  opensAt: row.opensAt,
  closesAt: row.closesAt,
})

/** Cycles a new application may be started in right now. */
export const listAvailableProgrammeCycles = async (
  db: Database,
  now: Date,
): Promise<ProgrammeCycle[]> => {
  const rows = await db
    .select()
    .from(sebProgrammeCycle)
    .where(programmeCycleOpenAt(now))
    .orderBy(asc(sebProgrammeCycle.opensAt), asc(sebProgrammeCycle.cycleCode))
  return rows.map(publicProgrammeCycle)
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
    .selectDistinct({ cycle: sebProgrammeCycle })
    .from(sebProgrammeCycle)
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
  return rows.map((row) => publicProgrammeCycle(row.cycle))
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
 * Just the address a notification goes to.
 *
 * Its own read because the alternative, `findManagedUserById`, loads a whole
 * managed-user aggregate — roles, grants, versions — to answer a question
 * asked on a best-effort path after every submission and decision. A hook
 * that exists only to send mail should not pay for, or depend on, any of
 * that.
 */
export const findUserEmailById = async (
  db: Database,
  userId: string,
): Promise<string | null> => {
  const [row] = await db
    .select({ email: coreUser.email })
    .from(coreUser)
    .where(eq(coreUser.id, userId))
    .limit(1)
  return row?.email ?? null
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

/**
 * The one enterprise fact the policy rules read: when it began trading.
 *
 * Lean by design — the validator and the category computation need this and
 * nothing else, and loading the whole enterprise for it would put a second
 * full read on every submission.
 */
export const findEnterpriseFacts = async (
  db: Database,
  enterpriseId: string,
): Promise<{ establishmentDate: string | null } | null> => {
  const [row] = await db
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
    .limit(1)
  return row ?? null
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

type EligibleAward = {
  awardId: string
  priorApplicationId: string
  priorPhaseNumber: number
  sanctionOrderNumber: string
  sanctionDate: string
  firstReleaseAt: Date
  netDisbursedPaise: number
}

type AwardCandidate = {
  awardId: string
  applicationId: string
  phaseNumber: number
  sanctionOrderNumber: string
  sanctionDate: string
}

/** Derives retained money and the first still-effective release for one award. */
const eligibleAwardFromCandidate = async (
  db: Database,
  award: AwardCandidate,
): Promise<EligibleAward | null> => {
  const entries = await db
    .select()
    .from(sebDisbursement)
    .where(eq(sebDisbursement.fundingAwardId, award.awardId))
    .orderBy(asc(sebDisbursement.occurredAt), asc(sebDisbursement.sequenceNumber))
  // Entries arrive in occurrence order, so the first retained release below is
  // the one the twelve-month expansion wait is measured from.
  const { releases, netReleasedPaise } = foldDisbursementLedger(entries)
  const firstRelease = releases.find((entry) => entry.retainedAmountPaise > 0)?.release
  if (!firstRelease) return null
  if (netReleasedPaise <= 0) return null
  return {
    awardId: award.awardId,
    priorApplicationId: award.applicationId,
    priorPhaseNumber: award.phaseNumber,
    sanctionOrderNumber: award.sanctionOrderNumber,
    sanctionDate: award.sanctionDate,
    firstReleaseAt: firstRelease.occurredAt,
    netDisbursedPaise: netReleasedPaise,
  }
}

/**
 * Finds the award an expansion could build on, or says which rule ruled it out.
 *
 * Award status is classified here rather than filtered in SQL. Filtering would
 * collapse "you have never been sanctioned", "your award is suspended", and
 * "nothing has actually been paid out" into one indistinguishable absence, and
 * those are three different things for the applicant to act on.
 */
const eligibleAwardForCase = async (
  db: Database,
  fundingCaseId: string,
): Promise<{ award: EligibleAward } | { blockedBy: ExpansionReasonCode }> => {
  const awards = await db
    .select({
      awardId: sebFundingAward.id,
      applicationId: sebFundingAward.applicationId,
      phaseNumber: sebApplication.phaseNumber,
      sanctionOrderNumber: sebFundingAward.sanctionOrderNumber,
      sanctionDate: sebFundingAward.sanctionDate,
      status: sebFundingAward.status,
    })
    .from(sebFundingAward)
    .innerJoin(sebApplication, eq(sebApplication.id, sebFundingAward.applicationId))
    .where(
      and(
        eq(sebFundingAward.fundingCaseId, fundingCaseId),
        isNull(sebFundingAward.deletedAt),
      ),
    )
    .orderBy(desc(sebApplication.phaseNumber))
  if (awards.length === 0) return { blockedBy: 'NO_QUALIFYING_AWARD' }
  const active = awards.filter((award) => award.status === 'ACTIVE')
  if (active.length === 0) return { blockedBy: 'QUALIFYING_AWARD_NOT_ACTIVE' }
  for (const award of active) {
    const eligible = await eligibleAwardFromCandidate(db, award)
    if (eligible) return { award: eligible }
  }
  // An active award exists but nothing survives its reversals, so there is no
  // release to measure the twelve-month operating period from.
  return { blockedBy: 'NO_POSITIVE_RELEASE' }
}

/**
 * Identifies one assessment group: a type, and the obligation it belongs to.
 *
 * Utilization assessments are per obligation; the others have none, and an
 * empty second half is what distinguishes them rather than a separate map.
 */
const assessmentKey = (assessmentType: string, obligationId: string | null): string =>
  `${assessmentType}:${obligationId ?? ''}`

const hasCompetingPhase = async (
  db: Database,
  fundingCaseId: string,
  phaseNumber: number,
  excludeApplicationId?: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: sebApplication.id })
    .from(sebApplication)
    .where(
      and(
        eq(sebApplication.fundingCaseId, fundingCaseId),
        eq(sebApplication.phaseNumber, phaseNumber),
        ne(sebApplication.status, 'REJECTED'),
        excludeApplicationId ? ne(sebApplication.id, excludeApplicationId) : undefined,
        isNull(sebApplication.deletedAt),
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * Applicant-safe wording for each unmet expansion rule.
 *
 * Each rule reads as its own sentence, because an applicant blocked by three
 * things needs to see three things. The messages name what is missing without
 * quoting programme-office evidence references or internal notes.
 */
const expansionReasonMessages: Record<ExpansionReasonCode, string> = {
  NO_QUALIFYING_AWARD:
    'This enterprise has no sanctioned funding award to expand from.',
  QUALIFYING_AWARD_NOT_ACTIVE:
    'The funding award for this enterprise is not active, so it cannot support an expansion.',
  NO_POSITIVE_RELEASE:
    'No funds have been released and retained under the award yet.',
  TWELVE_MONTH_WAIT_NOT_COMPLETE:
    'Twelve months of operation since the first release have not been completed yet.',
  UTILIZATION_NOT_PASSED:
    'A utilization assessment for one of your releases has not passed yet.',
  PERFORMANCE_NOT_PASSED:
    'The performance assessment for your award has not passed yet.',
  FINANCIAL_AUDIT_NOT_PASSED:
    'The financial audit for your award has not passed yet.',
  COMPETING_PHASE_APPLICATION:
    'Another application for this phase is already in progress.',
}

const expansionReason = (
  code: ExpansionReasonCode,
  obligationId: string | null = null,
): ExpansionReason => ({
  code,
  message: expansionReasonMessages[code],
  obligationId,
})

export const evaluateExpansionEligibility = async (
  db: Database,
  fundingCaseId: string,
  now: Date,
  excludeApplicationId?: string,
  targetCycleId?: string,
): Promise<{ result: ExpansionEligibility; award: EligibleAward | null }> => {
  const qualifying = await eligibleAwardForCase(db, fundingCaseId)
  if ('blockedBy' in qualifying) {
    return {
      award: null,
      result: {
        eligible: false,
        nextPhaseNumber: null,
        qualifyingAwardId: null,
        eligibleAt: null,
        reasons: [expansionReason(qualifying.blockedBy)],
      },
    }
  }
  const award = qualifying.award
  const nextPhaseNumber = award.priorPhaseNumber + 1
  const eligibleAt = addUtcCalendarMonths(award.firstReleaseAt, 12)
  const reasons: ExpansionReason[] = []
  if (now.getTime() < eligibleAt.getTime()) {
    reasons.push(expansionReason('TWELVE_MONTH_WAIT_NOT_COMPLETE'))
  }

  // The target cycle owns expansion policy. Each positively retained release
  // must have its own passing utilization result, while performance and
  // financial audit apply once to the award. We intentionally report every
  // unmet gate so the applicant can understand what remains outstanding.
  const requiredAssessments = targetCycleId
    ? await db
        .select({ type: sebProgrammeCycleAssessmentRule.assessmentType })
        .from(sebProgrammeCycleAssessmentRule)
        .innerJoin(
          sebProgrammeCycle,
          and(
            eq(sebProgrammeCycle.id, sebProgrammeCycleAssessmentRule.programmeCycleId),
            eq(
              sebProgrammeCycle.currentVersion,
              sebProgrammeCycleAssessmentRule.programmeCycleVersion,
            ),
          ),
        )
        .where(eq(sebProgrammeCycleAssessmentRule.programmeCycleId, targetCycleId))
    : [
        { type: 'UTILIZATION' as const },
        { type: 'PERFORMANCE' as const },
        { type: 'FINANCIAL_AUDIT' as const },
      ]
  const required = new Set(requiredAssessments.map((rule) => rule.type))

  /*
   * Every assessment for this award, read once.
   *
   * Each check below wants the latest assessment of one kind — utilization per
   * obligation, and one each for performance and financial audit. Asked
   * separately that is one query per obligation plus two, all of them small
   * and all of them sequential. One read ordered newest-first answers all of
   * them, because the first row seen for a group is that group's latest.
   *
   * Bounded by the same backstop every unpaginated child collection uses. An
   * award with more assessments than that is not a real one.
   */
  const assessmentRows = await db
    .select({
      assessmentType: sebAwardAssessment.assessmentType,
      obligationId: sebAwardAssessment.utilizationObligationId,
      outcome: sebAwardAssessment.outcome,
    })
    .from(sebAwardAssessment)
    .where(eq(sebAwardAssessment.fundingAwardId, award.awardId))
    .orderBy(desc(sebAwardAssessment.assessmentNumber))
    .limit(MAX_COLLECTION_ROWS)
  const latestOutcomes = new Map<string, string>()
  for (const row of assessmentRows) {
    const key = assessmentKey(row.assessmentType, row.obligationId)
    // Newest first, so the first row seen for a key is the one that counts.
    if (!latestOutcomes.has(key)) latestOutcomes.set(key, row.outcome)
  }
  if (required.has('UTILIZATION')) {
    const obligations = await db
      .select({
        id: sebUtilizationObligation.id,
        releaseId: sebUtilizationObligation.releaseDisbursementId,
      })
      .from(sebUtilizationObligation)
      .where(eq(sebUtilizationObligation.fundingAwardId, award.awardId))
    const entries = await db
      .select()
      .from(sebDisbursement)
      .where(eq(sebDisbursement.fundingAwardId, award.awardId))
    // Folded once for the whole award rather than per obligation, so the number
    // of obligations never multiplies the accounting work.
    const retainedByRelease = new Map(
      foldDisbursementLedger(entries).releases.map(
        (entry) => [entry.release.id, entry.retainedAmountPaise],
      ),
    )
    for (const obligation of obligations) {
      // The obligation has a restrictive composite foreign key to this exact
      // award/release pair, so a matching immutable release always exists.
      if (retainedByRelease.get(obligation.releaseId)! <= 0) continue
      if (latestOutcomes.get(assessmentKey('UTILIZATION', obligation.id)) !== 'PASSED') {
        reasons.push(expansionReason('UTILIZATION_NOT_PASSED', obligation.id))
      }
    }
  }
  for (const assessmentType of ['PERFORMANCE', 'FINANCIAL_AUDIT'] as const) {
    if (!required.has(assessmentType)) continue
    if (latestOutcomes.get(assessmentKey(assessmentType, null)) !== 'PASSED') {
      reasons.push(expansionReason(`${assessmentType}_NOT_PASSED`))
    }
  }
  if (await hasCompetingPhase(db, fundingCaseId, nextPhaseNumber, excludeApplicationId)) {
    reasons.push(expansionReason('COMPETING_PHASE_APPLICATION'))
  }
  return {
    award,
    result: {
      eligible: reasons.length === 0,
      nextPhaseNumber,
      qualifyingAwardId: award.awardId,
      eligibleAt,
      reasons,
    },
  }
}

export const expansionClaimFromAward = (
  award: EligibleAward,
  now: Date,
): ExpansionClaim => ({
  priorSanctionOrderNumber: award.sanctionOrderNumber,
  priorSanctionDate: award.sanctionDate,
  priorNetDisbursedAmountPaise: award.netDisbursedPaise,
  continuousOperationMonths: fullUtcCalendarMonths(award.firstReleaseAt, now),
})

export const findExpansionAwardForApplication = async (
  db: Database,
  applicationId: string,
): Promise<EligibleAward | null> => {
  const [linkedAward] = await db
    .select({
      awardId: sebFundingAward.id,
      applicationId: sebFundingAward.applicationId,
      phaseNumber: sebApplication.phaseNumber,
      sanctionOrderNumber: sebFundingAward.sanctionOrderNumber,
      sanctionDate: sebFundingAward.sanctionDate,
    })
    .from(sebApplicationQualifyingAward)
    .innerJoin(
      sebFundingAward,
      and(
        eq(sebFundingAward.id, sebApplicationQualifyingAward.currentFundingAwardId),
        eq(sebFundingAward.fundingCaseId, sebApplicationQualifyingAward.fundingCaseId),
        eq(sebFundingAward.status, 'ACTIVE'),
        isNull(sebFundingAward.deletedAt),
      ),
    )
    .innerJoin(sebApplication, eq(sebApplication.id, sebFundingAward.applicationId))
    .where(
      and(
        eq(sebApplicationQualifyingAward.applicationId, applicationId),
        eq(sebApplicationQualifyingAward.status, 'ACTIVE'),
        isNotNull(sebApplicationQualifyingAward.currentFundingAwardId),
      ),
    )
    .limit(1)
  return linkedAward ? eligibleAwardFromCandidate(db, linkedAward) : null
}

const versionValues = (input: {
  id?: string
  applicationId: string
  version: number
  programmeCycleId: string
  programmeCycleVersion: number
  applicationType: ApplicationType
  phaseNumber: number
  changeType: 'INITIAL' | 'SAVE' | 'REVISION' | 'SUBMISSION' | 'RESUBMISSION'
  changedByUserId: string
  createdAt: Date
  expansionClaim: ExpansionClaim
  declarationAcceptedAt: Date | null
  applicationCategory: 'CATEGORY_A' | 'CATEGORY_B' | null
}): typeof sebApplicationVersion.$inferInsert => ({
  id: input.id ?? crypto.randomUUID(),
  applicationId: input.applicationId,
  version: input.version,
  programmeCycleId: input.programmeCycleId,
  programmeCycleVersion: input.programmeCycleVersion,
  applicationType: input.applicationType,
  phaseNumber: input.phaseNumber,
  changeType: input.changeType,
  changeReason: null,
  changedByUserId: input.changedByUserId,
  createdAt: input.createdAt,
  // Server-owned, and never taken from the draft: these are derived from the
  // qualifying award and the ledger, and re-checked against them in the write.
  ...input.expansionClaim,
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
 * rows there are eleven columns and they are named — which removes that whole
 * class of mistake along with the columns.
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
    ${value.applicationType}, ${value.phaseNumber}, ${value.changeType},
    ${sqlNullable(value.changeReason)}, ${value.changedByUserId},
    ${value.createdAt},
    ${sqlNullable(value.priorSanctionOrderNumber)},
    ${sqlNullable(value.priorSanctionDate)},
    ${sqlNullable(value.priorNetDisbursedAmountPaise)},
    ${sqlNullable(value.continuousOperationMonths)},
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
 * Revalidates the authoritative award and ledger inside a draft/save batch.
 * Friendly controller checks explain failures; this predicate prevents an
 * award suspension, reversal, or competing phase from racing the final write.
 */
const expansionEvidenceStillCurrent = (input: {
  head: ApplicationMutationHead
  qualifyingAwardId?: string | null
  qualifyingReleaseAt?: Date | null
  expansionClaim: ExpansionClaim
  now: Date
}): SQL | undefined => {
  if (input.head.applicationType === 'INITIAL') return undefined
  const cutoff = addUtcCalendarMonths(input.now, -12)
  return sql`EXISTS (
    SELECT 1
    FROM ${sebApplicationQualifyingAward} AS qualifying_link
    INNER JOIN ${sebFundingAward} AS qualifying_award
      ON qualifying_award.id = qualifying_link.current_funding_award_id
      AND qualifying_award.funding_case_id = qualifying_link.funding_case_id
    INNER JOIN ${sebApplication} AS prior_application
      ON prior_application.id = qualifying_award.application_id
    WHERE qualifying_link.application_id = ${input.head.id}
      AND qualifying_link.funding_case_id = ${input.head.fundingCaseId}
      AND qualifying_link.status = 'ACTIVE'
      AND qualifying_link.current_funding_award_id = ${sqlNullable(input.qualifyingAwardId)}
      AND qualifying_award.status = 'ACTIVE'
      AND qualifying_award.deleted_at IS NULL
      AND qualifying_award.sanction_order_number = ${input.expansionClaim.priorSanctionOrderNumber}
      AND qualifying_award.sanction_date = ${input.expansionClaim.priorSanctionDate}
      AND prior_application.funding_case_id = ${input.head.fundingCaseId}
      AND prior_application.phase_number = ${input.head.phaseNumber - 1}
      AND (
        SELECT COALESCE(SUM(
          CASE WHEN ledger.entry_type = 'RELEASE'
            THEN ledger.amount_paise ELSE -ledger.amount_paise END
        ), 0)
        FROM ${sebDisbursement} AS ledger
        WHERE ledger.funding_award_id = qualifying_award.id
      ) = ${sqlNullable(input.expansionClaim.priorNetDisbursedAmountPaise)}
      AND (
        SELECT MIN(release.occurred_at)
        FROM ${sebDisbursement} AS release
        WHERE release.funding_award_id = qualifying_award.id
          AND release.entry_type = 'RELEASE'
          AND release.amount_paise - COALESCE((
            SELECT SUM(reversal.amount_paise)
            FROM ${sebDisbursement} AS reversal
            WHERE reversal.related_disbursement_id = release.id
              AND reversal.entry_type = 'REVERSAL'
          ), 0) > 0
      ) = ${sqlNullable(input.qualifyingReleaseAt)}
      AND EXISTS (
        SELECT 1 FROM ${sebDisbursement} AS release
        WHERE release.funding_award_id = qualifying_award.id
          AND release.entry_type = 'RELEASE'
          AND release.occurred_at <= ${cutoff}
          AND release.amount_paise - COALESCE((
            SELECT SUM(reversal.amount_paise)
            FROM ${sebDisbursement} AS reversal
            WHERE reversal.related_disbursement_id = release.id
              AND reversal.entry_type = 'REVERSAL'
          ), 0) > 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${sebApplication} AS competing_application
        WHERE competing_application.funding_case_id = ${input.head.fundingCaseId}
          AND competing_application.phase_number = ${input.head.phaseNumber}
          AND competing_application.id <> ${input.head.id}
          AND competing_application.status <> 'REJECTED'
          AND competing_application.deleted_at IS NULL
      )
  )`
}

/** Pins the exact unresolved revision-section set read by the controller. */
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
  if (input.head.status !== 'REVISION_REQUIRED') return undefined
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
    applicationType: ApplicationType
    phaseNumber: number
    /**
     * The prefilled answers, already turned into rows by the caller.
     *
     * Rows rather than an `AnswerMap`, because building them needs the pinned
     * template and the caller has already resolved it. Resolving it twice is how
     * a save and its validation come to disagree about what the form is.
     */
    answerRows: readonly AnswerRow[]
    expansionClaim: ExpansionClaim
    qualifyingAwardId?: string | null
    qualifyingReleaseAt?: Date | null
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const versionId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const eligibleReleaseCutoff = addUtcCalendarMonths(input.now, -12)

  // A rejected expansion does not permanently consume its earlier award. When
  // the applicant retries in a later cycle, the old current link is cancelled
  // in the same batch that creates the new draft and link. Capturing its version
  // here gives the batch an optimistic predicate against concurrent retries.
  const [replacedLink] = input.qualifyingAwardId
    ? await db
        .select({
          id: sebApplicationQualifyingAward.id,
          currentVersion: sebApplicationQualifyingAward.currentVersion,
        })
        .from(sebApplicationQualifyingAward)
        .innerJoin(
          sebApplication,
          eq(sebApplication.id, sebApplicationQualifyingAward.applicationId),
        )
        .where(
          and(
            eq(sebApplicationQualifyingAward.fundingCaseId, input.fundingCaseId),
            eq(sebApplicationQualifyingAward.currentFundingAwardId, input.qualifyingAwardId),
            eq(sebApplicationQualifyingAward.status, 'ACTIVE'),
            eq(sebApplication.phaseNumber, input.phaseNumber),
            eq(sebApplication.status, 'REJECTED'),
            isNull(sebApplication.deletedAt),
          ),
        )
        .orderBy(desc(sebApplication.updatedAt))
        .limit(1)
    : []
  const replacedLinkGuard = replacedLink
    ? sql`AND EXISTS (
        SELECT 1 FROM ${sebApplicationQualifyingAward}
        WHERE ${sebApplicationQualifyingAward.id} = ${replacedLink.id}
          AND ${sebApplicationQualifyingAward.currentVersion} = ${replacedLink.currentVersion}
          AND ${sebApplicationQualifyingAward.status} = 'ACTIVE'
          AND ${sebApplicationQualifyingAward.currentFundingAwardId} = ${input.qualifyingAwardId}
      )`
    : sql``
  // Do not settle for checking that the award is broadly eligible. Pin every
  // award and ledger fact copied into version 1 so a concurrent ledger change
  // cannot create a draft containing a stale eligibility snapshot.
  const awardEligibilityGuard = input.qualifyingAwardId
    ? sql`AND EXISTS (
        SELECT 1
        FROM ${sebFundingAward}
        INNER JOIN ${sebApplication} AS prior_application
          ON prior_application.id = ${sebFundingAward.applicationId}
        WHERE ${sebFundingAward.id} = ${input.qualifyingAwardId}
          AND ${sebFundingAward.fundingCaseId} = ${input.fundingCaseId}
          AND ${sebFundingAward.status} = 'ACTIVE'
          AND ${sebFundingAward.deletedAt} IS NULL
          AND ${sebFundingAward.sanctionOrderNumber} = ${input.expansionClaim.priorSanctionOrderNumber}
          AND ${sebFundingAward.sanctionDate} = ${input.expansionClaim.priorSanctionDate}
          AND prior_application.funding_case_id = ${input.fundingCaseId}
          AND prior_application.phase_number = ${input.phaseNumber - 1}
          AND (
            SELECT COALESCE(SUM(
              CASE WHEN ledger.entry_type = 'RELEASE'
                THEN ledger.amount_paise ELSE -ledger.amount_paise END
            ), 0)
            FROM ${sebDisbursement} AS ledger
            WHERE ledger.funding_award_id = ${input.qualifyingAwardId}
          ) = ${input.expansionClaim.priorNetDisbursedAmountPaise}
          AND ${input.expansionClaim.priorNetDisbursedAmountPaise} > 0
          AND (
            SELECT MIN(release.occurred_at)
            FROM ${sebDisbursement} AS release
            WHERE release.funding_award_id = ${input.qualifyingAwardId}
              AND release.entry_type = 'RELEASE'
              AND release.amount_paise - COALESCE((
                SELECT SUM(reversal.amount_paise)
                FROM ${sebDisbursement} AS reversal
                WHERE reversal.related_disbursement_id = release.id
                  AND reversal.entry_type = 'REVERSAL'
              ), 0) > 0
          ) = ${sqlNullable(input.qualifyingReleaseAt)}
          AND EXISTS (
            SELECT 1 FROM ${sebDisbursement} AS release
            WHERE release.funding_award_id = ${input.qualifyingAwardId}
              AND release.entry_type = 'RELEASE'
              AND release.occurred_at <= ${eligibleReleaseCutoff}
              AND release.amount_paise - COALESCE((
                SELECT SUM(reversal.amount_paise)
                FROM ${sebDisbursement} AS reversal
                WHERE reversal.related_disbursement_id = release.id
                  AND reversal.entry_type = 'REVERSAL'
              ), 0) > 0
          )
      )`
    : sql``
  const insertHead = db
    .insert(sebApplication)
    .select(sql`
      SELECT ${input.applicationId}, ${input.applicantUserId}, ${input.enterpriseId},
        ${input.fundingCaseId}, ${input.programmeCycleId}, ${input.applicationType},
        ${input.phaseNumber}, NULL, 1, ${input.now}, ${input.now},
        NULL, NULL, NULL, 'DRAFT', 1, ${input.now}, NULL, NULL, 0, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.fundingCaseId} = ${input.fundingCaseId}
          AND ${sebApplication.phaseNumber} = ${input.phaseNumber}
          AND ${sebApplication.status} <> 'REJECTED'
          AND ${sebApplication.deletedAt} IS NULL
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
      ${awardEligibilityGuard}
      ${replacedLinkGuard}
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
      applicationType: input.applicationType,
      phaseNumber: input.phaseNumber,
      changeType: 'INITIAL',
      changedByUserId: input.applicantUserId,
      createdAt: input.now,
      expansionClaim: input.expansionClaim,
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
      'Application draft started.', NULL, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
    )
  `)
  const insertAudit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
    )
  `)
  const statements = insertAnswers
    ? [insertHead, insertVersion, insertAnswers] as const
    : [insertHead, insertVersion] as const
  if (input.qualifyingAwardId) {
    const linkId = crypto.randomUUID()
    const cancelReplacedLink = replacedLink
      ? db
          .update(sebApplicationQualifyingAward)
          .set({
            currentFundingAwardId: null,
            status: 'CANCELLED',
            currentVersion: replacedLink.currentVersion + 1,
            updatedAt: input.now,
            cancelledAt: input.now,
            cancelledByUserId: input.applicantUserId,
            cancellationReason: 'REJECTED_APPLICATION_REPLACED',
          })
          .where(
            and(
              eq(sebApplicationQualifyingAward.id, replacedLink.id),
              eq(sebApplicationQualifyingAward.currentVersion, replacedLink.currentVersion),
              eq(sebApplicationQualifyingAward.status, 'ACTIVE'),
              sql`EXISTS (
                SELECT 1 FROM ${sebApplication}
                WHERE ${sebApplication.id} = ${input.applicationId}
              )`,
            ),
          )
      : null
    const insertReplacedLinkVersion = replacedLink
      ? db.insert(sebApplicationQualifyingAwardVersion).select(sql`
          SELECT ${crypto.randomUUID()}, ${replacedLink.id}, ${input.fundingCaseId},
            ${replacedLink.currentVersion + 1}, ${input.qualifyingAwardId},
            'CANCELLED', 'CANCELLED', 'REJECTED_APPLICATION_REPLACED',
            ${input.applicantUserId}, ${input.now}
          WHERE EXISTS (
            SELECT 1 FROM ${sebApplicationQualifyingAward}
            WHERE ${sebApplicationQualifyingAward.id} = ${replacedLink.id}
              AND ${sebApplicationQualifyingAward.currentVersion} = ${replacedLink.currentVersion + 1}
              AND ${sebApplicationQualifyingAward.status} = 'CANCELLED'
          )
        `)
      : null
    const insertLink = db.insert(sebApplicationQualifyingAward).select(sql`
      SELECT ${linkId}, ${input.applicationId}, ${input.fundingCaseId},
        ${input.qualifyingAwardId}, 'ACTIVE', 1, ${input.applicantUserId},
        ${input.now}, ${input.now}, NULL, NULL, NULL
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
      )
    `)
    const insertLinkVersion = db.insert(sebApplicationQualifyingAwardVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${linkId}, ${input.fundingCaseId}, 1,
        ${input.qualifyingAwardId}, 'ACTIVE', 'LINKED', NULL,
        ${input.applicantUserId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplicationQualifyingAward}
        WHERE ${sebApplicationQualifyingAward.id} = ${linkId}
      )
    `)
    const linkStatements = cancelReplacedLink && insertReplacedLinkVersion
      ? [cancelReplacedLink, insertReplacedLinkVersion, insertLink, insertLinkVersion] as const
      : [insertLink, insertLinkVersion] as const
    const [headResult] = await batch(db, (tx) => [
      ...statements,
      ...linkStatements,
      insertEvent,
      insertAudit,
    ])
    return headResult.length === 1
  }
  const [headResult] = await batch(db, (tx) => [...statements, insertEvent, insertAudit])
  return headResult.length === 1
}

export const saveApplicationSnapshot = async (
  db: Database,
  input: {
    head: ApplicationMutationHead
    userId: string
    /** Built by the caller from the template it validated against. */
    answerRows: readonly AnswerRow[]
    expansionClaim: ExpansionClaim
    qualifyingAwardId?: string | null
    qualifyingReleaseAt?: Date | null
    revisionStageKeys?: ApplicationSection[]
    programmeCycleVersion: number
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const nextVersion = input.head.currentVersion + 1
  const versionId = crypto.randomUUID()
  const changeType = input.head.status === 'REVISION_REQUIRED' ? 'REVISION' : 'SAVE'
  const updateHead = db
    .update(sebApplication)
    .set({ currentVersion: nextVersion, updatedAt: input.now })
    .where(
      and(
        eq(sebApplication.id, input.head.id),
        eq(sebApplication.applicantUserId, input.userId),
        eq(sebApplication.currentVersion, input.head.currentVersion),
        eq(sebApplication.statusVersion, input.head.statusVersion),
        eq(sebApplication.status, input.head.status),
        inArray(sebApplication.status, ['DRAFT', 'REVISION_REQUIRED']),
        isNull(sebApplication.deletedAt),
        expansionEvidenceStillCurrent(input),
        revisionScopeStillCurrent(input),
      ),
    )
    .returning({ id: sebApplication.id })
  const insertVersion = insertVersionWhere(
    db,
    versionValues({
      id: versionId,
      applicationId: input.head.id,
      version: nextVersion,
      programmeCycleId: input.head.programmeCycleId,
      programmeCycleVersion: input.programmeCycleVersion,
      applicationType: input.head.applicationType,
      phaseNumber: input.head.phaseNumber,
      changeType,
      changedByUserId: input.userId,
      createdAt: input.now,
      expansionClaim: input.expansionClaim,
      declarationAcceptedAt: null,
      applicationCategory: null,
    }),
    sql`${sebApplication.id} = ${input.head.id}
      AND ${sebApplication.currentVersion} = ${nextVersion}
      AND ${sebApplication.updatedAt} = ${input.now}`,
  )
  /*
   * The answers hang off the version, which hangs off the guarded update, so a
   * losing writer inserts no version and these rows have no parent to attach to
   * — the foreign key rolls the whole transition back rather than leaving a set
   * of answers pointing at nothing.
   */
  const insertAnswers = insertAnswerRows(db, {
    applicationVersionId: versionId,
    programmeCycleId: input.head.programmeCycleId,
    programmeCycleVersion: input.programmeCycleVersion,
    rows: input.answerRows,
    createdAt: input.now,
  })
  const eventValue = eventValues({
    applicationId: input.head.id,
    eventType: 'APPLICATION_SAVED',
    actorUserId: input.userId,
    applicationVersion: nextVersion,
    message: 'Application draft saved.',
    createdAt: input.now,
  })
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${eventValue.id}, ${eventValue.applicationId}, ${eventValue.eventType},
      ${eventValue.actorUserId}, ${eventValue.applicationVersion}, NULL, NULL,
      NULL, NULL, NULL, ${eventValue.message}, NULL, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.head.id}
        AND ${sebApplication.currentVersion} = ${nextVersion}
        AND ${sebApplication.updatedAt} = ${input.now}
    )
  `)
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.head.id}
        AND ${sebApplication.currentVersion} = ${nextVersion}
        AND ${sebApplication.updatedAt} = ${input.now}
    )
  `)
  const [updated] = await batch(db, () =>
    insertAnswers
      ? [updateHead, insertVersion, insertAnswers, event, audit] as const
      : [updateHead, insertVersion, event, audit] as const,
  )
  return changedExactlyOne(updated)
}

export const setApplicationDeleted = async (
  db: Database,
  input: {
    head: ApplicationHeadRecord
    userId: string
    deleted: boolean
    reason: string | null
    restoreAwardId?: string | null
    restoreAwardNetDisbursedPaise?: number | null
    restoreAwardFirstReleaseAt?: Date | null
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const [link] = await db
    .select()
    .from(sebApplicationQualifyingAward)
    .where(eq(sebApplicationQualifyingAward.applicationId, input.head.id))
    .limit(1)
  const statePredicate = input.deleted
    ? isNull(sebApplication.deletedAt)
    : isNotNull(sebApplication.deletedAt)
  // Restoring any phase must re-establish the aggregate invariants that were
  // released by deletion. This applies to INITIAL as well as EXPANSION drafts:
  // the parent enterprise/case must still be active and no replacement attempt
  // for the same phase may have become current while this draft was deleted.
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
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${sebApplication} AS competing_application
        WHERE competing_application.funding_case_id = ${input.head.fundingCaseId}
          AND competing_application.phase_number = ${input.head.phaseNumber}
          AND competing_application.id <> ${input.head.id}
          AND competing_application.status <> 'REJECTED'
          AND competing_application.deleted_at IS NULL
      )`
    : undefined
  const linkStatePredicate = input.head.applicationType === 'EXPANSION'
    ? link && (input.deleted ? link.currentFundingAwardId : input.restoreAwardId)
      ? sql`EXISTS (
          SELECT 1 FROM ${sebApplicationQualifyingAward}
          WHERE ${sebApplicationQualifyingAward.id} = ${link.id}
            AND ${sebApplicationQualifyingAward.currentVersion} = ${link.currentVersion}
            AND ${sebApplicationQualifyingAward.status} = ${input.deleted ? 'ACTIVE' : 'CANCELLED'}
            AND ${input.deleted
              ? sql`${sebApplicationQualifyingAward.currentFundingAwardId} IS NOT NULL`
              : sql`${sebApplicationQualifyingAward.currentFundingAwardId} IS NULL`}
        )`
      : sql`0 = 1`
    : undefined
  // Expansion restoration reclaims a released qualification. Matching the
  // exact net and first retained release closes the race between the friendly
  // eligibility read and this batch, including same-total ledger replacements.
  const restoreEligibilityPredicate =
    !input.deleted && input.head.applicationType === 'EXPANSION' && input.restoreAwardId
      ? sql`EXISTS (
          SELECT 1
          FROM ${sebFundingAward}
          INNER JOIN ${sebApplication} AS prior_application
            ON prior_application.id = ${sebFundingAward.applicationId}
          WHERE ${sebFundingAward.id} = ${input.restoreAwardId}
            AND ${sebFundingAward.fundingCaseId} = ${input.head.fundingCaseId}
            AND ${sebFundingAward.status} = 'ACTIVE'
            AND ${sebFundingAward.deletedAt} IS NULL
            AND prior_application.phase_number = ${input.head.phaseNumber - 1}
            AND (
              SELECT COALESCE(SUM(
                CASE WHEN ledger.entry_type = 'RELEASE'
                  THEN ledger.amount_paise ELSE -ledger.amount_paise END
              ), 0)
              FROM ${sebDisbursement} AS ledger
              WHERE ledger.funding_award_id = ${input.restoreAwardId}
            ) = ${sqlNullable(input.restoreAwardNetDisbursedPaise)}
            AND ${sqlNullable(input.restoreAwardNetDisbursedPaise)} > 0
            AND (
              SELECT MIN(release.occurred_at)
              FROM ${sebDisbursement} AS release
              WHERE release.funding_award_id = ${input.restoreAwardId}
                AND release.entry_type = 'RELEASE'
                AND release.amount_paise - COALESCE((
                  SELECT SUM(reversal.amount_paise)
                  FROM ${sebDisbursement} AS reversal
                  WHERE reversal.related_disbursement_id = release.id
                    AND reversal.entry_type = 'REVERSAL'
                ), 0) > 0
            ) = ${sqlNullable(input.restoreAwardFirstReleaseAt)}
            AND EXISTS (
              SELECT 1 FROM ${sebDisbursement} AS release
              WHERE release.funding_award_id = ${input.restoreAwardId}
                AND release.entry_type = 'RELEASE'
                AND release.occurred_at <= ${addUtcCalendarMonths(input.now, -12)}
                AND release.amount_paise - COALESCE((
                  SELECT SUM(reversal.amount_paise)
                  FROM ${sebDisbursement} AS reversal
                  WHERE reversal.related_disbursement_id = release.id
                    AND reversal.entry_type = 'REVERSAL'
                ), 0) > 0
            )
            AND NOT EXISTS (
              SELECT 1 FROM ${sebApplication} AS competing_application
              WHERE competing_application.funding_case_id = ${input.head.fundingCaseId}
                AND competing_application.phase_number = ${input.head.phaseNumber}
                AND competing_application.id <> ${input.head.id}
                AND competing_application.status <> 'REJECTED'
                AND competing_application.deleted_at IS NULL
            )
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
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.head.id}
        AND ${sebApplication.applicantUserId} = ${input.userId}
        AND ${sebApplication.currentVersion} = ${input.head.currentVersion}
        AND ${sebApplication.statusVersion} = ${input.head.statusVersion}
        AND ${sebApplication.status} = 'DRAFT'
        AND ${statePredicate}
        AND ${restoreRootEligibilityPredicate ?? sql`1 = 1`}
        AND ${linkStatePredicate ?? sql`1 = 1`}
        AND ${restoreEligibilityPredicate ?? sql`1 = 1`}
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
        linkStatePredicate,
        restoreEligibilityPredicate,
        sql`EXISTS (
          SELECT 1 FROM ${coreAuditEvent}
          WHERE ${coreAuditEvent.id} = ${input.audit.id}
        )`,
      ),
    )
  const nextLinkVersion = link ? link.currentVersion + 1 : null
  const linkAwardId = input.deleted ? link?.currentFundingAwardId : input.restoreAwardId
  const updateLink = link && linkAwardId && nextLinkVersion
    ? db
        .update(sebApplicationQualifyingAward)
        .set(
          input.deleted
            ? {
                status: 'CANCELLED',
                currentFundingAwardId: null,
                currentVersion: nextLinkVersion,
                updatedAt: input.now,
                cancelledAt: input.now,
                cancelledByUserId: input.userId,
                cancellationReason: 'APPLICATION_DRAFT_DELETED',
              }
            : {
                status: 'ACTIVE',
                currentFundingAwardId: input.restoreAwardId,
                currentVersion: nextLinkVersion,
                updatedAt: input.now,
                cancelledAt: null,
                cancelledByUserId: null,
                cancellationReason: null,
              },
        )
        .where(
          and(
            eq(sebApplicationQualifyingAward.id, link.id),
            eq(sebApplicationQualifyingAward.currentVersion, link.currentVersion),
            eq(
              sebApplicationQualifyingAward.status,
              input.deleted ? 'ACTIVE' : 'CANCELLED',
            ),
            sql`EXISTS (
              SELECT 1 FROM ${coreAuditEvent}
              WHERE ${coreAuditEvent.id} = ${input.audit.id}
            )`,
          ),
        )
    : null
  const insertLinkVersion = link && linkAwardId && nextLinkVersion
    ? db.insert(sebApplicationQualifyingAwardVersion).select(sql`
        SELECT ${crypto.randomUUID()}, ${link.id}, ${input.head.fundingCaseId},
          ${nextLinkVersion}, ${linkAwardId},
          ${input.deleted ? 'CANCELLED' : 'ACTIVE'},
          ${input.deleted ? 'CANCELLED' : 'CORRECTED'},
          ${input.deleted ? 'APPLICATION_DRAFT_DELETED' : 'APPLICATION_DRAFT_RESTORED'},
          ${input.userId}, ${input.now}
        WHERE EXISTS (
          SELECT 1 FROM ${sebApplicationQualifyingAward}
          WHERE ${sebApplicationQualifyingAward.id} = ${link.id}
            AND ${sebApplicationQualifyingAward.currentVersion} = ${nextLinkVersion}
        )
      `)
    : null
  const eventId = crypto.randomUUID()
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${eventId}, ${input.head.id},
      ${input.deleted ? 'APPLICATION_DELETED' : 'APPLICATION_RESTORED'},
      ${input.userId}, ${input.head.currentVersion}, NULL, NULL, 'DRAFT', 'DRAFT',
      NULL, ${input.deleted ? 'Application draft removed.' : 'Application draft restored.'},
      NULL, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${coreAuditEvent}
      WHERE ${coreAuditEvent.id} = ${input.audit.id}
    )
  `)
  const statements = updateLink && insertLinkVersion
    ? [audit, updateHead, updateLink, insertLinkVersion, event] as const
    : [audit, updateHead, event] as const
  const [updated] = await batch(db, () => statements)
  return changedExactlyOne(updated)
}

export const submitApplicationSnapshot = async (
  db: Database,
  input: {
    head: ApplicationMutationHead
    currentVersion: ApplicationVersionRecord
    userId: string
    /** Built by the caller from the template it validated against. */
    answerRows: readonly AnswerRow[]
    expansionClaim: ExpansionClaim
    qualifyingAwardId?: string | null
    qualifyingReleaseAt?: Date | null
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
): Promise<boolean> => {
  const nextVersion = input.head.currentVersion + 1
  const versionId = crypto.randomUUID()
  const nextStatusVersion = input.head.statusVersion + 1
  let submissionNumber = 1
  if (input.resubmission) {
    const [nextSubmission] = await db
      .select({ value: sql<number>`COALESCE(MAX(${sebApplicationSubmission.submissionNumber}), 0) + 1` })
      .from(sebApplicationSubmission)
      .where(eq(sebApplicationSubmission.applicationId, input.head.id))
    submissionNumber = requireInvariant(
      nextSubmission,
      'Submission sequence query returned no row.',
    ).value
  }
  const submissionId = crypto.randomUUID()
  // Read the logical document heads once and pin the exact versions observed.
  // Each insert below repeats the current-version predicate inside the batch,
  // so a concurrent replacement makes the entire submission fail instead of
  // silently attaching a different file from the one validated here.
  const submittedDocuments = await db
    .select({
      documentId: sebApplicationDocument.id,
      fieldKey: sebApplicationDocument.fieldKey,
      documentVersion: sebApplicationDocument.currentVersion,
    })
    .from(sebApplicationDocument)
    .where(
      and(
        eq(sebApplicationDocument.applicationId, input.head.id),
        isNull(sebApplicationDocument.deletedAt),
      ),
    )
  const cycleStillOpen = input.resubmission
    ? undefined
    : sql`EXISTS (
        SELECT 1 FROM ${sebProgrammeCycle}
        WHERE ${sebProgrammeCycle.id} = ${input.head.programmeCycleId}
          AND ${programmeCycleOpenAt(input.now)}
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
  const updateHead = db
    .update(sebApplication)
    .set({
      currentVersion: nextVersion,
      status: 'SUBMITTED',
      statusVersion: nextStatusVersion,
      referenceNumber: input.head.referenceNumber ?? input.referenceNumber,
      firstSubmittedAt: input.head.firstSubmittedAt ?? input.now,
      // A resubmission is fresh intake work. The prior reviewer remains in
      // immutable assignment history, but no longer owns the next action.
      assignedToUserId: input.resubmission ? null : undefined,
      assignedAt: input.resubmission ? null : undefined,
      assignmentVersion: input.resubmission
        ? sql`${sebApplication.assignmentVersion} + 1`
        : undefined,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebApplication.id, input.head.id),
        eq(sebApplication.applicantUserId, input.userId),
        eq(sebApplication.currentVersion, input.head.currentVersion),
        eq(sebApplication.statusVersion, input.head.statusVersion),
        eq(
          sebApplication.status,
          input.resubmission ? 'REVISION_REQUIRED' : 'DRAFT',
        ),
        isNull(sebApplication.deletedAt),
        cycleStillOpen,
        requiredDocumentsStillExist,
        expansionEvidenceStillCurrent(input),
        revisionScopeStillCurrent(input),
      ),
    )
    .returning({ id: sebApplication.id })
  const formalVersion = insertVersionWhere(
    db,
    versionValues({
      id: versionId,
      applicationId: input.head.id,
      version: nextVersion,
      programmeCycleId: input.head.programmeCycleId,
      programmeCycleVersion: input.programmeCycleVersion,
      applicationType: input.head.applicationType,
      phaseNumber: input.head.phaseNumber,
      changeType: input.resubmission ? 'RESUBMISSION' : 'SUBMISSION',
      changedByUserId: input.userId,
      createdAt: input.now,
      expansionClaim: input.expansionClaim,
      declarationAcceptedAt: input.now,
      applicationCategory: input.applicationCategory,
    }),
    sql`${sebApplication.id} = ${input.head.id}
      AND ${sebApplication.currentVersion} = ${nextVersion}
      AND ${sebApplication.statusVersion} = ${nextStatusVersion}
      AND ${sebApplication.updatedAt} = ${input.now}`,
  )
  const formalAnswers = insertAnswerRows(db, {
    applicationVersionId: versionId,
    programmeCycleId: input.head.programmeCycleId,
    programmeCycleVersion: input.programmeCycleVersion,
    rows: input.answerRows,
    createdAt: input.now,
  })
  const submission = db.insert(sebApplicationSubmission).select(sql`
    SELECT ${submissionId}, ${input.head.id}, ${submissionNumber}, ${nextVersion},
      ${input.userId}, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationVersion}
      WHERE ${sebApplicationVersion.applicationId} = ${input.head.id}
        AND ${sebApplicationVersion.version} = ${nextVersion}
    )
  `)
  const submittedDocumentPins = submittedDocuments.map((document) =>
    db.insert(sebApplicationSubmissionDocument).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.head.id}, ${submissionId},
        ${document.documentId}, ${document.documentVersion},
        ${document.fieldKey}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplicationSubmission}
        WHERE ${sebApplicationSubmission.id} = ${submissionId}
      ) AND EXISTS (
        SELECT 1 FROM ${sebApplicationDocument}
        WHERE ${sebApplicationDocument.id} = ${document.documentId}
          AND ${sebApplicationDocument.applicationId} = ${input.head.id}
          AND ${sebApplicationDocument.currentVersion} = ${document.documentVersion}
          AND ${sebApplicationDocument.deletedAt} IS NULL
      )
    `),
  )
  const resolveRevisions = db
    .update(sebRevisionRequest)
    .set({ resolvedBySubmissionId: submissionId, resolvedAt: input.now })
    .where(
      and(
        eq(sebRevisionRequest.applicationId, input.head.id),
        isNull(sebRevisionRequest.resolvedAt),
        isNull(sebRevisionRequest.cancelledAt),
        sql`EXISTS (
          SELECT 1 FROM ${sebApplicationSubmission}
          WHERE ${sebApplicationSubmission.id} = ${submissionId}
        )`,
      ),
    )
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.head.id},
      ${input.resubmission ? 'APPLICATION_RESUBMITTED' : 'APPLICATION_SUBMITTED'},
      ${input.userId}, ${nextVersion}, ${submissionId}, NULL,
      ${input.resubmission ? 'REVISION_REQUIRED' : 'DRAFT'}, 'SUBMITTED', NULL,
      ${input.resubmission ? 'Application resubmitted.' : 'Application submitted.'},
      NULL, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationSubmission}
      WHERE ${sebApplicationSubmission.id} = ${submissionId}
    )
  `)
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationSubmission}
      WHERE ${sebApplicationSubmission.id} = ${submissionId}
    )
  `)
  const answerStatements = formalAnswers ? [formalAnswers] as const : [] as const
  const statements = input.resubmission
    ? [
        updateHead,
        formalVersion,
        ...answerStatements,
        submission,
        ...submittedDocumentPins,
        resolveRevisions,
        event,
        audit,
      ] as const
    : [
        updateHead,
        formalVersion,
        ...answerStatements,
        submission,
        ...submittedDocumentPins,
        event,
        audit,
      ] as const
  const [updated] = await batch(db, () => statements)
  return changedExactlyOne(updated)
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
