/** Authorization and strict input validation for post-decision funding work. */
import { desc, eq } from 'drizzle-orm'
import { auditActions, sebFundingAward, sebProgrammeDecision } from '../../../db/schema'
import { parseDateOnly } from '../../application/validation'
import { findUserEmailById } from '../../application/queries/application'
import { formatPaise } from '../../application/confirmation'
import { confirmationPdfUrl } from '../../application/confirmation-link'
import { createAuditEvent } from '../../auth/queries/auth'
import { sendNotification } from '../../external-notification'
import {
  cancelRecoveryWrite,
  changeAwardWrite,
  closeRecoveryWrite,
  createAwardWrite,
  fundingWorkspace,
  openRecoveryWrite,
  recordAssessmentWrite,
  recordRecoveryEntryWrite,
  recordReleaseWrite,
  recoveryWorkspace,
  reverseReleaseWrite,
} from '../queries/funding'
import { approvedReason, latestSubmission, loadApplicationHead } from '../queries/intake'
import {
  ADMIN_REQUIRED_MESSAGE,
  adminAudit,
  constraintSafe,
  authorizeReasonedTransition,
  currentStaff,
  normalizeOptionalText,
  normalizeRequiredText,
  STALE_MESSAGE,
} from '../support'
import { failure, success } from '../../envelope'
import { bestEffort } from '../../best-effort'
import type { AdminOperationContext, AdminResult, AssessmentType, RecoveryComponent } from '../types'

const positiveMoney = (value: number) => Number.isSafeInteger(value) && value > 0
const expectedVersion = (value: number) => Number.isInteger(value) && value >= 0
const validDate = (value: string) => parseDateOnly(value) !== null
const validInstant = (value: Date) => value instanceof Date && !Number.isNaN(value.getTime())

export const fundingByApplication = async (
  applicationId: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const workspace = await fundingWorkspace(context.db, applicationId)
  return workspace ? success(workspace) : failure('No award exists for this application.')
}

/*
 * Best effort, and deliberately after the write: a mail failure must not undo
 * or hide an award that has already been created (the policy set by the
 * password-change notice in `auth/controllers/account.ts`). On any failure
 * the office gets a FAILURE audit row under its own action and a fixed log
 * line — never the error object, which can echo the recipient into logs that
 * are public in CI.
 */
const sendSanctionNotification = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    actorId: string
    sanctionOrderNumber: string
    sanctionDate: string
    sanctionedAmountPaise: number
  },
): Promise<void> => {
  try {
    const [head, submission] = await Promise.all([
      loadApplicationHead(context.db, input.applicationId),
      latestSubmission(context.db, input.applicationId),
    ])
    if (!head || !submission) throw new Error('The notification cannot be addressed.')
    const email = await findUserEmailById(context.db, head.application.applicantUserId)
    if (!email) throw new Error('The notification cannot be addressed.')
    const amount = formatPaise(input.sanctionedAmountPaise)
    const reference = head.application.referenceNumber
    // The sanction's specifics travel in the body; the attachment is the
    // submitted application, fetched by the provider from this signed link.
    const url = await confirmationPdfUrl(
      context.env, context.requestUrl, input.applicationId, new Date(),
    )
    await sendNotification({
      to: email,
      subject: 'Your Mission SEP funding has been sanctioned',
      body:
        'Funding for your Mission SEP application has been sanctioned.\n\n'
        + `Reference: ${reference ?? input.applicationId}\n`
        + `Sanction order number: ${input.sanctionOrderNumber}\n`
        + `Sanction date: ${input.sanctionDate}\n`
        + `Sanctioned amount: ${amount}\n\n`
        + 'A copy of the application is attached. The programme office will '
        + 'contact you about the release of funds and the evidence each '
        + 'release requires.',
      attachments: [{
        filename: `application-${reference ?? input.applicationId}.pdf`,
        contentType: 'application/pdf',
        url,
      }],
    }, context.env)
  } catch {
    // Guarded itself, so the created award can never be disturbed.
    await bestEffort(createAuditEvent(context.db, {
      ...adminAudit(context, {
        actorUserId: input.actorId,
        action: auditActions.sanctionNotificationFailed,
        entityType: 'SEB_APPLICATION',
        entityId: input.applicationId,
        now: new Date(),
      }),
      outcome: 'FAILURE',
    }), 'A sanction notification failed')
  }
}

export const createFundingAward = async (
  input: {
    applicationId: string
    decisionId: string
    expectedStatusVersion: number
    sanctionOrderNumber: string
    sanctionDate: string
    applicantConditions?: string | null
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const order = normalizeRequiredText(input.sanctionOrderNumber, 100)
  const conditions = normalizeOptionalText(input.applicantConditions, 2_000)
  if (!order || !validDate(input.sanctionDate) || conditions === 'INVALID' ||
      !Number.isInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 1) {
    return failure('Enter valid sanction details.')
  }
  const id = await constraintSafe(() => createAwardWrite(context, {
    ...input,
    sanctionOrder: order,
    conditions,
    actorId: administrator.id,
    now: new Date(),
  }))
  // Read once for both the return value and the notification's amount — the
  // sanctioned amount is copied from the decision by the write, so the input
  // never carried it.
  const workspace = id ? await fundingWorkspace(context.db, input.applicationId) : null
  if (id && workspace) {
    await bestEffort(sendSanctionNotification(context, {
      applicationId: input.applicationId,
      actorId: administrator.id,
      sanctionOrderNumber: order,
      sanctionDate: input.sanctionDate,
      sanctionedAmountPaise: workspace.award.sanctionedAmountPaise,
    }), 'A sanction notification failed')
  }
  return id ? success(workspace) : failure(STALE_MESSAGE)
}

export const changeFundingAward = async (
  input: {
    awardId: string
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'CLOSED'
    closureDisposition?: 'RELEASES_COMPLETE' | 'REMAINDER_NOT_RELEASED' | null
    sanctionedAmountPaise: number
    applicantConditions?: string | null
    reasonCategoryId: string
    reason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const conditions = normalizeOptionalText(input.applicantConditions, 2_000)
  const closureDisposition = input.closureDisposition ?? null
  const reason = normalizeRequiredText(input.reason, 1_000)
  const workspace = await fundingWorkspace(context.db, input.applicationId)
  const submission = await latestSubmission(context.db, input.applicationId)
  const [approval] = workspace ? await context.db.select({
    amount: sebProgrammeDecision.approvedAmountPaise,
  }).from(sebProgrammeDecision)
    .where(eq(sebProgrammeDecision.applicationId, input.applicationId))
    .orderBy(desc(sebProgrammeDecision.createdAt)).limit(1) : []
  const changesAmount = workspace
    ? input.sanctionedAmountPaise !== workspace.award.sanctionedAmountPaise : false
  const changesStatus = workspace ? input.status !== workspace.award.status : false
  const changesConditions = workspace ? conditions !== workspace.award.applicantConditions : false
  const changesClosure = workspace
    ? closureDisposition !== workspace.award.closureDisposition : false
  if (!positiveMoney(input.sanctionedAmountPaise) || !expectedVersion(input.expectedVersion) ||
      !expectedVersion(input.expectedStatusVersion) ||
      conditions === 'INVALID' || !reason || !workspace || !submission ||
      !approval?.amount || workspace.award.id !== input.awardId ||
      input.sanctionedAmountPaise > approval.amount ||
      (input.status === 'CLOSED' ? closureDisposition === null : closureDisposition !== null) ||
      (changesStatus && (changesAmount || changesConditions)) || (!changesAmount && !changesStatus &&
        !changesConditions && !changesClosure)) {
    return failure('Enter one valid award amendment or lifecycle change.')
  }
  const reasonContext = changesAmount || changesConditions
    ? 'AWARD_AMENDMENT'
    : input.status === 'SUSPENDED' || input.status === 'ACTIVE'
      ? 'AWARD_SUSPENSION'
      : input.status === 'CANCELLED' ? 'AWARD_CANCELLATION' : 'AWARD_CLOSURE'
  if (!await approvedReason(context.db, {
    id: input.reasonCategoryId,
    cycleId: submission.snapshot.programmeCycleId,
    version: submission.snapshot.programmeCycleVersion,
    context: reasonContext,
  })) return failure('Select an approved award-change reason.')
  const changed = await constraintSafe(() => changeAwardWrite(context, {
    awardId: input.awardId,
    applicationId: input.applicationId,
    expectedVersion: input.expectedVersion,
    expectedStatusVersion: input.expectedStatusVersion,
    actorId: administrator.id,
    status: input.status,
    closureDisposition,
    amountPaise: input.sanctionedAmountPaise,
    conditions,
    reasonCategoryId: input.reasonCategoryId,
    changeType: changesStatus ? 'STATUS_CHANGED' : 'AMENDED',
    reason,
    now: new Date(),
  }))
  return changed ? success(await fundingWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const recordFundingRelease = async (
  input: {
    awardId: string
    applicationId: string
    expectedLedgerVersion: number
    amountPaise: number
    occurredAt: Date
    externalReference: string
    approvalReference: string
    approvalDate: string
    bankAccountVerifiedAt: Date
    performanceAgreementReference: string
    performanceAgreementExecutedAt: Date
    physicalVerificationRequired: boolean
    physicalVerificationReference?: string | null
    physicalVerificationCompletedAt?: Date | null
    applicantMessage: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const externalReference = normalizeRequiredText(input.externalReference, 100)
  const approval = normalizeRequiredText(input.approvalReference, 100)
  const agreement = normalizeRequiredText(input.performanceAgreementReference, 100)
  const verification = normalizeOptionalText(input.physicalVerificationReference, 100)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const physicalTime = input.physicalVerificationCompletedAt ?? null
  if (!expectedVersion(input.expectedLedgerVersion) || !positiveMoney(input.amountPaise) ||
      !validInstant(input.occurredAt) || !externalReference || !approval ||
      !validDate(input.approvalDate) || !validInstant(input.bankAccountVerifiedAt) ||
      !agreement || !validInstant(input.performanceAgreementExecutedAt) ||
      verification === 'INVALID' || !message ||
      (input.physicalVerificationRequired
        ? !verification || !physicalTime || !validInstant(physicalTime)
        : verification !== null || physicalTime !== null)) {
    return failure('Enter all required release approval and payment evidence.')
  }
  const id = await constraintSafe(() => recordReleaseWrite(context, {
    ...input,
    externalReference,
    approvalReference: approval,
    performanceAgreementReference: agreement,
    physicalVerificationReference: verification,
    physicalVerificationCompletedAt: physicalTime,
    applicantMessage: message,
    actorId: administrator.id,
    now: new Date(),
  }))
  return id ? success(await fundingWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const reverseFundingRelease = async (
  input: {
    awardId: string
    applicationId: string
    releaseId: string
    expectedLedgerVersion: number
    amountPaise: number
    occurredAt: Date
    externalReference: string
    reasonCategoryId: string
    applicantMessage: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reference = normalizeRequiredText(input.externalReference, 100)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const submission = await latestSubmission(context.db, input.applicationId)
  if (!expectedVersion(input.expectedLedgerVersion) || !positiveMoney(input.amountPaise) ||
      !validInstant(input.occurredAt) || !reference || !message || !submission ||
      !await approvedReason(context.db, {
        id: input.reasonCategoryId,
        cycleId: submission.snapshot.programmeCycleId,
        version: submission.snapshot.programmeCycleVersion,
        context: 'RELEASE_REVERSAL',
      })) {
    return failure('Enter valid reversal details.')
  }
  const id = await constraintSafe(() => reverseReleaseWrite(context, {
    ...input,
    externalReference: reference,
    applicantMessage: message,
    actorId: administrator.id,
    now: new Date(),
  }))
  return id ? success(await fundingWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const recordFundingAssessment = async (
  input: {
    awardId: string
    applicationId: string
    assessmentType: AssessmentType
    utilizationObligationId?: string | null
    outcome: 'PASSED' | 'FAILED'
    evidenceReference: string
    applicantSummary: string
    internalNote?: string | null
    assessedAt: Date
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const evidence = normalizeRequiredText(input.evidenceReference, 100)
  const summary = normalizeRequiredText(input.applicantSummary, 1_000)
  const note = normalizeOptionalText(input.internalNote, 5_000)
  const obligationId = input.utilizationObligationId ?? null
  if (!evidence || !summary || note === 'INVALID' || !validInstant(input.assessedAt) ||
      (input.assessmentType === 'UTILIZATION' ? obligationId === null : obligationId !== null)) {
    return failure('Enter valid assessment evidence and scope.')
  }
  const id = await constraintSafe(() => recordAssessmentWrite(context, {
    awardId: input.awardId,
    applicationId: input.applicationId,
    type: input.assessmentType,
    obligationId,
    outcome: input.outcome,
    evidenceReference: evidence,
    applicantSummary: summary,
    internalNote: note,
    assessedAt: input.assessedAt,
    actorId: administrator.id,
    now: new Date(),
  }))
  return id ? success(await fundingWorkspace(context.db, input.applicationId)) : failure(STALE_MESSAGE)
}

export const recoveryById = async (
  recoveryCaseId: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const workspace = await recoveryWorkspace(context.db, recoveryCaseId)
  return workspace ? success(workspace) : failure('The recovery case was not found.')
}

export const openRecoveryCase = async (
  input: {
    awardId: string
    officialDecisionReference: string
    officialDecisionDate: string
    reasonCategoryId: string
    applicantMessage: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reference = normalizeRequiredText(input.officialDecisionReference, 100)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const [award] = await context.db.select({ applicationId: sebFundingAward.applicationId })
    .from(sebFundingAward).where(eq(sebFundingAward.id, input.awardId)).limit(1)
  const submission = award ? await latestSubmission(context.db, award.applicationId) : null
  if (!reference || !validDate(input.officialDecisionDate) || !message || !submission ||
      !await approvedReason(context.db, {
        id: input.reasonCategoryId,
        cycleId: submission.snapshot.programmeCycleId,
        version: submission.snapshot.programmeCycleVersion,
        context: 'RECOVERY',
      })) {
    return failure('Enter valid recovery authorization details.')
  }
  const id = await constraintSafe(() => openRecoveryWrite(context, {
    ...input,
    officialReference: reference,
    officialDate: input.officialDecisionDate,
    applicantMessage: message,
    actorId: administrator.id,
    now: new Date(),
  }))
  return id ? success(await recoveryWorkspace(context.db, id)) : failure(STALE_MESSAGE)
}

export const recordRecoveryEntry = async (
  input: {
    recoveryCaseId: string
    expectedLedgerVersion: number
    entryType: 'DEMAND' | 'RECEIPT' | 'WAIVER' | 'REVERSAL'
    component: RecoveryComponent
    relatedEntryId?: string | null
    amountPaise: number
    externalReference: string
    occurredAt: Date
    reasonCategoryId?: string | null
    applicantMessage: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'STAFF_WRITE')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reference = normalizeRequiredText(input.externalReference, 100)
  const message = normalizeRequiredText(input.applicantMessage, 1_000)
  const related = input.relatedEntryId ?? null
  const reason = input.reasonCategoryId ?? null
  const recovery = await recoveryWorkspace(context.db, input.recoveryCaseId)
  const submission = recovery
    ? await latestSubmission(context.db, recovery.recoveryCase.applicationId) : null
  const requiredReasonContext = input.entryType === 'WAIVER'
    ? 'RECOVERY_WAIVER' : input.entryType === 'REVERSAL' ? 'RECOVERY' : null
  if (!expectedVersion(input.expectedLedgerVersion) || !positiveMoney(input.amountPaise) ||
      !reference || !message || !validInstant(input.occurredAt) ||
      (input.entryType === 'REVERSAL' ? related === null : related !== null) ||
      (requiredReasonContext !== null && (!reason || !submission ||
        !await approvedReason(context.db, {
          id: reason,
          cycleId: submission.snapshot.programmeCycleId,
          version: submission.snapshot.programmeCycleVersion,
          context: requiredReasonContext,
        })))) {
    return failure('Enter valid recovery-ledger details.')
  }
  const id = await constraintSafe(() => recordRecoveryEntryWrite(context, {
    ...input,
    relatedEntryId: related,
    reasonCategoryId: reason,
    externalReference: reference,
    applicantMessage: message,
    actorId: administrator.id,
    now: new Date(),
  }))
  return id ? success(await recoveryWorkspace(context.db, input.recoveryCaseId)) : failure(STALE_MESSAGE)
}

export const closeRecoveryCase = async (
  input: { recoveryCaseId: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const authorized = await authorizeReasonedTransition(
    context,
    'STAFF_WRITE', input, 'Enter a valid closure reason.',
  )
  if ('refusal' in authorized) return authorized.refusal
  const changed = await constraintSafe(() => closeRecoveryWrite(context, {
    ...input,
    reason: authorized.reason,
    actorId: authorized.actorId,
    now: new Date(),
  }))
  return changed ? success(await recoveryWorkspace(context.db, input.recoveryCaseId)) : failure('Recovery can close only at a zero balance with a current version.')
}

export const cancelRecoveryCase = async (
  input: { recoveryCaseId: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const authorized = await authorizeReasonedTransition(
    context,
    'STAFF_WRITE', input, 'Enter a valid recovery cancellation reason.',
  )
  if ('refusal' in authorized) return authorized.refusal
  const changed = await constraintSafe(() => cancelRecoveryWrite(context, {
    ...input,
    reason: authorized.reason,
    actorId: authorized.actorId,
    now: new Date(),
  }))
  return changed
    ? success(await recoveryWorkspace(context.db, input.recoveryCaseId))
    : failure('Only an empty, current recovery case can be cancelled.')
}
