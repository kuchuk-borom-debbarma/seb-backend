/**
 * The email an applicant gets when a stage sends their application back.
 *
 * Three different acts can ask the applicant to change something — a desk
 * review requesting revision, a partner bank wanting more information, and a
 * decision of revision required — and each already records what to correct
 * and what the applicant is told. This module is the one place that turns
 * that record into a message, so every stage that unlocks the application
 * for editing also tells its owner, in the same shape, that it did.
 *
 * Best-effort like every applicant mail: the recorded outcome stands whether
 * or not the message leaves, and a failure is audited so the office can see
 * an applicant who was never told.
 */
import { auditActions } from '../../db/schema'
import { findUserEmailById } from '../application/queries/application'
import { findPinnedCycleRules } from '../application/queries/form-template'
import { confirmationPdfUrl } from '../application/confirmation-link'
import { createAuditEvent } from '../auth/queries/auth'
import { sendNotification } from '../external-notification'
import { latestSubmission, loadApplicationHead } from './queries/intake'
import { adminAudit } from './support'
import { bestEffort } from '../best-effort'
import type { AdminOperationContext } from './types'

/** OWNERS_DETAILS reads as "Owners details" if the template cannot be read. */
const humanized = (stageKey: string) =>
  stageKey.charAt(0) + stageKey.slice(1).toLowerCase().replaceAll('_', ' ')

export const sendRevisionRequestNotification = async (
  context: AdminOperationContext,
  input: {
    applicationId: string
    actorId: string
    /** What the recording officer wrote for the applicant, already trimmed. */
    applicantMessage: string | null
    revisions: readonly { stageKey: string; note: string }[]
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
    // The pinned template names the stages the way the applicant sees them.
    const rules = await findPinnedCycleRules(
      context.db,
      submission.snapshot.programmeCycleId,
      submission.snapshot.programmeCycleVersion,
    )
    const titled = (stageKey: string) =>
      rules?.template.stages.find((stage) => stage.key === stageKey)?.title
        ?? humanized(stageKey)
    const corrections = input.revisions
      .map((revision) => `- ${titled(revision.stageKey)}: ${revision.note.trim()}`)
      .join('\n')
    const reference = head.application.referenceNumber ?? input.applicationId
    const url = await confirmationPdfUrl(
      context.env, context.requestUrl, input.applicationId, new Date(),
    )
    await sendNotification({
      to: email,
      subject: 'Your Mission SEP application needs changes',
      body:
        'Your Mission SEP application has been reviewed, and it needs changes '
        + 'before it can go forward.\n\n'
        + (input.applicantMessage ? `${input.applicantMessage}\n\n` : '')
        + `Reference: ${reference}\n\n`
        + 'What to correct:\n'
        + `${corrections}\n\n`
        + 'Sign in, open the application, make the corrections and submit it '
        + 'again. Only the parts named above are unlocked for editing. A copy '
        + 'of what you submitted is attached.',
      attachments: [{
        filename: `application-${reference}.pdf`,
        contentType: 'application/pdf',
        url,
      }],
    }, context.env)
  } catch {
    // Guarded itself, so the recorded outcome can never be disturbed.
    await bestEffort(createAuditEvent(context.db, {
      ...adminAudit(context, {
        actorUserId: input.actorId,
        action: auditActions.revisionNotificationFailed,
        entityType: 'SEB_APPLICATION',
        entityId: input.applicationId,
        now: new Date(),
      }),
      outcome: 'FAILURE',
    }), 'A revision notification failed')
  }
}
