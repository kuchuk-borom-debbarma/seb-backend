/** Input validation and authorization for bank evidence and the decision. */
import { auditActions } from '../../../db/schema'
import { parseDateOnly } from '../../application/validation'
import { findUserEmailById } from '../../application/queries/application'
import { formatPaise } from '../../application/confirmation'
import { confirmationPdfUrl } from '../../application/confirmation-link'
import { createAuditEvent } from '../../auth/queries/auth'
import { sendNotification } from '../../external-notification'
import {
  cancelBankReferralWrite,
  correctBankOutcomeWrite,
  correctDecisionWrite,
  createBankReferralWrite,
  recordBankOutcomeWrite,
  recordDecisionWrite,
} from '../queries/decision'
import { adminPageSize, decodeAdminCursor } from '../pagination'
import { approvedReason, latestSubmission, loadApplicationHead, loadWorkspace } from '../queries/intake'
import {
  ADMIN_REQUIRED_MESSAGE,
  adminAudit,
  constraintSafe,
  currentStaff,
  SELF_REVIEW_MESSAGE,
  undisclosedSelfReview,
  normalizeOptionalText,
  normalizeRequiredText,
  STALE_MESSAGE,
} from '../support'
import { revisionRequestProblem } from '../revisions'
import { sendRevisionRequestNotification } from '../notifications'
import { failure, success } from '../../envelope'
import { bestEffort } from '../../best-effort'
import type {
  AdminOperationContext,
  AdminResult,
  BankOutcome,
  RevisionRequestInput,
  DecisionOutcome,
} from '../types'

/** One message for a correction that cannot be made, whatever is wrong with it. */
const CORRECTION_MESSAGE = 'Enter a valid approved decision correction.'

const validDate = (value: string) => parseDateOnly(value) !== null
const validExpected = (value: number) => Number.isInteger(value) && value >= 1
const validInstant = (value: Date) => value instanceof Date && !Number.isNaN(value.getTime())

export const referApplicationToBank = async (
  input: {
    applicationId: string
    submissionId: string
    deskReviewId: string
    expectedStatusVersion: number
    bankName: string
    bankBranch?: string | null
    referralReference: string
    referralDate: string
    applicantMessage: string
    internalNote?: string | null
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const bankName = normalizeRequiredText(input.bankName, 200)
  const branch = normalizeOptionalText(input.bankBranch, 200)
  const reference = normalizeRequiredText(input.referralReference, 100)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const note = normalizeOptionalText(input.internalNote, 5_000)
  if (!validExpected(input.expectedStatusVersion) || !bankName || branch === 'INVALID' ||
      !reference || !validDate(input.referralDate) || !message || note === 'INVALID') {
    return failure('Enter valid bank-referral details.')
  }
  const changed = await constraintSafe(() => createBankReferralWrite(context, {
    ...input,
    bankName,
    bankBranch: branch,
    referralReference: reference,
    applicantMessage: message,
    internalNote: note,
    actorId: administrator.id,
    now: new Date(),
  }))
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const recordBankOutcome = async (
  input: {
    applicationId: string
    referralId: string
    expectedStatusVersion: number
    expectedReferralVersion: number
    outcome: BankOutcome
    decisionReference: string
    decisionDate: string
    availableLoanAmountPaise?: number | null
    applicantSummary: string
    internalNote?: string | null
    revisions: RevisionRequestInput[]
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reference = normalizeRequiredText(input.decisionReference, 100)
  const summary = normalizeRequiredText(input.applicantSummary, 1_000)
  const note = normalizeOptionalText(input.internalNote, 5_000)
  const amount = input.availableLoanAmountPaise ?? null
  if (!validExpected(input.expectedStatusVersion) || !validExpected(input.expectedReferralVersion) ||
      !reference || !validDate(input.decisionDate) || !summary || note === 'INVALID' ||
      (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))) {
    return failure('Enter a valid partner-bank outcome.')
  }
  const submission = await latestSubmission(context.db, input.applicationId)
  if (!submission) return failure('The submitted application was not found.')
  const bankRevisionProblem = await revisionRequestProblem(context, {
    carriesRevisions: input.outcome === 'MORE_INFORMATION_REQUIRED',
    revisions: input.revisions,
    cycleId: submission.snapshot.programmeCycleId,
    cycleVersion: submission.snapshot.programmeCycleVersion,
    stagesMessage: 'Bank requests for more information require unique editable stages.',
    instructionMessage: 'Every bank revision needs an approved reason and safe instruction.',
    unexpectedMessage: 'This bank outcome cannot include revision requests.',
  })
  if (bankRevisionProblem) return failure(bankRevisionProblem)
  const changed = await constraintSafe(() => recordBankOutcomeWrite(context, {
    ...input,
    decisionReference: reference,
    availableLoanAmountPaise: amount,
    applicantSummary: summary,
    internalNote: note,
    revisions: input.revisions.map((revision) => ({ ...revision, note: revision.note.trim() })),
    actorId: administrator.id,
    now: new Date(),
  }))
  if (changed && input.outcome === 'MORE_INFORMATION_REQUIRED') {
    await bestEffort(sendRevisionRequestNotification(context, {
      applicationId: input.applicationId,
      actorId: administrator.id,
      applicantMessage: summary,
      revisions: input.revisions,
    }), 'A revision notification failed')
  }
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const cancelBankReferral = async (
  input: {
    applicationId: string
    referralId: string
    expectedReferralVersion: number
    reasonCategoryId: string
    reason: string
    applicantMessage: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const submission = await latestSubmission(context.db, input.applicationId)
  const reason = normalizeRequiredText(input.reason, 1_000)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  if (!validExpected(input.expectedReferralVersion) || !submission || !reason || !message ||
      !await approvedReason(context.db, {
        id: input.reasonCategoryId,
        cycleId: submission.snapshot.programmeCycleId,
        version: submission.snapshot.programmeCycleVersion,
        context: 'BANK_REFERRAL_CANCEL',
      })) return failure('Select an approved referral-cancellation reason.')
  const changed = await constraintSafe(() => cancelBankReferralWrite(context, {
    ...input, reason, applicantMessage: message,
    actorId: administrator.id, now: new Date(),
  }))
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const correctBankOutcome = async (
  input: Omit<Parameters<typeof recordBankOutcome>[0], 'expectedReferralVersion'> & {
    supersedesOutcomeId: string
    correctionReasonCategoryId: string
    correctionReason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const submission = await latestSubmission(context.db, input.applicationId)
  const reference = normalizeRequiredText(input.decisionReference, 100)
  const summary = normalizeRequiredText(input.applicantSummary, 1_000)
  const note = normalizeOptionalText(input.internalNote, 5_000)
  const correction = normalizeRequiredText(input.correctionReason, 1_000)
  const amount = input.availableLoanAmountPaise ?? null
  if (!submission || !reference || !summary || note === 'INVALID' || !correction ||
      !validExpected(input.expectedStatusVersion) || !validDate(input.decisionDate) ||
      (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) ||
      !await approvedReason(context.db, {
        id: input.correctionReasonCategoryId,
        cycleId: submission.snapshot.programmeCycleId,
        version: submission.snapshot.programmeCycleVersion,
        context: 'BANK_OUTCOME_CORRECTION',
      })) return failure('Enter a valid approved bank-outcome correction.')
  const correctionRevisionProblem = await revisionRequestProblem(context, {
    carriesRevisions: input.outcome === 'MORE_INFORMATION_REQUIRED',
    revisions: input.revisions,
    cycleId: submission.snapshot.programmeCycleId,
    cycleVersion: submission.snapshot.programmeCycleVersion,
    stagesMessage: 'Bank requests for more information require unique editable stages.',
    instructionMessage: 'Every bank revision needs an approved reason and safe instruction.',
    unexpectedMessage: 'This bank outcome cannot include revisions.',
  })
  if (correctionRevisionProblem) return failure(correctionRevisionProblem)
  const changed = await constraintSafe(() => correctBankOutcomeWrite(context, {
    ...input,
    decisionReference: reference,
    availableLoanAmountPaise: amount,
    applicantSummary: summary,
    internalNote: note,
    correctionReason: correction,
    revisions: input.revisions.map((revision) => ({ ...revision, note: revision.note.trim() })),
    actorId: administrator.id,
    now: new Date(),
  }))
  if (changed && input.outcome === 'MORE_INFORMATION_REQUIRED') {
    await bestEffort(sendRevisionRequestNotification(context, {
      applicationId: input.applicationId,
      actorId: administrator.id,
      applicantMessage: summary,
      revisions: input.revisions,
    }), 'A revision notification failed')
  }
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

const approvalProblem = (
  outcome: DecisionOutcome,
  amount: number | null,
  requestedAmount: number,
): string | null => {
  if (outcome !== 'APPROVED') {
    return amount === null ? null : 'Only approvals may contain an approved amount.'
  }
  return amount !== null && Number.isSafeInteger(amount) && amount > 0 && amount <= requestedAmount
    ? null
    : 'The approved amount must be positive and cannot exceed the submitted request.'
}

const decisionReasonContext = (outcome: DecisionOutcome) => {
  if (outcome === 'REJECTED') return 'REJECTION' as const
  if (outcome === 'REVISION_REQUIRED') return 'REVISION' as const
  return null
}

const selectedDecisionReason = (
  context: ReturnType<typeof decisionReasonContext>,
  reasonCategoryId: string | null | undefined,
) => context ? reasonCategoryId! : null

/*
 * Best effort, and deliberately after the write: a mail failure must not undo
 * or hide a decision that has already been recorded (the policy set by the
 * password-change notice in `auth/controllers/account.ts`). On any failure
 * the office gets a FAILURE audit row under its own action and a fixed log
 * line — never the error object, which can echo the recipient into logs that
 * are public in CI.
 */
const sendApprovalNotification = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    applicantUserId: string
    actorId: string
    referenceNumber: string | null
    cycleCode: string
    cycleDisplayName: string
    snapshot: { id: string; programmeCycleId: string; programmeCycleVersion: number }
    submittedAt: Date
    applicantMessage: string
    decisionReference: string
    decisionDate: string
    approvedAmountPaise: number | null
  },
): Promise<void> => {
  try {
    const email = await findUserEmailById(context.db, input.applicantUserId)
    if (!email) throw new Error('The notification cannot be addressed.')
    const amount = input.approvedAmountPaise !== null
      ? formatPaise(input.approvedAmountPaise)
      : null
    // The decision's specifics travel in the body; the attachment is the
    // submitted application, fetched by the provider from this signed link.
    const url = await confirmationPdfUrl(
      context.env, context.requestUrl, input.applicationId, new Date(),
    )
    await sendNotification({
      to: email,
      subject: 'Your Mission SEP application has been approved',
      body:
        'Your Mission SEP application has been approved.\n\n'
        + `${input.applicantMessage}\n\n`
        + `Reference: ${input.referenceNumber ?? input.applicationId}\n`
        + `Decision reference: ${input.decisionReference}\n`
        + (amount !== null ? `Approved amount: ${amount}\n` : '')
        + '\nA copy of the application is attached. The programme office will '
        + 'contact you about the sanction of funds.',
      attachments: [{
        filename: `application-${input.referenceNumber ?? input.applicationId}.pdf`,
        contentType: 'application/pdf',
        url,
      }],
    }, context.env)
  } catch {
    // Guarded itself, so the recorded decision can never be disturbed.
    await bestEffort(createAuditEvent(context.db, {
      ...adminAudit(context, {
        actorUserId: input.actorId,
        action: auditActions.approvalNotificationFailed,
        entityType: 'SEB_APPLICATION',
        entityId: input.applicationId,
        now: new Date(),
      }),
      outcome: 'FAILURE',
    }), 'An approval notification failed')
  }
}

export const recordDecision = async (
  input: {
    applicationId: string
    expectedStatusVersion: number
    outcome: DecisionOutcome
    decisionReference: string
    decisionDate: string
    approvedAmountPaise?: number | null
    applicantConditions?: string | null
    reasonCategoryId?: string | null
    applicantMessage: string
    revisions: RevisionRequestInput[]
    /** Only somebody deciding their own application needs to send this. */
    conflictAcknowledged?: boolean | null
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'DECIDE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const application = await loadApplicationHead(context.db, input.applicationId)
  const submission = await latestSubmission(context.db, input.applicationId)
  if (!application || !submission) return failure('The submitted application was not found.')
  // The decision is the other place a self-review has to be disclosed. Claiming
  // used to carry it, and there is nothing to reserve any more.
  if (undisclosedSelfReview(
    application.application.applicantUserId, administrator.id, input.conflictAcknowledged,
  )) return failure(SELF_REVIEW_MESSAGE)
  const reference = normalizeRequiredText(input.decisionReference, 100)
  const conditions = normalizeOptionalText(input.applicantConditions, 2_000)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const amount = input.approvedAmountPaise ?? null
  if (!validExpected(input.expectedStatusVersion) || !reference || !validDate(input.decisionDate) ||
      !message || conditions === 'INVALID') {
    return failure('Enter valid decision details.')
  }
  /*
   * The amount this submission asked for, resolved once by the read.
   *
   * It used to be asserted non-null, on the grounds that submission validation
   * guarantees a positive figure. That guarantee no longer belongs to the
   * schema: which field carries the requested amount and whether it is required
   * are both a cycle's decisions now. The engine makes a role-bound amount
   * required and positive whatever the template says — but a value this
   * decision is *bounded by* must not rest on a rule stated somewhere else, so
   * it is checked here and refused with something an officer can act on rather
   * than propagating `undefined` into an approval.
   */
  const requestedAmount = submission.requestedAmountPaise
  if (requestedAmount === null) {
    return failure('The submitted application does not record a requested amount.')
  }
  const decisionProblem = approvalProblem(input.outcome, amount, requestedAmount)
  if (decisionProblem) return failure(decisionProblem)
  const reasonContext = decisionReasonContext(input.outcome)
  if (reasonContext) {
    if (!input.reasonCategoryId || !await approvedReason(context.db, {
      id: input.reasonCategoryId,
      cycleId: submission.snapshot.programmeCycleId,
      version: submission.snapshot.programmeCycleVersion,
      context: reasonContext,
    })) return failure('Select an approved decision reason.')
  } else if (input.reasonCategoryId) return failure('Approval does not use a reason category.')
  const decisionRevisionProblem = await revisionRequestProblem(context, {
    carriesRevisions: input.outcome === 'REVISION_REQUIRED',
    revisions: input.revisions,
    cycleId: submission.snapshot.programmeCycleId,
    cycleVersion: submission.snapshot.programmeCycleVersion,
    stagesMessage: 'Revision decisions require unique editable stages.',
    instructionMessage: 'Every revision needs an approved reason and safe instruction.',
    unexpectedMessage: 'This decision cannot include revisions.',
  })
  if (decisionRevisionProblem) return failure(decisionRevisionProblem)
  const changed = await constraintSafe(() => recordDecisionWrite(context, {
    ...input,
    submissionId: submission.submission.id,
    reference,
    date: input.decisionDate,
    approvedAmountPaise: amount,
    conditions,
    reasonCategoryId: selectedDecisionReason(reasonContext, input.reasonCategoryId),
    applicantMessage: message,
    revisions: input.revisions.map((revision) => ({ ...revision, note: revision.note.trim() })),
    requestedAmountPaise: requestedAmount,
    actorId: administrator.id,
    now: new Date(),
  }))
  if (changed && input.outcome === 'REVISION_REQUIRED') {
    await bestEffort(sendRevisionRequestNotification(context, {
      applicationId: input.applicationId,
      actorId: administrator.id,
      applicantMessage: message,
      revisions: input.revisions,
    }), 'A revision notification failed')
  }
  if (changed && input.outcome === 'APPROVED') {
    await bestEffort(sendApprovalNotification(context, {
      applicationId: input.applicationId,
      applicantUserId: application.application.applicantUserId,
      actorId: administrator.id,
      referenceNumber: application.application.referenceNumber,
      cycleCode: application.cycleCode,
      cycleDisplayName: application.cycleDisplayName,
      snapshot: submission.snapshot,
      submittedAt: submission.submission.submittedAt,
      applicantMessage: message,
      decisionReference: reference,
      decisionDate: input.decisionDate,
      approvedAmountPaise: amount,
    }), 'An approval notification failed')
  }
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const correctDecision = async (
  input: Parameters<typeof recordDecision>[0] & {
    supersedesDecisionId: string
    correctionReasonCategoryId: string
    correctionReason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'DECIDE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  /*
   * The head is read only for the owner. It cannot come from the submission
   * snapshot beside it — that carries who last edited the application, not
   * whose application it is — and the two cannot share a batch, because a
   * batch maps results by column name and both carry an `id`.
   */
  const [application, submission] = await Promise.all([
    loadApplicationHead(context.db, input.applicationId),
    latestSubmission(context.db, input.applicationId),
  ])
  if (!application || !submission) return failure(CORRECTION_MESSAGE)
  // Superseding a decision is its own act on the file, so it discloses for
  // itself. Checked before the details, so a refusal here is never mistaken
  // for a malformed correction.
  if (undisclosedSelfReview(
    application.application.applicantUserId, administrator.id, input.conflictAcknowledged,
  )) return failure(SELF_REVIEW_MESSAGE)
  const reference = normalizeRequiredText(input.decisionReference, 100)
  const conditions = normalizeOptionalText(input.applicantConditions, 2_000)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const correction = normalizeRequiredText(input.correctionReason, 1_000)
  const amount = input.approvedAmountPaise ?? null
  // Bound before the compound guard below, so the narrowing survives it and the
  // corrected decision is bounded by a number rather than by `undefined`.
  const requestedAmount = submission.requestedAmountPaise
  if (requestedAmount === null) {
    return failure('The submitted application does not record a requested amount.')
  }
  if (!validExpected(input.expectedStatusVersion) || !reference ||
      !validDate(input.decisionDate) || !message || conditions === 'INVALID' ||
      !correction ||
      approvalProblem(input.outcome, amount, requestedAmount) ||
      !await approvedReason(context.db, {
        id: input.correctionReasonCategoryId,
        cycleId: submission.snapshot.programmeCycleId,
        version: submission.snapshot.programmeCycleVersion,
        context: 'DECISION_CORRECTION',
      })) return failure(CORRECTION_MESSAGE)
  const reasonContext = decisionReasonContext(input.outcome)
  if (reasonContext) {
    if (!input.reasonCategoryId || !await approvedReason(context.db, {
      id: input.reasonCategoryId,
      cycleId: submission.snapshot.programmeCycleId,
      version: submission.snapshot.programmeCycleVersion,
      context: reasonContext,
    })) return failure('Select an approved decision reason.')
  } else if (input.reasonCategoryId) return failure('Approval does not use a reason category.')
  const correctedRevisionProblem = await revisionRequestProblem(context, {
    carriesRevisions: input.outcome === 'REVISION_REQUIRED',
    revisions: input.revisions,
    cycleId: submission.snapshot.programmeCycleId,
    cycleVersion: submission.snapshot.programmeCycleVersion,
    stagesMessage: 'Revision decisions require unique editable stages.',
    instructionMessage: 'Every revision needs an approved reason and safe instruction.',
    unexpectedMessage: 'This decision cannot include revisions.',
  })
  if (correctedRevisionProblem) return failure(correctedRevisionProblem)
  const changed = await constraintSafe(() => correctDecisionWrite(context, {
    ...input,
    reference,
    date: input.decisionDate,
    approvedAmountPaise: amount,
    conditions,
    reasonCategoryId: selectedDecisionReason(reasonContext, input.reasonCategoryId),
    correctionReason: correction,
    applicantMessage: message,
    revisions: input.revisions.map((revision) => ({ ...revision, note: revision.note.trim() })),
    requestedAmountPaise: requestedAmount,
    actorId: administrator.id,
    now: new Date(),
  }))
  if (changed && input.outcome === 'REVISION_REQUIRED') {
    await bestEffort(sendRevisionRequestNotification(context, {
      applicationId: input.applicationId,
      actorId: administrator.id,
      applicantMessage: message,
      revisions: input.revisions,
    }), 'A revision notification failed')
  }
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}
