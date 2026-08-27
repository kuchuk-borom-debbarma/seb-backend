/**
 * What a search term is allowed to match.
 *
 * These run against a real Postgres rather than asserting on the generated
 * string, because the bug they exist for is not visible in the pattern — it is
 * visible in the rows that come back. A `%` left unescaped produces a perfectly
 * reasonable-looking `LIKE '%%'` and returns the entire table.
 */
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prefixPattern } from '../../src/services/search'

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE cycle (code text NOT NULL);
    CREATE INDEX cycle_code_search_idx ON cycle (lower(code) text_pattern_ops);
    INSERT INTO cycle (code)
    SELECT 'SEP-' || to_char(g, 'FM000000') FROM generate_series(1, 500) AS g;
    INSERT INTO cycle (code) VALUES ('ODD%CODE'), ('ODD_CODE'), ('BACK\\SLASH');
    ANALYZE cycle;
  `)
})

afterAll(async () => {
  await db.close()
})

const matching = async (term: string): Promise<string[]> => {
  const pattern = prefixPattern(term)
  if (pattern === null) return []
  const result = await db.query<{ code: string }>(
    `SELECT code FROM cycle WHERE lower(code) LIKE $1 ESCAPE '\\' ORDER BY code`,
    [pattern],
  )
  return result.rows.map((row) => row.code)
}

describe('a search term matches what it says and nothing else', () => {
  it('matches by prefix, case-insensitively', async () => {
    expect(await matching('sep-000001')).toEqual(['SEP-000001'])
    expect(await matching('SEP-000001')).toEqual(['SEP-000001'])
  })

  it('matches every code sharing a prefix', async () => {
    expect(await matching('sep-00000')).toHaveLength(9)
  })

  it('does not match a substring that is not a prefix', async () => {
    expect(await matching('000001')).toEqual([])
  })

  /*
   * The bug this file exists for.
   *
   * `%` is LIKE's "any run of characters". Escaping the GLOB set instead — as
   * the SQLite version did — leaves it live, and a single `%` typed into a
   * search box returns the whole table while the page claims to be filtered.
   */
  it('treats a per-cent sign as a character somebody typed, not a wildcard', async () => {
    const everything = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM cycle')
    expect(everything.rows[0]!.n).toBe(503)

    const matched = await matching('%')
    expect(matched).not.toHaveLength(503)
    expect(matched).toEqual([])

    // And it still finds the code that genuinely contains one.
    expect(await matching('odd%')).toEqual(['ODD%CODE'])
  })

  /*
   * The quieter half. `_` matches exactly one character, so an unescaped one
   * returns near-misses — which looks like a helpful search rather than a bug.
   */
  it('treats an underscore as a character somebody typed', async () => {
    expect(await matching('odd_')).toEqual(['ODD_CODE'])
    // Not ODD%CODE, which an unescaped `_` would also have matched.
  })

  it('treats a backslash as a character somebody typed', async () => {
    expect(await matching('back\\')).toEqual(['BACK\\SLASH'])
  })

  it('finds nothing for an empty or whitespace-only term', () => {
    expect(prefixPattern('')).toBeNull()
    expect(prefixPattern('   ')).toBeNull()
    expect(prefixPattern(null)).toBeNull()
    expect(prefixPattern(undefined)).toBeNull()
  })
})

describe('the index actually serves the search', () => {
  /*
   * Proved rather than assumed, following this module's own standard. Without
   * `text_pattern_ops` the same query is a sequential scan: right answers,
   * quietly linear, and nothing fails.
   */
  it('uses the prefix index rather than scanning', async () => {
    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT code FROM cycle WHERE lower(code) LIKE $1 ESCAPE '\\'`,
      [prefixPattern('sep-000001')],
    )
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n')
    expect(text).toContain('cycle_code_search_idx')
  })
})
