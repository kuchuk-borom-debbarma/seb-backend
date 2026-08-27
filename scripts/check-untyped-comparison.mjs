/**
 * Refuses a SQL comparison whose both sides are bound values.
 *
 * `sql`${a} <= ${b}`` binds two parameters and gives Postgres nothing to infer
 * a type from, so it resolves the pair as `text` and compares the decimal
 * digits as a string. Nothing throws, every layer above reads correctly, and
 * the answer is wrong in both directions: `900000 <= 10000000` is false and
 * `2000000 <= 900000` is true.
 *
 * That shipped once, in the guard bounding a programme approval by what the
 * applicant asked for — so an approval within the request was refused, and one
 * several times larger was accepted. See `approvalGuard` in
 * `src/services/admin/queries/decision.ts`.
 *
 * The rule: at least one side of a comparison must carry a type — a column, a
 * literal, or an explicit cast. A column reference is enough on its own, which
 * is why the overwhelming majority of comparisons in this repository are fine
 * and only a value-against-value pair is reported.
 *
 * This scans source text rather than parsing SQL, so it is deliberately narrow:
 * it catches the written-out shape that caused the incident, not every way one
 * could be constructed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sources = []
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts')) sources.push(path)
  }
}
walk('src')

/*
 * The table objects, read from the schema rather than listed here — a new
 * table must not quietly start reading as an untyped value.
 */
const tableNames = new Set()
for (const path of sources.filter((each) => each.startsWith('src/db/schema'))) {
  for (const match of readFileSync(path, 'utf8').matchAll(
    /export const (\w+) = pgTable\(/g,
  )) tableNames.add(match[1])
}
if (tableNames.size === 0) {
  console.error('check:untyped-comparison found no tables — the schema scan is broken.')
  process.exit(1)
}

/** Whether an interpolated expression gives Postgres something to infer from. */
const carriesType = (expression) => {
  const text = expression.trim()
  if (text.includes('::')) return true
  /*
   * A call returns a SQL fragment, which is inlined rather than bound — the
   * comparison then has a real expression on that side.
   */
  if (text.includes('(')) return true
  // `${sebApplication.id}` and `${table.foo}` render as column references.
  const [root] = text.split('.')
  return tableNames.has(root) || root === 'table'
}

const comparison = /\$\{([^}]+)\}\s*(<=|>=|<>|<|>)\s*\$\{([^}]+)\}/g

/*
 * Only inside a `sql` template. A cookie header and a signature payload are
 * also `name=${value}` and have nothing to do with Postgres; scanning every
 * template literal reported both and would have taught the next reader to
 * ignore this check.
 */
const sqlTemplates = /\bsql`((?:[^`\\]|\\.)*)`/gs

const findings = []
for (const path of sources) {
  const text = readFileSync(path, 'utf8')
  for (const template of text.matchAll(sqlTemplates)) {
    for (const match of template[1].matchAll(comparison)) {
      if (carriesType(match[1]) || carriesType(match[3])) continue
      const line = text.slice(0, template.index + match.index).split('\n').length
      findings.push(`${path}:${line}  ${match[0].trim()}`)
    }
  }
}

if (findings.length > 0) {
  console.error('Comparison between two bound values — Postgres resolves both as text:')
  for (const finding of findings) console.error(`  ${finding}`)
  console.error('\nCast at least one side (e.g. `${value}::bigint`), or compare against a column.')
  process.exit(1)
}
console.log(
  `check:untyped-comparison: ${sources.length} files, ${tableNames.size} tables, clean`,
)
