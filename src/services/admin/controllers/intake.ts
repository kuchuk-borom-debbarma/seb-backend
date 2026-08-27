/**
 * Authorization and input validation for intake and desk review.
 *
 * Nothing is reserved before it is worked on. Holding the right capability is
 * what permits an action, and the version term inside each write predicate is
 * what settles two officers acting at once — so the refusals decided here
 * explain which rule stopped somebody, while the predicates in
 * `queries/intake.ts` decide concurrent attempts.
 *
 * The assignment columns survive as a record of who worked a file last, written
 * as a side effect of the work itself. They are advisory and never gate
 * anything: gating a *read* on them is what once left reviewers, whose whole
 * job is reading casework, unable to open a single document.
 */
import { deskReviewChecks } from '../../../db/schema'
import type { Capability } from '../../auth'
import { storage } from '../../storage'
import { adminPageSize, decodeAdminCursor } from '../pagination'
import {
  acceptedPinnedDocument,
  findIdentifierRules,
  approvedReason,
  cancelRevisionRequestWrite,
  completeDeskReviewWrite,
  identifierMatches,
  insertInternalNote,
  intakeQueueSummary,
  intakeSortKey,
  latestSubmission,
  listIntakeQueue,
  loadApplicationHead,
  loadWorkspace,
  startDeskReviewWrite,
  unacceptedSubmissionDocumentCount,
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
  authorizeReasonedTransition,
  currentStaff,
  SELF_REVIEW_MESSAGE,
  undisclosedSelfReview,
  normalizeRequiredText,
  STALE_MESSAGE,
} from '../support'
import { revisionRequestProblem } from '../revisions'
import { failure, success } from '../../envelope'
import {
  IDENTIFIER_FOR_CHECK,
  bankDestination,
  lastFourOf,
  normalizeIdentifier,
  storedValue,
  type IdentifierKind,
} from '../identifiers'
import type {
  AdminOperationContext,
  IntakeQueueKey,
  AdminResult,
  DeskReviewCheckInput,
  IdentifierRule,
  DeskReviewIdentifierInput,
  DeskReviewOutcome,
  RevisionRequestInput,
} from '../types'

/**
 * Refuses a filter set that cannot mean anything, naming the rule.
 *
 * Shared by the queue and the analytics summary, which accept the same filter
 * shape — a range the queue refuses must not quietly reach the summary as an
 * empty chart, or the two screens would disagree about whether the request
 * was even valid.
 */
export const intakeFilterProblem = (
  input: IntakeQueueFilterInput,
): string | null => {
  // Two named queues are subsets of one status, so combining the filters could
  // silently return an empty page instead of the queue that was asked for.
  // Refusing says which one to drop rather than leaving the caller guessing.
  if (input.queue && (input.status || input.statuses?.length)) {
    return 'Filter by queue or by status, not both.'
  }
  if (input.phaseNumber !== null && input.phaseNumber !== undefined && input.phaseNumber < 1) {
    return 'Phase number must be positive.'
  }
  if (input.submittedFrom && input.submittedTo && input.submittedTo < input.submittedFrom) {
    return 'The submission date range is invalid.'
  }
  if (input.decidedFrom && input.decidedTo && input.decidedTo < input.decidedFrom) {
    return 'The decision date range is invalid.'
  }
  // The scalar already refuses negatives and fractions; what only this layer
  // can see is the two bounds crossing, and a direct caller sending junk.
  for (const bound of [input.requestedMinPaise, input.requestedMaxPaise]) {
    if (bound !== null && bound !== undefined
      && (!Number.isSafeInteger(bound) || bound < 0)) {
      return 'The requested amount range is invalid.'
    }
  }
  if (input.requestedMinPaise != null && input.requestedMaxPaise != null
    && input.requestedMaxPaise < input.requestedMinPaise) {
    return 'The requested amount range is invalid.'
  }
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
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const problem = intakeFilterProblem(input)
  if (problem) return failure(problem)
  const first = adminPageSize(input.first)
  const after = decodeAdminCursor(input.after, intakeSortKey(input.order))
  if (!first || after === 'INVALID') return failure('Invalid pagination arguments.')
  return success(await listIntakeQueue(context.db, { ...input, first, after }))
}

/** Counts for the queue chips; the same rules the queue list itself applies. */
export const intakeQueues = async (
  cycleId: string | null | undefined,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  return success({ queues: await intakeQueueSummary(context.db, cycleId) })
}

export const intakeByReference = async (
  referenceNumber: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const normalized = normalizeRequiredText(referenceNumber, 64)
  if (!normalized) return failure('Enter an application reference number.')
  const result = await listIntakeQueue(context.db, {
    first: 1,
    after: null,
    referenceNumber: normalized,
  })
  const application = result.nodes[0]
  return application ? success(application) : failure('The application was not found.')
}

export const intakeWorkspace = async (
  applicationId: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const workspace = await loadWorkspace(context.db, applicationId)
  return workspace ? success(workspace) : failure('The application was not found.')
}

/**
 * Authorizes an administrator and loads the application they named.
 *
 * Callers keep their own extra condition — assignment, lifecycle state — since
 * those genuinely differ, and supply the refusal for a missing application so
 * it stays indistinguishable from failing their own condition. A reviewer must
 * not be able to tell an unsubmitted draft from an ID that was never real.
 */
/*
 * The capability is the caller's to state, not this helper's to assume.
 *
 * It once served both a read and a write while naming a capability itself, so
 * the write silently inherited the read's answer and a reviewer — who may
 * change nothing — could reach it. A shared preamble must never decide
 * authority on behalf of operations that do different things.
 */
const administratorWithApplication = async (
  context: AdminOperationContext,
  capability: Capability,
  applicationId: string,
  notFoundMessage: string,
): Promise<
  | { administrator: { id: string }; head: NonNullable<Awaited<ReturnType<typeof loadApplicationHead>>> }
  | { refusal: AdminResult<never> }
> => {
  const administrator = await currentStaff(context, capability)
  if (!administrator) return { refusal: failure(ADMIN_REQUIRED_MESSAGE) }
  const head = await loadApplicationHead(context.db, applicationId)
  if (!head) return { refusal: failure(notFoundMessage) }
  return { administrator, head }
}

export const addInternalNote = async (
  input: { applicationId: string; note: string; correctionOfNoteId?: string | null },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const note = normalizeRequiredText(input.note, 5_000)
  if (!note) return failure('Enter an internal note.')
  const inserted = await constraintSafe(() => insertInternalNote(context, {
    ...input,
    note,
    actorUserId: administrator.id,
    now: new Date(),
  }))
  return inserted
    ? success(await loadWorkspace(context.db, input.applicationId))
    : failure('The note could not be added.')
}

export const startDeskReview = async (
  input: { applicationId: string; expectedStatusVersion: number },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const changed = await constraintSafe(() => startDeskReviewWrite(context, {
    ...input,
    actorUserId: administrator.id,
    now: new Date(),
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success((await loadApplicationHead(context.db, input.applicationId))?.application)
}

const validateReviewChecks = (
  checks: DeskReviewCheckInput[],
  expansion: boolean,
): string | null => {
  if (
    checks.length !== deskReviewChecks.length ||
    new Set(checks.map((check) => check.checkType)).size !== deskReviewChecks.length ||
    deskReviewChecks.some((checkType) => !checks.some((check) => check.checkType === checkType))
  ) return 'Provide exactly one result for every desk-review check.'
  const expansionCheck = checks.find((check) => check.checkType === 'EXPANSION_EVIDENCE')
  if (!expansion && expansionCheck?.result !== 'NOT_APPLICABLE') {
    return 'Expansion evidence must be not applicable for an initial application.'
  }
  if (expansion && expansionCheck?.result === 'NOT_APPLICABLE') {
    return 'Expansion evidence must be checked for an expansion application.'
  }
  if (checks.some((check) => (check.internalNote?.trim().length ?? 0) > 2_000)) {
    return 'A checklist note is too long.'
  }
  return null
}

/** What each identifier is called when a refusal has to name one. */
const IDENTIFIER_LABELS: Record<IdentifierKind, string> = {
  ST_CERTIFICATE: 'Scheduled Tribe certificate number',
  IDENTITY_DOCUMENT: 'identity document number',
  BANK_ACCOUNT: 'bank account number and branch code',
  BUSINESS_REGISTRATION: 'business registration number',
}

/**
 * Turns what the reviewer typed into what the database compares.
 *
 * A check that was passed asks for the number on the document behind it; a
 * check that failed or does not apply asks for nothing, because there is
 * nothing being attested to. Business registration is never required — an
 * unregistered enterprise has none, and demanding one would make somebody
 * invent a number to get past the form.
 *
 * Returns a refusal message, or the values ready to be compared and stored.
 */
const readIdentifiers = async (
  input: { checks: DeskReviewCheckInput[]; identifiers: DeskReviewIdentifierInput[] },
  context: AdminOperationContext,
  rules: IdentifierRule[],
): Promise<string | {
  stored: { kind: IdentifierKind; comparableValue: string; lastFour: string }[]
  compared: { kind: IdentifierKind; comparableValue: string }[]
}> => {
  const given = new Map(input.identifiers.map((entry) => [entry.kind, entry]))
  if (given.size !== input.identifiers.length) {
    return 'Each identifier may be given once.'
  }

  const byKind = new Map(rules.map((rule) => [rule.kind, rule]))
  const passed = new Set(
    input.checks.filter((check) => check.result === 'PASS').map((check) => check.checkType),
  )

  /*
   * An explicit `OFF` is refused; no rule at all is not.
   *
   * The two mean different things. `OFF` is somebody deciding this cycle does
   * not collect that number, so accepting one anyway would store what the
   * policy says not to hold. Silence means the cycle predates these rules or
   * has not configured them, and refusing there would break every open cycle
   * on the day this shipped.
   *
   * Refusing rather than dropping, because silently ignoring a value leaves
   * the reviewer believing they recorded something — and the difference only
   * surfaces later, when somebody asks which certificate was seen.
   */
  for (const kind of given.keys()) {
    if (byKind.get(kind)?.requirement === 'OFF') {
      return `This programme cycle does not collect the ${IDENTIFIER_LABELS[kind]}.`
    }
  }

  const stored: { kind: IdentifierKind; comparableValue: string; lastFour: string }[] = []
  const compared: { kind: IdentifierKind; comparableValue: string }[] = []
  for (const [kind, entry] of given) {
    /*
     * An account number and a branch code identify a destination only together,
     * so they are folded into one value. The last four shown back are the
     * account's, because that is what a person checks against a passbook.
     */
    const digits = normalizeIdentifier(entry.value)
    const comparable = kind === 'BANK_ACCOUNT'
      ? bankDestination(entry.value, entry.branchCode ?? '')
      : digits
    if (!digits || !comparable) {
      return `Enter the ${IDENTIFIER_LABELS[kind]} exactly as it appears.`
    }
    const comparableValue = await storedValue(kind, comparable, context.env)
    stored.push({ kind, comparableValue, lastFour: lastFourOf(digits) })
    // Only what the cycle asks to be compared is ever queried, so turning a
    // kind's duplicate check off removes work rather than adding a flag.
    if (byKind.get(kind)?.duplicatePolicy === 'CHECKED') {
      compared.push({ kind, comparableValue })
    }
  }

  const missing = rules
    .filter((rule) =>
      rule.requirement === 'REQUIRED_ON_PASS' &&
      rule.checkType !== null &&
      passed.has(rule.checkType as DeskReviewCheckInput['checkType']) &&
      !given.has(rule.kind))
    .map((rule) => rule.kind)
  if (missing.length > 0) {
    return `Passing this check means reading the document: enter the ${
      missing.map((kind) => IDENTIFIER_LABELS[kind]).join(' and the ')
    }.`
  }
  return { stored, compared }
}

const validateAdvanceOutcome = async (
  context: AdminOperationContext,
  input: {
    checks: DeskReviewCheckInput[]
    revisions: RevisionRequestInput[]
    reasonCategoryId?: string | null
    applicantMessage?: string | null
  },
  applicationType: 'INITIAL' | 'EXPANSION',
  submissionId: string,
): Promise<string | null> => {
  /*
   * An advancement carries neither, and `seb_desk_review_reason_check` has
   * always said so — but nothing here did, so the refusal came from the
   * database and reached the officer as "The record changed. Reload and try
   * again." Reloading never helped, because nothing had changed.
   *
   * The rule this restores is the repository's own: the query is the
   * correctness, and the controller is the sentence that explains it.
   */
  if (input.reasonCategoryId || normalizeRequiredText(input.applicantMessage ?? '', 1_000)) {
    return 'Advancement to the bank carries no reason and no message to the applicant.'
  }
  const hasNonPassingCheck = input.checks.some((check) =>
    check.checkType === 'EXPANSION_EVIDENCE' && applicationType === 'INITIAL'
      ? check.result !== 'NOT_APPLICABLE'
      : check.result !== 'PASS',
  )
  if (hasNonPassingCheck) return 'Every applicable check must pass before bank evaluation.'
  if (await unacceptedSubmissionDocumentCount(context.db, submissionId) > 0) {
    return 'Every submitted document must pass malware scanning first.'
  }
  return input.revisions.length === 0 ? null : 'Advancement cannot include revision requests.'
}

const validateOutcomeReason = async (
  context: AdminOperationContext,
  input: {
    outcome: DeskReviewOutcome
    reasonCategoryId?: string | null
    applicantMessage?: string | null
  },
  cycleId: string,
  cycleVersion: number,
): Promise<string | null> => {
  const reasonContext = input.outcome === 'REJECT' ? 'REJECTION' : 'REVISION'
  if (!input.reasonCategoryId || !await approvedReason(context.db, {
    id: input.reasonCategoryId,
    cycleId,
    version: cycleVersion,
    context: reasonContext,
  })) return 'Select an approved outcome reason.'
  return normalizeRequiredText(input.applicantMessage ?? '', 1_000)
    ? null : 'Enter an applicant-safe explanation.'
}

export const completeDeskReview = async (
  input: {
    applicationId: string
    expectedStatusVersion: number
    outcome: DeskReviewOutcome
    checks: DeskReviewCheckInput[]
    reasonCategoryId?: string | null
    applicantMessage?: string | null
    revisions: RevisionRequestInput[]
    identifiers: DeskReviewIdentifierInput[]
    /** Only somebody reviewing their own application needs to send this. */
    conflictAcknowledged?: boolean | null
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const head = await loadApplicationHead(context.db, input.applicationId)
  const submission = await latestSubmission(context.db, input.applicationId)
  if (!head || !submission) return failure('The submitted application was not found.')
  // Completing a review is where the judgement lands, so it is where reviewing
  // your own application has to be disclosed.
  if (undisclosedSelfReview(
    head.application.applicantUserId, administrator.id, input.conflictAcknowledged,
  )) return failure(SELF_REVIEW_MESSAGE)
  const checkProblem = validateReviewChecks(
    input.checks,
    head.application.applicationType === 'EXPANSION',
  )
  if (checkProblem) return failure(checkProblem)
  const cycleId = submission.snapshot.programmeCycleId
  const cycleVersion = submission.snapshot.programmeCycleVersion
  const outcomeProblem = input.outcome === 'ADVANCE_TO_BANK'
    ? await validateAdvanceOutcome(
        context,
        input,
        head.application.applicationType,
        submission.submission.id,
      )
    : await validateOutcomeReason(context, input, cycleId, cycleVersion)
  if (outcomeProblem) return failure(outcomeProblem)
  /*
   * The same rules the decision and bank paths apply, from the same function.
   *
   * This used to be a fifth copy, and it was **missing the one rule that says a
   * stage must be one the cycle's form actually has**. A review requesting a
   * revision on a stage the template does not declare left the applicant unable
   * to save or resubmit — the scope intersected with nothing — and told them the
   * application had changed on every attempt.
   */
  const revisionProblem = await revisionRequestProblem(context, {
    carriesRevisions: input.outcome === 'REQUEST_REVISION',
    revisions: input.revisions,
    cycleId,
    cycleVersion,
    maximum: 6,
    stagesMessage: 'Provide one to six editable-stage revision requests, '
      + 'each on a stage this application\u2019s form has.',
    instructionMessage: 'Every revision needs an approved reason and safe instruction.',
    unexpectedMessage: 'This outcome cannot include revision requests.',
  })
  if (revisionProblem) return failure(revisionProblem)

  /*
   * One extra read on this path, and it is one rather than none.
   *
   * The frozen document rules are read by `findSubmissionPolicy`, which is the
   * applicant's submission check and is not consulted here — so there is no
   * existing batch to join. The head and the submission above are both joined
   * reads and cannot be batched together either, because a batch maps results
   * by column name and both carry an `id`.
   *
   * It is a small seek on a composite key returning at most four rows, on a
   * path that already spends several.
   */
  const rules = await findIdentifierRules(context.db, cycleId, cycleVersion)
  const read = await readIdentifiers(input, context, rules)
  if (typeof read === 'string') return failure(read)

  /*
   * A value already recorded against another funding case is a question, not a
   * verdict. The same promoter legitimately returns for a second phase, and a
   * hard refusal would block real work — so the reviewer answers it, and the
   * answer is kept beside the number that raised it.
   */
  const matches = await identifierMatches(
    context.db, head.application.fundingCaseId, read.compared,
  )
  const answers = new Map<IdentifierKind, string>()
  for (const [kind, reference] of matches) {
    const given = input.identifiers.find((entry) => entry.kind === kind)
    const answer = normalizeRequiredText(given?.matchedReason ?? '', 1_000)
    if (!answer) {
      return failure(
        `That ${IDENTIFIER_LABELS[kind]} is already recorded against ${reference}. `
        + 'Say why this is not the same claim, or fail the check.',
      )
    }
    answers.set(kind, answer)
  }

  const changed = await constraintSafe(() => completeDeskReviewWrite(context, {
    ...input,
    identifiers: read.stored.map((entry) => ({
      ...entry,
      matchedReason: answers.get(entry.kind) ?? null,
    })),
    fundingCaseId: head.application.fundingCaseId,
    submissionId: submission.submission.id,
    actorUserId: administrator.id,
    applicantMessage: input.applicantMessage?.trim() ?? null,
    now: new Date(),
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success(await loadWorkspace(context.db, input.applicationId))
}

export const cancelRevisionRequest = async (
  input: {
    applicationId: string
    revisionRequestId: string
    expectedStatusVersion: number
    reason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const authorized = await authorizeReasonedTransition(
    context,
    'STAFF_WRITE',
    { reason: input.reason, expectedVersion: input.expectedStatusVersion },
    'Enter a valid cancellation reason and expected version.',
  )
  if ('refusal' in authorized) return authorized.refusal
  const changed = await constraintSafe(() => cancelRevisionRequestWrite(context, {
    ...input,
    reason: authorized.reason,
    actorUserId: authorized.actorId,
    now: new Date(),
  }))
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const adminDocumentDownloadUrl = async (
  input: { applicationId: string; submissionDocumentId: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  // A missing application and a draft are refused identically, so probing IDs
  // cannot reveal which drafts or applications exist.
  const authorized = await administratorWithApplication(
    context,
    'STAFF_READ',
    input.applicationId,
    'The application was not found.',
  )
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
