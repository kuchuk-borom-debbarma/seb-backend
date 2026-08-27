/**
 * Fails when a positional `INSERT INTO t <SELECT …>` does not match its table.
 *
 * Every guarded write in this repository is one data-modifying statement whose
 * dependent inserts select from the row it changed. Drizzle's
 * `.insert(t).select(sql`…`)` emits **no column list**, so the select is matched
 * to the table by position — the same hazard as the D1 batch that mapped results
 * by column name while an awaited query mapped positionally.
 *
 * Two ways it goes wrong, and neither is caught by TypeScript, because the
 * select is a template string:
 *
 *   * one expression too many, and Postgres refuses — but only at run time, on
 *     the one code path that reaches that insert, which for a correction or a
 *     recovery entry may be months after it was written;
 *   * one too few, and Postgres **accepts it** and the trailing column takes its
 *     default. That is the dangerous direction: a decision silently recorded
 *     with `conflict_acknowledged = false` looks exactly like an honest one.
 *
 * Adding a column to a table is what makes both happen at once, everywhere.
 * So the arity is checked against the schema as applied to a real Postgres,
 * rather than against a second list somebody would have to remember to update.
 */

/*
 * Excluded from `fallow`'s health scores, with `scripts/**` in `.fallowrc.json`.
 *
 * Only the CRAP dimension ever breached, and CRAP is complexity weighted by how
 * *untested* something is — these have no unit tests because running them is the
 * test: each is a step of `npm run check`, and each was proven against the exact
 * line that made it necessary before it was added. Chasing the number would mean
 * writing tests for a test.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
await db.exec(readFileSync('database/schema.sql', 'utf8'))

const columns = new Map()
for (const row of (await db.query(`
  SELECT table_name, count(*)::int AS n FROM information_schema.columns
  WHERE table_schema = 'public' GROUP BY table_name`)).rows) {
  columns.set(row.table_name, row.n)
}

/** camelCase drizzle export → snake_case table, by the repo's own convention. */
const tableOf = (identifier) =>
  identifier.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(`${dir}/${entry.name}`)
    else if (entry.name.endsWith('.ts')) files.push(`${dir}/${entry.name}`)
  }
}
walk('src/services')

/**
 * The select list, and how many expressions it holds.
 *
 * Both the cut and the count are taken at bracket depth zero: a `WHERE` inside
 * a `CASE WHEN EXISTS (…)` is not the statement's own `WHERE`, and a comma
 * inside a call is not a separator.
 */
const selectList = (body) => {
  let depth = 0
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i]
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1
    else if (depth === 0 && /\s/u.test(character)) {
      const rest = body.slice(i + 1)
      if (/^(FROM|WHERE)\s/u.test(rest)) return body.slice(0, i)
    }
  }
  return body
}

const topLevelCount = (list) => {
  let depth = 0
  let n = 1
  for (const character of list) {
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1
    else if (character === ',' && depth === 0) n += 1
  }
  return n
}

let checked = 0
const problems = []
for (const path of files) {
  const text = readFileSync(path, 'utf8')
  const pattern = /\.insert\((\w+)\)\s*\.select\(sql`\s*SELECT([\s\S]*?)`\s*\)/gu
  for (const match of text.matchAll(pattern)) {
    const table = tableOf(match[1])
    const expected = columns.get(table)
    if (expected === undefined) {
      problems.push(`${path}: ${match[1]} → no table ${table}`)
      continue
    }
    const actual = topLevelCount(selectList(match[2]))
    checked += 1
    if (actual !== expected) {
      problems.push(
        `${path}: INSERT INTO ${table} selects ${actual}, table has ${expected}`,
      )
    }
  }
}

if (problems.length > 0) {
  throw new Error(
    'A positional insert does not match its table:\n\n' +
      problems.map((line) => `  ${line}`).join('\n') +
      '\n\nToo few expressions is the silent one: the trailing columns take ' +
      'their defaults.\n',
  )
}

console.log(`Positional inserts agree: ${checked} checked against the schema.`)
