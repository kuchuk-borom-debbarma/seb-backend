/**
 * Runs a side effect that must never fail the write it follows.
 *
 * The notification hooks and their failure audits all carry the same rule: the
 * guarded write has already succeeded, and nothing that happens afterwards —
 * a mail transport refusing, the audit insert for that refusal failing too —
 * may surface as an error to the caller who was told their write landed.
 *
 * One helper rather than a `.catch(() => …)` at each site, because each site's
 * inline lambda was one more function whose swallow-everything behaviour was
 * assumed rather than proven. This one is proven once.
 */
export const bestEffort = async (
  work: Promise<unknown>,
  onFailure?: string,
): Promise<void> => {
  try {
    await work
  } catch {
    if (onFailure) console.error(onFailure)
  }
}
