/**
 * Authorization and input validation for the office's view of applications.
 *
 * This is the office-wide read side: the list every submitted application is
 * found in, one application's workspace, its documents, and the staff-only
 * notes on it. Working a file — moving it between stages, asking for
 * corrections, recording outcomes — is the pipeline's, and lives in
 * `services/pipeline`.
 *
 * Who may read which file is `stage-scope.ts`'s rule, applied here to every
 * read: `application:read` reads every submitted file, `stage:read` the files
 * at the stages one's roles own and the files one has acted on. The scope is
 * handed to the query and repeated in its SQL, so a count, a page and a single
 * file all see the same set, and a file outside it reads as not found.
 */
import { pinnedFormReader } from '../../../loaders'
import { getCurrentSession } from '../../auth'
import { holdsPermission } from '../../auth/permissions'
import { readScopeOf, type ReadScope } from '../../pipeline/queries/stage-scope'
import { storage } from '../../storage'
import { adminPageSize, decodeAdminCursor } from '../pagination'
import {
  acceptedPinnedDocument,
  insertInternalNote,
  intakeSortKey,
  listIntakeQueue,
  loadApplicationHead,
  loadWorkspace,
  type IntakeQueueFilterInput,
} from '../queries/intake'
/*
 * Re-exported so a caller naming `intakeQueue`'s input can name its shape too;
 * without this the exported signatures reference a type nothing else can reach.
 */
export type { IntakeQueueFilterInput } from '../queries/intake'
import {
  ADMIN_REQUIRED_MESSAGE,
  constraintSafe,
  normalizeRequiredText,
} from '../support'
import { failure, success } from '../../envelope'
import type { AdminOperationContext, AdminResult } from '../types'

/**
 * Refuses a filter set that cannot mean anything, naming the rule.
 *
 * Shared by the queue and the analytics summary, which accept the same filter
 * shape — a range the queue refuses must not quietly reach the summary as an
 * empty chart, or the two screens would disagree about whether the request
 * was even valid.
 */
/** What the caller may read, or null when they may read no submitted file. One session read. */
const staffScope = async (context: AdminOperationContext) => {
  const session = await getCurrentSession(context)
  const scope = session ? readScopeOf(session) : null
  return session && scope ? { session, scope } : null
}

/** A money range the queue filters on: both bounds whole paise, and not crossed. */
const rangeProblem = (min: number | null | undefined, max: number | null | undefined): boolean =>
  [min, max].some((bound) => bound !== null && bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0))
  || (min != null && max != null && max < min)

export const intakeFilterProblem = (
  input: IntakeQueueFilterInput,
): string | null => {
  if (input.phaseNumber !== null && input.phaseNumber !== undefined && input.phaseNumber < 1) {
    return 'Phase number must be positive.'
  }
  if (input.submittedFrom && input.submittedTo && input.submittedTo < input.submittedFrom) {
    return 'The submission date range is invalid.'
  }
  // The scalar already refuses negatives and fractions; what only this layer
  // can see is the two bounds crossing, and a direct caller sending junk.
  if (rangeProblem(input.requestedMinPaise, input.requestedMaxPaise)) {
    return 'The requested amount range is invalid.'
  }
  if (rangeProblem(input.loanRequestedMinPaise, input.loanRequestedMaxPaise)) {
    return 'The requested loan range is invalid.'
  }
  if (input.stageKeys?.length && !input.pipelineId) {
    return 'Choose the pipeline the stages belong to.'
  }
  if ((input.flags?.length ?? 0) > 8) return 'Filter by at most 8 status flags.'
  return null
}

export const intakeQueue = async (
  input: IntakeQueueFilterInput & {
    first?: number | null
    after?: string | null
    order?: 'OLDEST_WAITING' | 'NEWEST_SUBMISSION' | 'LAST_ACTIVITY' | null
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const reader = await staffScope(context)
  if (!reader) return failure(ADMIN_REQUIRED_MESSAGE)
  const problem = intakeFilterProblem(input)
  if (problem) return failure(problem)
  const first = adminPageSize(input.first)
  const after = decodeAdminCursor(input.after, intakeSortKey(input.order))
  if (!first || after === 'INVALID') return failure('Invalid pagination arguments.')
  return success(await listIntakeQueue(context.db, { ...input, first, after, scope: reader.scope }))
}

export const intakeByReference = async (
  referenceNumber: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const reader = await staffScope(context)
  if (!reader) return failure(ADMIN_REQUIRED_MESSAGE)
  const normalized = normalizeRequiredText(referenceNumber, 64)
  if (!normalized) return failure('Enter an application reference number.')
  const result = await listIntakeQueue(context.db, {
    first: 1,
    after: null,
    referenceNumber: normalized,
    scope: reader.scope,
  })
  const application = result.nodes[0]
  return application ? success(application) : failure('The application was not found.')
}

export const intakeWorkspace = async (
  applicationId: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const reader = await staffScope(context)
  if (!reader) return failure(ADMIN_REQUIRED_MESSAGE)
  const workspace = await loadWorkspace(context.db, pinnedFormReader(context.loaders), applicationId, reader.scope)
  return workspace ? success(workspace) : failure('The application was not found.')
}

/**
 * The reader and the application they named, or the refusal.
 *
 * A file outside the reader's scope and one that does not exist are refused
 * identically, with the caller's own message, so probing identifiers reveals
 * nothing about which files exist.
 */
const readerWithApplication = async (
  context: AdminOperationContext,
  applicationId: string,
  notFoundMessage: string,
): Promise<
  | { scope: ReadScope; head: NonNullable<Awaited<ReturnType<typeof loadApplicationHead>>> }
  | { refusal: AdminResult<never> }
> => {
  const reader = await staffScope(context)
  if (!reader) return { refusal: failure(ADMIN_REQUIRED_MESSAGE) }
  const head = await loadApplicationHead(context.db, applicationId, reader.scope)
  if (!head) return { refusal: failure(notFoundMessage) }
  return { scope: reader.scope, head }
}

export const addInternalNote = async (
  input: { applicationId: string; note: string; correctionOfNoteId?: string | null },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const session = await getCurrentSession(context)
  const scope = session ? readScopeOf(session) : null
  if (!session || !scope || !holdsPermission(session, 'application', 'note')) return failure(ADMIN_REQUIRED_MESSAGE)
  const note = normalizeRequiredText(input.note, 5_000)
  if (!note) return failure('Enter an internal note.')
  const inserted = await constraintSafe(() => insertInternalNote(context, {
    ...input,
    note,
    actorUserId: session.user.id,
    now: new Date(),
    scope,
  }))
  return inserted
    ? success(await loadWorkspace(context.db, pinnedFormReader(context.loaders), input.applicationId, scope))
    : failure('The note could not be added.')
}

export const adminDocumentDownloadUrl = async (
  input: { applicationId: string; submissionDocumentId: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  // A missing application and a draft are refused identically, so probing IDs
  // cannot reveal which drafts or applications exist.
  const authorized = await readerWithApplication(context, input.applicationId, 'The application was not found.')
  if ('refusal' in authorized) return authorized.refusal
  /*
   * Deliberately not gated on holding the file.
   *
   * This is a read, and tying a read to ownership was the wrong shape: a
   * reviewer exists to read casework, could never have held a file, and so
   * could never open a single piece of the evidence they were meant to review.
   *
   * The ownership check was also doing a second job, and that job still has to
   * be done: a **draft** has no assignee, so refusing on ownership refused
   * drafts too. A draft has never been submitted and must stay invisible, so
   * it is refused here explicitly and identically to an application that does
   * not exist.
   *
   * Submitted applications are deliberately *not* hidden from each other: a
   * staff member can already list every one of them in the queue, so refusing
   * differently would conceal nothing and only make the message less true.
   */
  if (authorized.head.application.status === 'DRAFT') {
    return failure('The application was not found.')
  }
  const document = await acceptedPinnedDocument(context.db, input)
  if (!document) return failure('The submitted document has not passed malware scanning.')
  return success(await storage(context.env, context.requestUrl).authorizeDownload(
    document.file.r2ObjectKey,
    document.file.originalFilename,
    new Date(),
  ))
}
