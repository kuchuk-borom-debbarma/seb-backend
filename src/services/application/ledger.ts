/**
 * Pure accounting fold over an award's append-only disbursement ledger.
 *
 * A mistaken release is never edited or deleted; it is corrected by a positive
 * reversal that references it. Every consumer therefore has to pair reversals
 * back to their releases before it can state what an award actually paid out.
 * Keeping that in one place means the applicant funding view, expansion
 * eligibility, and any future report can never disagree about the same award.
 *
 * The fold preserves the caller's ordering, because callers care about which
 * release came first for different reasons: eligibility needs the first release
 * that still retains money, while the applicant view lists them as they were
 * recorded.
 */

export type LedgerEntry = {
  id: string
  entryType: 'RELEASE' | 'REVERSAL'
  relatedDisbursementId: string | null
  amountPaise: number
}

export type LedgerRelease<T extends LedgerEntry> = {
  release: T
  /** Total reversed against this release; zero when none was. */
  reversedAmountPaise: number
  /** What this release still counts for after its reversals. */
  retainedAmountPaise: number
}

export type LedgerTotals<T extends LedgerEntry> = {
  releases: LedgerRelease<T>[]
  grossReleasedPaise: number
  reversedPaise: number
  netReleasedPaise: number
}

export const foldDisbursementLedger = <T extends LedgerEntry>(
  entries: readonly T[],
): LedgerTotals<T> => {
  const reversedByRelease = new Map<string, number>()
  for (const entry of entries) {
    // A reversal must reference a same-award release, which the schema enforces
    // with a composite foreign key. An entry without that reference cannot
    // reduce any particular release and is skipped rather than guessed at.
    if (entry.entryType !== 'REVERSAL' || !entry.relatedDisbursementId) continue
    reversedByRelease.set(
      entry.relatedDisbursementId,
      (reversedByRelease.get(entry.relatedDisbursementId) ?? 0) + entry.amountPaise,
    )
  }
  const releases = entries
    .filter((entry) => entry.entryType === 'RELEASE')
    .map((release) => {
      const reversedAmountPaise = reversedByRelease.get(release.id) ?? 0
      return {
        release,
        reversedAmountPaise,
        retainedAmountPaise: release.amountPaise - reversedAmountPaise,
      }
    })
  const grossReleasedPaise = releases.reduce(
    (total, entry) => total + entry.release.amountPaise,
    0,
  )
  const reversedPaise = releases.reduce(
    (total, entry) => total + entry.reversedAmountPaise,
    0,
  )
  return {
    releases,
    grossReleasedPaise,
    reversedPaise,
    netReleasedPaise: grossReleasedPaise - reversedPaise,
  }
}
