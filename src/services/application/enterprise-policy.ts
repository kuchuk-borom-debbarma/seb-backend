/**
 * How many enterprises one applicant may hold, and what makes two of them the
 * same.
 *
 * ## The cap is read, never remembered
 *
 * Parsed on each call rather than captured at module scope, for the reason
 * `src/index.ts` gives about its own configuration: a value read once is shared
 * by every request the isolate serves, and the suite runs a single worker, so a
 * cached limit would be whatever the first test set.
 *
 * ## A bad value refuses rather than defaults
 *
 * An unset variable takes the documented default, because an unconfigured
 * machine is a developer's. A *present* one that is not a usable number is a
 * deployment mistake, and quietly falling back to 5 would hide it — the same
 * fail-closed rule the transport factories follow when a key is missing.
 */

/** The default when nothing is configured. Generous: one promoter genuinely
    may run several businesses, and this exists to stop dozens, not two. */
export const DEFAULT_MAX_ENTERPRISES_PER_USER = 5

/** The widest a deployment may set it. Beyond this it is not a limit. */
const MAX_CONFIGURABLE = 50

export type EnterpriseLimit =
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly reason: string }

/**
 * How many enterprises this deployment allows one applicant.
 *
 * Returns a refusal rather than throwing, so the controller can turn it into
 * the same envelope every other failure uses instead of a 500.
 */
export const maxEnterprisesPerUser = (configured: string | undefined): EnterpriseLimit => {
  if (configured === undefined || configured.trim() === '') {
    return { ok: true, limit: DEFAULT_MAX_ENTERPRISES_PER_USER }
  }
  /*
   * Plain decimal digits only, checked before parsing.
   *
   * `Number()` accepts far more than a person setting a limit would write:
   * `0x10` is sixteen, `1e3` is a thousand, `  7  ` is seven. Accepting those
   * means a deployment can end up running a limit nobody typed, and the
   * operator would have no way to tell from the value they set.
   */
  const trimmed = configured.trim()
  if (!/^\d+$/u.test(trimmed)) {
    return {
      ok: false,
      reason:
        'Enterprise registration is misconfigured on this deployment and cannot accept new enterprises.',
    }
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONFIGURABLE) {
    return {
      ok: false,
      reason:
        'Enterprise registration is misconfigured on this deployment and cannot accept new enterprises.',
    }
  }
  return { ok: true, limit: parsed }
}

/**
 * What an applicant is told when they are at the limit.
 *
 * Names the limit and what to do about it. "You have reached the limit" with no
 * number leaves somebody unable to tell whether deleting one would help.
 */
export const enterpriseLimitReached = (limit: number): string =>
  `You can hold ${limit} ${limit === 1 ? 'enterprise' : 'enterprises'} at a time. ` +
  'Delete one you no longer need before registering another.'

/** What they are told when the name is already theirs. */
export const DUPLICATE_ENTERPRISE_NAME_MESSAGE =
  'You have already registered an enterprise with this name.'

/**
 * Comparing two enterprise names the way the database does.
 *
 * The unique index is on `(portal_owner_user_id, lower(current_name))`, so this
 * must lower-case and nothing else — collapsing whitespace here without
 * collapsing it in the index would make the friendly check and the constraint
 * disagree, and the disagreement would surface as "the record changed" on a
 * name that plainly is not taken.
 *
 * Note what the uniqueness deliberately is *not*: it is per owner, not global.
 * Two unrelated applicants may register businesses with the same trading name,
 * because names are not identifiers — the identifiers are the GSTIN and the
 * registration number, and those are unique across the whole programme.
 */
export const comparableEnterpriseName = (name: string): string => name.toLowerCase()
