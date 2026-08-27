/**
 * Index-backed prefix search.
 *
 * `lower(column) LIKE 'term%'` uses an index when that index is declared with
 * `text_pattern_ops`. The default operator class sorts by the database
 * collation, and a collated index cannot answer a pattern match — so without
 * the opclass this is a sequential scan that still returns the right rows and
 * nothing fails. The three search indexes in `src/db/schema` carry it, and
 * proving the plan rather than assuming it is the standard here.
 *
 * ## Prefix only, and now that is a choice
 *
 * It used to be a limitation: substring search could not use an index at all.
 * Postgres has `pg_trgm`, so it can — a trigram index would serve
 * `LIKE '%devi%'` and would genuinely help on a business name, where "Devi"
 * sits inside "Sri Devi Handlooms". It is not enabled, so the interface must go
 * on saying "starts with": a control that offers "search" and silently means
 * something narrower is a lie, and that is as true when the narrowing is
 * deliberate as when it was forced.
 */
import { or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

/** The longest term worth honouring; anything beyond it is not a search. */
const MAX_TERM = 64

/**
 * Normalizes what somebody typed into a prefix pattern, or null when there is
 * nothing to search for.
 *
 * **`%`, `_` and `\` are `LIKE`'s metacharacters and every one must be
 * escaped.** They are not the same set as the `*`, `?` and `[` this escaped
 * when the search ran on `GLOB`, and carrying the old set across is the whole
 * of the bug: `%` matches any run of characters, so a single unescaped `%` as
 * the search term matches **every row in the table** — measured, against twenty
 * thousand of them — inside a page whose count claims to describe the filter.
 *
 * `_` is the quieter half: it matches exactly one character, so a term
 * containing it silently returns near-misses the applicant did not ask for.
 *
 * The backslash must be escaped first, or escaping the others would double-escape
 * a backslash the person actually typed.
 */
export const prefixPattern = (term: string | null | undefined): string | null => {
  const trimmed = term?.trim().slice(0, MAX_TERM).toLowerCase()
  if (!trimmed) return null
  const escaped = trimmed
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
  return `${escaped}%`
}

/**
 * `lower(column) LIKE 'term%'`, for a column carrying a `text_pattern_ops` index.
 *
 * The escape character is stated explicitly. Postgres defaults to backslash,
 * but only while `standard_conforming_strings` is on — naming it means the
 * escaping above cannot be quietly undone by a server setting.
 */
export const prefixMatch = (column: SQLWrapper, pattern: string): SQL =>
  sql`lower(${column}) LIKE ${pattern} ESCAPE '\\'`

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
