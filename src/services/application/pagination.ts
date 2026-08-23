/**
 * Keyset pagination.
 *
 * Every list seeks by `(timestamp, id)` rather than counting rows, so page ten
 * costs what page one costs and a row inserted mid-walk cannot shift the window.
 *
 * A cursor also records **which column it was ordered by**. The administrative
 * queue can order by any of three timestamps, and a cursor that did not say
 * which one it came from was accepted under a different ordering and silently
 * seeked against the wrong column — a wrong page of results with no error.
 * Naming the key makes that a refusal instead.
 */

/** The column a page was ordered by. Part of the cursor, not decoration. */
export type SortKey =
  | 'updatedAt'
  | 'createdAt'
  | 'statusChangedAt'
  | 'submittedAt'
  | 'scheduledAt'

export const pageSize = (first: number | null | undefined): number | null => {
  if (first === null || first === undefined) return 20
  return Number.isInteger(first) && first >= 1 && first <= 100 ? first : null
}

export const encodeCursor = (sortKey: SortKey, date: Date, id: string): string =>
  btoa(JSON.stringify([sortKey, date.getTime(), id]))

/**
 * Reads a cursor, refusing one that belongs to a different ordering.
 *
 * Returns `null` for no cursor, `'INVALID'` for anything malformed or ordered
 * by another column, and the position otherwise.
 */
export const decodeCursor = (
  cursor: string | null | undefined,
  expectedSortKey: SortKey,
): { timestamp: Date; id: string } | null | 'INVALID' => {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(atob(cursor))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== expectedSortKey ||
      !Number.isSafeInteger(parsed[1]) ||
      typeof parsed[2] !== 'string' ||
      parsed[2] === ''
    ) return 'INVALID'
    const timestamp = new Date(parsed[1])
    return Number.isNaN(timestamp.getTime()) ? 'INVALID' : { timestamp, id: parsed[2] }
  } catch {
    return 'INVALID'
  }
}
