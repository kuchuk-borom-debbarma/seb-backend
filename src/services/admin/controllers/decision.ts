/** Input validation and authorization for bank and TTM operations. */
import { parseDateOnly } from '../../application/validation'
import {
  addAgendaItemWrite,
  cancelMeetingWrite,
  changeAgendaItemWrite,
  cancelBankReferralWrite,
  correctBankOutcomeWrite,
  correctTtmDecisionWrite,
  createBankReferralWrite,
  createMeetingWrite,
  listMeetings,
  meetingWorkspace,
  recordBankOutcomeWrite,
  recordTtmDecisionWrite,
  transitionMeetingWrite,
  updateDraftMeetingWrite,
} from '../queries/decision'
import { adminPageSize, decodeAdminCursor } from '../pagination'
import { approvedReason, latestSubmission, loadApplicationHead, loadWorkspace } from '../queries/intake'
import {
  ADMIN_REQUIRED_MESSAGE,
  constraintSafe,
  currentStaff,
  SELF_REVIEW_MESSAGE,
  undisclosedSelfReview,
  normalizeOptionalText,
  normalizeRequiredText,
  STALE_MESSAGE,
} from '../support'
import { failure, success } from '../../envelope'
import type {
  AdminOperationContext,
  AdminResult,
  BankOutcome,
  RevisionRequestInput,
  TtmDecisionOutcome,
} from '../types'

const validDate = (value: string) => parseDateOnly(value) !== null
const validExpected = (value: number) => Number.isInteger(value) && value >= 1
const validInstant = (value: Date) => value instanceof Date && !Number.isNaN(value.getTime())

/**
 * Validates the revision requests an outcome carries, for every outcome that
 * can carry them.
 *
 * Recording and correcting a bank outcome, and recording and correcting a TTM
 * decision, all apply the same three rules: a revision-bearing outcome needs at
 * least one request, each request must name a distinct section, and each needs
 * an approved reason plus a safe instruction. Only the wording differs, so only
 * the wording is passed in — four copies of the rules is how one of them ends
 * up missing the uniqueness check.
 */
const revisionRequestProblem = async (
  context: AdminOperationContext,
  input: {
    carriesRevisions: boolean
    revisions: RevisionRequestInput[]
    cycleId: string
    cycleVersion: number
    sectionsMessage: string
    instructionMessage: string
    unexpectedMessage: string
  },
): Promise<string | null> => {
  if (!input.carriesRevisions) {
    return input.revisions.length > 0 ? input.unexpectedMessage : null
  }
  const sections = new Set(input.revisions.map((revision) => revision.section))
  if (input.revisions.length === 0 || sections.size !== input.revisions.length) {
    return input.sectionsMessage
  }
  for (const revision of input.revisions) {
    const approved = await approvedReason(context.db, {
      id: revision.reasonCategoryId,
      cycleId: input.cycleId,
      version: input.cycleVersion,
      context: 'REVISION',
    })
    if (!approved || !normalizeRequiredText(revision.note, 1_000)) {
      return input.instructionMessage
    }
  }
  return null
}

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
    sectionsMessage: 'Bank requests for more information require unique editable sections.',
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
    sectionsMessage: 'Bank requests for more information require unique editable sections.',
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
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const ttmMeetings = async (
  input: {
    first?: number | null
    after?: string | null
    status?: Parameters<typeof listMeetings>[1]['status']
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const first = adminPageSize(input.first)
  const after = decodeAdminCursor(input.after, 'scheduledAt')
  if (!first || after === 'INVALID') return failure('Invalid pagination arguments.')
  return success(await listMeetings(context.db, { first, after, status: input.status }))
}

export const ttmMeetingById = async (
  meetingId: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const workspace = await meetingWorkspace(context.db, meetingId)
  return workspace ? success(workspace) : failure('The TTM meeting was not found.')
}

export const createTtmMeeting = async (
  input: { meetingReference: string; scheduledAt: Date; venue: string; description?: string | null },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reference = normalizeRequiredText(input.meetingReference, 100)
  const venue = normalizeRequiredText(input.venue, 500)
  const description = normalizeOptionalText(input.description, 2_000)
  if (!reference || !venue || description === 'INVALID' ||
      !(input.scheduledAt instanceof Date) || Number.isNaN(input.scheduledAt.getTime())) {
    return failure('Enter valid meeting details.')
  }
  const id = await constraintSafe(() => createMeetingWrite(context, {
    actorId: administrator.id,
    reference,
    scheduledAt: input.scheduledAt,
    venue,
    description,
    now: new Date(),
  }))
  return id ? success(await meetingWorkspace(context.db, id)) : failure('The meeting reference is already in use.')
}

export const updateTtmMeeting = async (
  input: { meetingId: string; expectedVersion: number; meetingReference: string; scheduledAt: Date; venue: string; description?: string | null; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reference = normalizeRequiredText(input.meetingReference, 100)
  const venue = normalizeRequiredText(input.venue, 500)
  const description = normalizeOptionalText(input.description, 2_000)
  const reason = normalizeRequiredText(input.reason, 1_000)
  if (!validExpected(input.expectedVersion) || !reference || !venue || !reason ||
      description === 'INVALID' || !validInstant(input.scheduledAt)) {
    return failure('Enter valid meeting details and a change reason.')
  }
  const changed = await constraintSafe(() => updateDraftMeetingWrite(context, {
    ...input, reference, venue, description, reason,
    actorId: administrator.id, now: new Date(),
  }))
  return changed ? success(await meetingWorkspace(context.db, input.meetingId)) : failure(STALE_MESSAGE)
}

export const cancelTtmMeeting = async (
  input: { meetingId: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 1_000)
  if (!validExpected(input.expectedVersion) || !reason) return failure('Enter a cancellation reason.')
  const changed = await constraintSafe(() => cancelMeetingWrite(context, {
    ...input, reason, actorId: administrator.id, now: new Date(),
  }))
  return changed ? success(await meetingWorkspace(context.db, input.meetingId)) : failure(STALE_MESSAGE)
}

export const addTtmAgendaItem = async (
  input: {
    meetingId: string
    applicationId: string
    submissionId: string
    bankOutcomeId: string
    position: number
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  if (!Number.isInteger(input.position) || input.position < 1) return failure('Agenda position must be positive.')
  const id = await constraintSafe(() => addAgendaItemWrite(context, {
    ...input,
    actorId: administrator.id,
    now: new Date(),
  }))
  return id ? success(await meetingWorkspace(context.db, input.meetingId)) : failure(STALE_MESSAGE)
}

const changeAgendaItem = async (
  input: { meetingId: string; agendaItemId: string; expectedVersion: number; position?: number; reason: string },
  context: AdminOperationContext,
  remove: boolean,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 1_000)
  // GraphQL requires a position for reordering; removal uses a harmless fixed
  // value because its historical version still has a non-null position.
  const position = remove ? 1 : input.position!
  if (!validExpected(input.expectedVersion) || !Number.isInteger(position) ||
      position < 1 || !reason) return failure('Enter a valid agenda change and reason.')
  const changed = await constraintSafe(() => changeAgendaItemWrite(context, {
    ...input, position, remove, reason,
    actorId: administrator.id, now: new Date(),
  }))
  return changed ? success(await meetingWorkspace(context.db, input.meetingId)) : failure(STALE_MESSAGE)
}

export const reorderTtmAgendaItem = (
  input: { meetingId: string; agendaItemId: string; expectedVersion: number; position: number; reason: string },
  context: AdminOperationContext,
) => changeAgendaItem(input, context, false)

export const removeTtmAgendaItem = (
  input: { meetingId: string; agendaItemId: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
) => changeAgendaItem(input, context, true)

const transitionMeeting = async (
  input: { meetingId: string; expectedVersion: number },
  context: AdminOperationContext,
  finishing: boolean,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  if (!validExpected(input.expectedVersion)) return failure('Expected version must be positive.')
  const changed = await constraintSafe(() => transitionMeetingWrite(context, {
    ...input,
    from: finishing ? 'IN_SESSION' : 'DRAFT',
    to: finishing ? 'FINALIZED' : 'IN_SESSION',
    actorId: administrator.id,
    now: new Date(),
  }))
  return changed ? success(await meetingWorkspace(context.db, input.meetingId)) : failure(STALE_MESSAGE)
}

export const startTtmMeeting = (
  input: { meetingId: string; expectedVersion: number },
  context: AdminOperationContext,
) => transitionMeeting(input, context, false)

export const finalizeTtmMeeting = (
  input: { meetingId: string; expectedVersion: number },
  context: AdminOperationContext,
) => transitionMeeting(input, context, true)

const approvalProblem = (
  outcome: TtmDecisionOutcome,
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

const deferralProblem = (
  outcome: TtmDecisionOutcome,
  nextAction: string | null,
): string | null => {
  if (outcome === 'DEFERRED') return nextAction ? null : 'A deferral requires the next action.'
  return nextAction === null ? null : 'Only a deferral may contain the next action.'
}

const decisionReasonContext = (outcome: TtmDecisionOutcome) => {
  if (outcome === 'REJECTED') return 'REJECTION' as const
  if (outcome === 'DEFERRED') return 'TTM_DEFERRAL' as const
  if (outcome === 'REVISION_REQUIRED') return 'REVISION' as const
  return null
}

const selectedDecisionReason = (
  context: ReturnType<typeof decisionReasonContext>,
  reasonCategoryId: string | null | undefined,
) => context ? reasonCategoryId! : null

export const recordTtmDecision = async (
  input: {
    applicationId: string
    agendaItemId: string
    expectedStatusVersion: number
    outcome: TtmDecisionOutcome
    decisionReference: string
    decisionDate: string
    approvedAmountPaise?: number | null
    applicantConditions?: string | null
    reasonCategoryId?: string | null
    applicantMessage: string
    nextAction?: string | null
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
  const nextAction = normalizeOptionalText(input.nextAction, 1_000)
  const amount = input.approvedAmountPaise ?? null
  if (!validExpected(input.expectedStatusVersion) || !reference || !validDate(input.decisionDate) ||
      !message || conditions === 'INVALID' || nextAction === 'INVALID') {
    return failure('Enter valid TTM decision details.')
  }
  // Formal submission validation guarantees a positive requested amount. The
  // exact frozen value, rather than current draft data, bounds the decision.
  const requestedAmount = submission.snapshot.seedFundRequestedPaise!
  const decisionProblem = approvalProblem(input.outcome, amount, requestedAmount) ??
    deferralProblem(input.outcome, nextAction)
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
    sectionsMessage: 'Revision decisions require unique editable sections.',
    instructionMessage: 'Every TTM revision needs an approved reason and safe instruction.',
    unexpectedMessage: 'This decision cannot include revisions.',
  })
  if (decisionRevisionProblem) return failure(decisionRevisionProblem)
  const changed = await constraintSafe(() => recordTtmDecisionWrite(context, {
    ...input,
    reference,
    date: input.decisionDate,
    approvedAmountPaise: amount,
    conditions,
    reasonCategoryId: selectedDecisionReason(reasonContext, input.reasonCategoryId),
    applicantMessage: message,
    nextAction,
    revisions: input.revisions.map((revision) => ({ ...revision, note: revision.note.trim() })),
    requestedAmountPaise: requestedAmount,
    actorId: administrator.id,
    now: new Date(),
  }))
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const correctTtmDecision = async (
  input: Parameters<typeof recordTtmDecision>[0] & {
    supersedesDecisionId: string
    correctionReasonCategoryId: string
    correctionReason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'DECIDE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const submission = await latestSubmission(context.db, input.applicationId)
  const reference = normalizeRequiredText(input.decisionReference, 100)
  const conditions = normalizeOptionalText(input.applicantConditions, 2_000)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const nextAction = normalizeOptionalText(input.nextAction, 1_000)
  const correction = normalizeRequiredText(input.correctionReason, 1_000)
  const amount = input.approvedAmountPaise ?? null
  if (!submission || !validExpected(input.expectedStatusVersion) || !reference ||
      !validDate(input.decisionDate) || !message || conditions === 'INVALID' ||
      nextAction === 'INVALID' || !correction ||
      approvalProblem(input.outcome, amount, submission.snapshot.seedFundRequestedPaise!) ||
      deferralProblem(input.outcome, nextAction) ||
      !await approvedReason(context.db, {
        id: input.correctionReasonCategoryId,
        cycleId: submission.snapshot.programmeCycleId,
        version: submission.snapshot.programmeCycleVersion,
        context: 'TTM_DECISION_CORRECTION',
      })) return failure('Enter a valid approved TTM decision correction.')
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
    sectionsMessage: 'Revision decisions require unique editable sections.',
    instructionMessage: 'Every TTM revision needs an approved reason and safe instruction.',
    unexpectedMessage: 'This decision cannot include revisions.',
  })
  if (correctedRevisionProblem) return failure(correctedRevisionProblem)
  const changed = await constraintSafe(() => correctTtmDecisionWrite(context, {
    ...input,
    reference,
    date: input.decisionDate,
    approvedAmountPaise: amount,
    conditions,
    reasonCategoryId: selectedDecisionReason(reasonContext, input.reasonCategoryId),
    correctionReason: correction,
    applicantMessage: message,
    nextAction,
    revisions: input.revisions.map((revision) => ({ ...revision, note: revision.note.trim() })),
    requestedAmountPaise: submission.snapshot.seedFundRequestedPaise!,
    actorId: administrator.id,
    now: new Date(),
  }))
  return changed ? success(await loadWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}
