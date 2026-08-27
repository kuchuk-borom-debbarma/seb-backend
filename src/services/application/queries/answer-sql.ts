/**
 * Reaching one answer from SQL, in exactly one spelling.
 *
 * The administrative queue filters on the sector and the category, and it does
 * so **across every cycle at once** — so there is no single pinned template to
 * resolve a key from. That is what the role bindings are for: a role-bound
 * field must use its canonical key, which makes the key a literal here.
 *
 * ## Why this is a shared helper rather than an inline subquery
 *
 * The same reason the prefix search has one: **an index is only used when the
 * query's expression matches the indexed one.** Two spellings of "the sector
 * answer" would mean one of them silently scans every answer ever given, with
 * right results and no error. One function is what keeps the predicate and the
 * index the same expression.
 */
import { sql, type SQL } from 'drizzle-orm'
import {
  sebApplicationVersion,
  sebApplicationVersionAnswer,
} from '../../../db/schema'
import { ROLE_CANONICAL_KEY } from '../../../db/schema/seb/form-template'

/** Only a pinned role has a literal key SQL can name. */
type PinnedRole = keyof typeof ROLE_CANONICAL_KEY

/**
 * The text stored for one role-bound answer of the given application version.
 *
 * Correlated rather than joined: a join would multiply the driving row by every
 * answer it has, and the queue's `LIMIT` would then bound answers rather than
 * applications.
 *
 * Only ever the top-level answer — `entry_index` and `value_ordinal` are both
 * zero — because a role-bound field cannot sit inside a repeated group or offer
 * several values. The schema refuses both, so this is reading a guarantee
 * rather than assuming one.
 */
export const roleAnswerText = (role: PinnedRole): SQL<string | null> => sql`(
  SELECT ${sebApplicationVersionAnswer.valueText}
  FROM ${sebApplicationVersionAnswer}
  WHERE ${sebApplicationVersionAnswer.applicationVersionId} = ${sebApplicationVersion.id}
    AND ${sebApplicationVersionAnswer.fieldKey} = ${ROLE_CANONICAL_KEY[role]}
    AND ${sebApplicationVersionAnswer.entryIndex} = 0
    AND ${sebApplicationVersionAnswer.valueOrdinal} = 0
)`
