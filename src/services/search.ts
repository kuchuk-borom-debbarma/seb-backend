/**
 * Index-backed prefix search.
 *
 * SQLite will not use an index for a case-insensitive `LIKE`, because `LIKE`
 * ignores case while a plain index is `BINARY`-collated. `GLOB` is
 * case-sensitive and binary, so lowering both the column and the term makes the
 * comparison case-insensitive *and* leaves it index-usable — which turns a full
 * table scan into a range seek on `lower(column)`.
 *
 * Prefix only. That is a real limit and the interface says so: a control that
 * offers "search" and silently means "starts with" is a lie. Substring search
 * cannot use an index at all, and full text would need an FTS5 virtual table,
 * which the generated-schema check cannot carry.
 */
import { or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

/** The longest term worth honouring; anything beyond it is not a search. */
const MAX_TERM = 64

/**
 * Normalizes what somebody typed into a GLOB prefix pattern, or null when there
 * is nothing to search for.
 *
 * `*`, `?` and `[` are GLOB metacharacters, so a term containing them would
 * otherwise match far more than it appears to. They are escaped with GLOB's own
 * character-class form, which is the only escape it has.
 */
export const prefixPattern = (term: string | null | undefined): string | null => {
  const trimmed = term?.trim().slice(0, MAX_TERM).toLowerCase()
  if (!trimmed) return null
  const escaped = trimmed.replaceAll(/[*?[]/gu, (character) => `[${character}]`)
  return `${escaped}*`
}

/** `lower(column) GLOB 'term*'`, for a column carrying a `lower()` index. */
export const prefixMatch = (column: SQLWrapper, pattern: string): SQL =>
  sql`lower(${column}) GLOB ${pattern}`

/**
 * True when any of the columns starts with the term.
 *
 * **Parenthesised, and that is the whole point.** `OR` binds looser than every
 * `AND` around it, so an unbracketed `a OR b` dropped into a filter list
 * collapses it to `(everything else AND a) OR b` — and a row matching `b` comes
 * back whatever its status, whatever its cycle, deleted or not. In the
 * administrative queue that meant a search returning soft-deleted applications
 * and unsubmitted drafts, which every other path takes care to hide, inside a
 * page whose count claimed to describe the filters.
 *
 * Built with `or()` rather than a joined string because that is the builder
 * that brackets: reaching for `sql.join` is what skipped it.
 */
export const prefixMatchAny = (columns: SQLWrapper[], pattern: string): SQL =>
  or(...columns.map((column) => prefixMatch(column, pattern)))!
