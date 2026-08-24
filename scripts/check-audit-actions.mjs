/**
 * Fails when a declared audit action is one nothing can ever write.
 *
 * `auditActions` in the schema exists so that audit queries stay reliable and
 * action names do not drift. That only works if the names are real. Three of
 * them — every recovery action — were declared and never written by anything,
 * so the activity history silently contained no recovery at all: not the
 * demands, not the receipts, and not the waivers, which are public money being
 * written off.
 *
 * Nothing caught it because the catalogue is a set of constants that the SEB
 * writes do not import; they embed the action as a SQL literal. So the
 * catalogue read as a specification and behaved as a comment.
 *
 * This checks the two directions that matter:
 *
 *   * every declared action appears somewhere that writes audit rows, and
 *   * every action written into `core_audit_event` is one the catalogue
 *     declares — which is what actually stops a typo becoming a new,
 *     unqueryable action name.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)

/** Every `.ts` under src, so a new query file is covered without being listed. */
const sources = []
const walk = (dir) => {
  for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    if (entry.isDirectory()) walk(`${dir}${entry.name}/`)
    else if (entry.name.endsWith('.ts')) sources.push(`${dir}${entry.name}`)
  }
}
walk('')

const catalogue = readFileSync(new URL('db/schema/core/audit.ts', root), 'utf8')
/** Every declared action, by the key it is reached through. */
const byKey = new Map(
  [...catalogue.matchAll(/^\s*(\w+): '([A-Z][A-Z_]*\.[A-Z_]+)',$/gmu)].map((m) => [m[1], m[2]]),
)
const declared = new Set(byKey.values())
if (declared.size === 0) {
  throw new Error('No audit actions found in the catalogue. Has its shape changed?')
}

/*
 * Where an action may legitimately appear. The catalogue itself declares them,
 * and the tests name them to assert on them; neither is a place that writes
 * one, so counting them would make every action look reachable.
 */
const writers = sources.filter(
  (path) => path !== 'db/schema/core/audit.ts',
)

/*
 * An action reaches the database two ways, and both count as written:
 *
 *   auditActions.roleGranted          through the catalogue, so a typo is a
 *                                     TypeScript error
 *   'SEB.AWARD_CREATED'               as a SQL literal, where it is not
 *
 * The second is how three recovery actions came to be declared and never
 * written: nothing connected the constant to the string.
 */
const written = new Map()
for (const path of writers) {
  const text = readFileSync(new URL(path, root), 'utf8')
  for (const match of text.matchAll(/'([A-Z][A-Z_]*\.[A-Z_]+)'/gu)) {
    if (!written.has(match[1])) written.set(match[1], path)
  }
  for (const match of text.matchAll(/auditActions\.(\w+)/gu)) {
    const action = byKey.get(match[1])
    if (action && !written.has(action)) written.set(action, path)
  }
}

const problems = []

for (const action of [...declared].sort()) {
  if (!written.has(action)) {
    problems.push(
      `${action} is declared but nothing writes it — the history will never contain it`,
    )
  }
}

/*
 * The reverse direction needs a narrower net: plenty of SCREAMING_CASE strings
 * with a dot are not audit actions. Only look at the ones written next to an
 * audit insert.
 */
for (const path of writers) {
  const text = readFileSync(new URL(path, root), 'utf8')
  if (!text.includes('coreAuditEvent')) continue
  for (const match of text.matchAll(/'((?:SEB|AUTH|RBAC|USER)\.[A-Z_]+)'/gu)) {
    if (!declared.has(match[1])) {
      problems.push(`${path} writes ${match[1]}, which the catalogue does not declare`)
    }
  }
}

if (problems.length > 0) {
  throw new Error(
    'The audit catalogue and what the code writes disagree:\n\n' +
      [...new Set(problems)].map((line) => `  ${line}`).join('\n') +
      '\n\nAn action nobody writes is a note about an intention, not a vocabulary.\n',
  )
}

console.log(`Audit actions agree: ${declared.size} declared, all written, none stray.`)
