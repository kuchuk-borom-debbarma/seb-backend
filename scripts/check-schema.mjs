#!/usr/bin/env node
/**
 * Proves `database/schema.sql` is what the Drizzle schema says.
 *
 * The file is generated, never hand-edited, and this is what makes that true
 * rather than merely asked for. It regenerates into memory and compares; a
 * difference means somebody changed one side without the other, and the diff
 * names which tables moved.
 *
 * `--write` regenerates the file, which is `npm run db:schema:generate`.
 *
 * There is deliberately no migration chain. Nothing is deployed and no database
 * exists that has to be kept, so the schema file *is* the schema and recreating
 * is the whole of applying it. The day a database exists that cannot be thrown
 * away, this becomes an ordered chain instead — and the note in
 * `src/db/schema/README.md` says so.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schemaFile = join(root, 'database', 'schema.sql')

const generate = () =>
  execFileSync(
    'npx',
    ['drizzle-kit', 'export', '--dialect=postgresql', '--schema=./src/db/schema/index.ts'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )

const generated = generate()

if (process.argv.includes('--write')) {
  writeFileSync(schemaFile, generated)
  console.log(`Wrote database/schema.sql (${generated.split('\n').length} lines).`)
  process.exit(0)
}

let current
try {
  current = readFileSync(schemaFile, 'utf8')
} catch {
  console.error('database/schema.sql is missing. Run `npm run db:schema:generate`.')
  process.exit(1)
}

if (current === generated) {
  console.log('database/schema.sql matches src/db/schema.')
  process.exit(0)
}

/* Name what moved rather than printing 1,400 lines at somebody. */
const tablesIn = (sql) =>
  new Set([...sql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((match) => match[1]))
const before = tablesIn(current)
const after = tablesIn(generated)
const added = [...after].filter((name) => !before.has(name))
const removed = [...before].filter((name) => !after.has(name))

console.error('database/schema.sql does not match src/db/schema.')
if (added.length) console.error(`  tables added:   ${added.join(', ')}`)
if (removed.length) console.error(`  tables removed: ${removed.join(', ')}`)
if (!added.length && !removed.length) {
  console.error('  the same tables, but their definitions differ')
}
console.error('Run `npm run db:schema:generate` and commit the result.')
process.exit(1)
