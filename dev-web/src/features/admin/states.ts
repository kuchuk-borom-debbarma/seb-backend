/**
 * The state vocabularies the administrative screens branch on.
 *
 * These are not free strings: each is an enum the database defines, and the
 * screens decide what to offer by comparing against them. Guessing one wrong —
 * a referral that has been answered is `RESPONDED`, not closed — silently hides
 * a control that should be there, and nothing fails loudly. So they are written down once, from the schema, and
 * every screen reads them from here.
 *
 * Source: `src/db/schema/seb/decision.ts` and `src/db/schema/seb/recovery.ts`.
 */

/** `bankReferralStatuses`. */
export const REFERRAL_STATES = {
  /** Sent, and the bank has not answered. */
  open: 'OPEN',
  /** The bank has given an outcome. */
  responded: 'RESPONDED',
  cancelled: 'CANCELLED',
} as const

export const REFERRAL_TITLES: Record<string, string> = {
  OPEN: 'Awaiting the bank',
  RESPONDED: 'Answered',
  CANCELLED: 'Withdrawn',
}

/**
 * `recoveryCaseStatuses`. A case is live through several of these — money can
 * still move until it is settled, cancelled or closed.
 */
export const RECOVERY_TITLES: Record<string, string> = {
  OPEN: 'Open',
  DEMANDED: 'Demanded',
  PARTIALLY_SETTLED: 'Partly settled',
  SETTLED: 'Settled',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed',
}

const RECOVERY_LIVE = new Set(['OPEN', 'DEMANDED', 'PARTIALLY_SETTLED', 'SETTLED'])

/** True while entries can still be added to a recovery case. */
export const recoveryIsLive = (status: string): boolean => RECOVERY_LIVE.has(status)
