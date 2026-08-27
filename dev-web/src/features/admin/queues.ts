/**
 * The named work queues the programme office operates from.
 *
 * These are the API's own queue keys, not a grouping invented here. Two of them
 * — new submissions and revision responses — are both `SUBMITTED` applications,
 * separated by whether this is a first submission or an answer to a correction
 * request; that distinction matters to whoever picks the work up, which is why
 * the API names them separately.
 *
 * The order below is the order work moves through the office.
 */
import type { AdminIntakeQueueKey, ApplicationStatus } from '#/graphql/generated/schema'

export const QUEUE_KEYS: readonly AdminIntakeQueueKey[] = [
  'NEW_SUBMISSIONS',
  'REVISION_RESPONSES',
  'DESK_REVIEW',
  'PARTNER_BANK_EVALUATION',
  'AWAITING_DECISION',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
]

export const QUEUE_TITLES: Record<AdminIntakeQueueKey, string> = {
  NEW_SUBMISSIONS: 'New submissions',
  REVISION_RESPONSES: 'Revision responses',
  DESK_REVIEW: 'Desk review',
  PARTNER_BANK_EVALUATION: 'With the bank',
  AWAITING_DECISION: 'To decide',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SANCTIONED: 'Sanctioned',
  DISBURSED: 'Disbursed',
}

/** What each queue holds, so a staff member knows before they open it. */
export const QUEUE_DESCRIPTIONS: Record<AdminIntakeQueueKey, string> = {
  NEW_SUBMISSIONS: 'First submissions nobody has looked at yet.',
  REVISION_RESPONSES: 'Applicants have answered a correction request.',
  DESK_REVIEW: 'Checks are under way.',
  PARTNER_BANK_EVALUATION: 'Referred to a partner bank, awaiting its outcome.',
  AWAITING_DECISION: 'Cleared the bank stage and waiting to be decided.',
  APPROVED: 'Approved, awaiting a sanction order.',
  REJECTED: 'Closed without funding.',
  SANCTIONED: 'Sanctioned, awaiting release of funds.',
  DISBURSED: 'Money has been released.',
}

/**
 * The queues that are waiting on the programme office rather than on somebody
 * else. These are the ones the console leads with.
 */
export const ACTIONABLE_QUEUES = new Set<AdminIntakeQueueKey>([
  'NEW_SUBMISSIONS',
  'REVISION_RESPONSES',
  'DESK_REVIEW',
])

/**
 * How a status is toned wherever it appears.
 *
 * Only three statuses earn a colour: one that needs the applicant, one that
 * ended badly, and one that ended well. Everything else is ordinary progress,
 * and colouring all eleven would make the three that matter invisible.
 */
export const statusTone = (
  status: ApplicationStatus,
): 'action' | 'error' | 'ok' | undefined => {
  if (status === 'REVISION_REQUIRED') return 'action'
  if (status === 'REJECTED' || status === 'CANCELLED') return 'error'
  if (status === 'DISBURSED') return 'ok'
  return undefined
}

/** How long something has been waiting, in the terms a person would use. */
export const waitingFor = (since: string): string => {
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000)
  if (days < 1) return 'Today'
  if (days === 1) return '1 day'
  return `${days} days`
}
