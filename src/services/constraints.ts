/**
 * What the database refused, told apart from what went wrong.
 *
 * Two services turn an expected refusal into a business answer — an applicant
 * whose enterprise name is taken, an officer whose cycle code is — and each
 * kept its own copy of "was this a constraint?". Both copies matched the words
 * `constraint`, `unique` and `foreign key` against `error.message`, which was
 * true of the driver's own error and is not true of Drizzle's wrapper: its
 * message is the SQL it tried, and the database's error moved to `cause`. So
 * both copies stopped catching anything, and every duplicate surfaced as an
 * unhandled error instead of a sentence.
 *
 * One definition now, and by SQLSTATE rather than prose.
 */

/**
 * Unique violation. Somebody else took the value.
 *
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const UNIQUE_VIOLATION = '23505'

/** Foreign key violation. What the row named is not there. */
const FOREIGN_KEY_VIOLATION = '23503'

/**
 * Whether a write failed because the database refused it on integrity grounds
 * a caller can lose honestly.
 *
 * **Only those two.** A check or not-null violation means the layer above
 * passed on an input it should have refused; reporting that as an ordinary
 * conflict tells the user to try again, which cannot help, and hides the
 * defect. Class 23 as a whole was too wide — the desk-review reason check
 * proved it by being swallowed as "the record changed".
 *
 * The cause chain is walked because the driver's error arrives wrapped, and
 * the depth is bounded so a self-referential `cause` cannot spin.
 */
export const isExpectedConstraintError = (error: unknown): boolean => {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (code === UNIQUE_VIOLATION || code === FOREIGN_KEY_VIOLATION) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Runs a write, turning a lost race into `null` rather than a thrown error.
 *
 * The companion to `isExpectedConstraintError`, and it lives beside it for the
 * same reason that function does: a second copy of "which failures mean try
 * again" is a second answer waiting to disagree. It was in
 * `services/admin/support.ts`, which is where the first caller happened to be —
 * `services/auth` needs it too, and reaching across into the admin package for
 * it would make one service's helpers another's dependency.
 */
export const constraintSafe = async <T>(operation: () => Promise<T>): Promise<T | null> => {
  try {
    return await operation()
  } catch (error) {
    if (isExpectedConstraintError(error)) return null
    throw error
  }
}
