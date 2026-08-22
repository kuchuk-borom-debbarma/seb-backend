import { deskReviewChecks } from '../../../db/schema'
import { createDownloadAuthorization } from '../../application/uploads'
import { adminPageSize, decodeAdminCursor } from '../pagination'
import {
  acceptedPinnedDocument,
  approvedReason,
  cancelRevisionRequestWrite,
  changeAssignment,
  completeDeskReviewWrite,
  insertInternalNote,
  intakeQueueSummary,
  latestSubmission,
  listIntakeQueue,
  loadApplicationHead,
  loadWorkspace,
  startDeskReviewWrite,
  unacceptedSubmissionDocumentCount,
} from '../queries/intake'
import {
  ADMIN_REQUIRED_MESSAGE,
  constraintSafe,
  authorizeReasonedTransition,
  currentAdministrator,
  failure,
  normalizeRequiredText,
  STALE_MESSAGE,
  success,
} from '../support'
import type {
  AdminOperationContext,
  IntakeQueueKey,
  AdminResult,
  DeskReviewCheckInput,
  DeskReviewOutcome,
  RevisionRequestInput,
} from '../types'

export const intakeQueue = async (
  input: {
    first?: number | null
    after?: string | null
    cycleId?: string | null
    status?: Parameters<typeof listIntakeQueue>[1]['status']
    phaseNumber?: number | null
    applicationType?: Parameters<typeof listIntakeQueue>[1]['applicationType']
    assigneeUserId?: string | null
    referenceNumber?: string | null
    sector?: string | null
    category?: Parameters<typeof listIntakeQueue>[1]['category']
    submittedFrom?: Date | null
    submittedTo?: Date | null
    order?: 'OLDEST_WAITING' | 'NEWEST_SUBMISSION' | 'LAST_ACTIVITY' | null
    queue?: IntakeQueueKey | null
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentAdministrator(context)) return failure(ADMIN_REQUIRED_MESSAGE)
  // Two named queues are subsets of one status, so combining the filters could
  // silently return an empty page instead of the queue that was asked for.
  // Refusing says which one to drop rather than leaving the caller guessing.
  if (input.queue && input.status) {
    return failure('Filter by queue or by status, not both.')
  }
  const first = adminPageSize(input.first)
  const after = decodeAdminCursor(input.after)
  if (!first || after === 'INVALID') return failure('Invalid pagination arguments.')
  if (input.phaseNumber !== null && input.phaseNumber !== undefined && input.phaseNumber < 1) {
    return failure('Phase number must be positive.')
  }
  if (input.submittedFrom && input.submittedTo && input.submittedTo < input.submittedFrom) {
    return failure('The submission date range is invalid.')
  }
  return success(await listIntakeQueue(context.db, { ...input, first, after }))
}

/** Counts for the queue chips; the same rules the queue list itself applies. */
export const intakeQueues = async (
  cycleId: string | null | undefined,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentAdministrator(context)) return failure(ADMIN_REQUIRED_MESSAGE)
  return success({ queues: await intakeQueueSummary(context.db, cycleId) })
}

export const intakeByReference = async (
  referenceNumber: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentAdministrator(context)) return failure(ADMIN_REQUIRED_MESSAGE)
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
  if (!await currentAdministrator(context)) return failure(ADMIN_REQUIRED_MESSAGE)
  const workspace = await loadWorkspace(context.db, applicationId)
  return workspace ? success(workspace) : failure('The application was not found.')
}

const reasonForApplication = async (
  context: AdminOperationContext,
  input: { applicationId: string; reasonCategoryId: string; reasonContext: string },
) => {
  const submission = await latestSubmission(context.db, input.applicationId)
  if (!submission) return null
  return approvedReason(context.db, {
    id: input.reasonCategoryId,
    cycleId: submission.snapshot.programmeCycleId,
    version: submission.snapshot.programmeCycleVersion,
    context: input.reasonContext,
  })
}

/**
 * Authorizes an administrator and loads the application they named.
 *
 * Callers keep their own extra condition — assignment, lifecycle state — since
 * those genuinely differ, and supply the refusal for a missing application so
 * it stays indistinguishable from failing their own condition. A reviewer must
 * not be able to tell an unsubmitted draft from an ID that was never real.
 */
const administratorWithApplication = async (
  context: AdminOperationContext,
  applicationId: string,
  notFoundMessage: string,
): Promise<
  | { administrator: { id: string }; head: NonNullable<Awaited<ReturnType<typeof loadApplicationHead>>> }
  | { refusal: AdminResult<never> }
> => {
  const administrator = await currentAdministrator(context)
  if (!administrator) return { refusal: failure(ADMIN_REQUIRED_MESSAGE) }
  const head = await loadApplicationHead(context.db, applicationId)
  if (!head) return { refusal: failure(notFoundMessage) }
  return { administrator, head }
}

export const claimApplication = async (
  input: {
    applicationId: string
    expectedAssignmentVersion: number
    conflictAcknowledged: boolean
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const authorized = await administratorWithApplication(
    context, input.applicationId, 'The application was not found.',
  )
  if ('refusal' in authorized) return authorized.refusal
  const { administrator, head } = authorized
  // A draft has never been submitted, so it must stay invisible to reviewers.
  if (head.application.status === 'DRAFT') return failure('The application was not found.')
  if (head.application.applicantUserId === administrator.id && !input.conflictAcknowledged) {
    return failure('Acknowledge that you are acting on your own application.')
  }
  const changed = await constraintSafe(() => changeAssignment(context, {
    applicationId: input.applicationId,
    actorUserId: administrator.id,
    expectedVersion: input.expectedAssignmentVersion,
    fromUserId: null,
    toUserId: administrator.id,
    eventType: 'CLAIMED',
    conflictAcknowledged: input.conflictAcknowledged,
    now: new Date(),
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success((await loadApplicationHead(context.db, input.applicationId))?.application)
}

export const releaseApplication = async (
  input: {
    applicationId: string
    expectedAssignmentVersion: number
    reasonCategoryId: string
    reason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentAdministrator(context)
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 500)
  if (!reason || !await reasonForApplication(context, {
    applicationId: input.applicationId,
    reasonCategoryId: input.reasonCategoryId,
    reasonContext: 'ASSIGNMENT_RELEASE',
  })) return failure('Select an approved release reason and enter an explanation.')
  const changed = await constraintSafe(() => changeAssignment(context, {
    applicationId: input.applicationId,
    actorUserId: administrator.id,
    expectedVersion: input.expectedAssignmentVersion,
    fromUserId: administrator.id,
    toUserId: null,
    eventType: 'RELEASED',
    reasonCategoryId: input.reasonCategoryId,
    reason,
    conflictAcknowledged: false,
    now: new Date(),
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success((await loadApplicationHead(context.db, input.applicationId))?.application)
}

export const reassignApplication = async (
  input: {
    applicationId: string
    expectedAssignmentVersion: number
    toUserId: string
    reasonCategoryId: string
    reason: string
    conflictAcknowledged: boolean
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentAdministrator(context)
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const head = await loadApplicationHead(context.db, input.applicationId)
  const reason = normalizeRequiredText(input.reason, 500)
  if (!head?.application.assignedToUserId || !reason || !await reasonForApplication(context, {
    applicationId: input.applicationId,
    reasonCategoryId: input.reasonCategoryId,
    reasonContext: 'ASSIGNMENT_REASSIGN',
  })) return failure('Select an approved reassignment reason and enter an explanation.')
  if (head.application.applicantUserId === input.toUserId && !input.conflictAcknowledged) {
    return failure('Acknowledge that the new assignee owns this application.')
  }
  const changed = await constraintSafe(() => changeAssignment(context, {
    applicationId: input.applicationId,
    actorUserId: administrator.id,
    expectedVersion: input.expectedAssignmentVersion,
    fromUserId: head.application.assignedToUserId,
    toUserId: input.toUserId,
    eventType: 'REASSIGNED',
    reasonCategoryId: input.reasonCategoryId,
    reason,
    conflictAcknowledged: input.conflictAcknowledged,
    now: new Date(),
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success((await loadApplicationHead(context.db, input.applicationId))?.application)
}

export const addInternalNote = async (
  input: { applicationId: string; note: string; correctionOfNoteId?: string | null },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentAdministrator(context)
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
  const administrator = await currentAdministrator(context)
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

const validateAdvanceOutcome = async (
  context: AdminOperationContext,
  input: { checks: DeskReviewCheckInput[]; revisions: RevisionRequestInput[] },
  applicationType: 'INITIAL' | 'EXPANSION',
  submissionId: string,
): Promise<string | null> => {
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

const validateRevisionRequests = async (
  context: AdminOperationContext,
  revisions: RevisionRequestInput[],
  cycleId: string,
  cycleVersion: number,
): Promise<string | null> => {
  if (revisions.length < 1 || revisions.length > 6) {
    return 'Provide one to six editable-section revision requests.'
  }
  if (new Set(revisions.map((revision) => revision.section)).size !== revisions.length) {
    return 'Only one open request may target each section.'
  }
  for (const revision of revisions) {
    const approved = await approvedReason(context.db, {
      id: revision.reasonCategoryId,
      cycleId,
      version: cycleVersion,
      context: 'REVISION',
    })
    if (!normalizeRequiredText(revision.note, 1_000) || !approved) {
      return 'Every revision needs an approved reason and safe instruction.'
    }
  }
  return null
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
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentAdministrator(context)
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const head = await loadApplicationHead(context.db, input.applicationId)
  const submission = await latestSubmission(context.db, input.applicationId)
  if (!head || !submission) return failure('The submitted application was not found.')
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
  if (input.outcome === 'REQUEST_REVISION') {
    const revisionProblem = await validateRevisionRequests(
      context,
      input.revisions,
      cycleId,
      cycleVersion,
    )
    if (revisionProblem) return failure(revisionProblem)
  } else if (input.revisions.length > 0) {
    return failure('This outcome cannot include revision requests.')
  }
  const changed = await constraintSafe(() => completeDeskReviewWrite(context, {
    ...input,
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
  // A missing application and one the caller has not claimed are refused
  // identically, so probing IDs cannot reveal which drafts or applications
  // exist. An unclaimed draft has no assignee and lands here too.
  const authorized = await administratorWithApplication(
    context, input.applicationId, 'Claim the application before opening its documents.',
  )
  if ('refusal' in authorized) return authorized.refusal
  if (authorized.head.application.assignedToUserId !== authorized.administrator.id) {
    return failure('Claim the application before opening its documents.')
  }
  const document = await acceptedPinnedDocument(context.db, input)
  if (!document) return failure('The submitted document has not passed malware scanning.')
  return success(await createDownloadAuthorization(
    context,
    document.file.r2ObjectKey,
    document.file.originalFilename,
    new Date(),
  ))
}
