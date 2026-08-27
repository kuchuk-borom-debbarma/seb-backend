/**
 * Refuses an unquoted mixed-case SQL alias.
 *
 * Postgres folds an unquoted identifier to lower case, so `AS currentVersion`
 * comes back on the row as `currentversion`. Reading `.currentVersion` then
 * yields `undefined` — no error, no null, just a property that is not there —
 * and the value travels on. Fifteen of these were hiding in one test file; the
 * one that surfaced sent `undefined` into a guarded write, where the driver
 * rendered it as *nothing at all* and Postgres reported a syntax error a long
 * way from the cause.
 *
 * SQLite was case-insensitive about this and preserved the alias as written,
 * which is why the whole codebase was full of them and none of it was wrong
 * until the port.
 *
 * `src` and `test` only. The guardrail scripts talk *about* the mistake, and
 * scanning them would report their own prose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const files = []
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts') || path.endsWith('.mjs')) files.push(path)
  }
}
walk('src')
walk('test')

// `AS name` where the name is unquoted and not already all one case.
const unquoted = /\bAS\s+([a-z]+[A-Z]\w*)\b/g

const findings = []
for (const path of files) {
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(unquoted)) {
    const line = text.slice(0, match.index).split('\n').length
    findings.push(`${path}:${line}  AS ${match[1]}`)
  }
}

if (findings.length > 0) {
  console.error('Unquoted mixed-case SQL alias — Postgres will fold it to lower case:')
  for (const finding of findings) console.error(`  ${finding}`)
  console.error('\nQuote it (`AS "currentVersion"`), or name it in snake_case.')
  process.exit(1)
}
console.log(`check:sql-aliases: ${files.length} files, no folded aliases`)
