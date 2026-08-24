/**
 * Applies pending schema migrations, in order, to a D1 database.
 *
 * ## Why this exists alongside database/schema.sql
 *
 * The baseline creates every table in its current shape and is guarded with
 * `IF NOT EXISTS`, so applying it twice is harmless. That is not a migration.
 * `IF NOT EXISTS` only helps an object that does not exist yet: against a
 * database whose table already exists with an older `CHECK` constraint, the
 * statement is skipped and the old constraint stays — silently, and reported as
 * success. SQLite cannot `ALTER` a `CHECK` at all, so changing one means
 * creating a new table, copying the rows, dropping the old and renaming.
 *
 * That work has to be written by hand, in order, once per database. This runs
 * it.
 *
 * ## Two entry points, because a new database has no history to replay
 *
 *   --stamp   record every migration as applied without running it. Used
 *             immediately after the baseline, which already contains their
 *             effect. Replaying them against a fresh database would at best
 *             fail and at worst rebuild a table that was never old.
 *
 *   (default) apply whatever is not yet recorded.
 *
 * Each file is applied in ONE batch together with its ledger row, because one
 * batch is one transaction. Recording afterwards would let a crash in between
 * leave a database migrated but unaware of it, and the next run would apply the
 * same file again — which, for a table rebuild, destroys data rather than
 * erroring.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsUrl = new URL('../database/migrations/', import.meta.url)
const stamping = process.argv.includes('--stamp')
const remote = process.argv.includes('--remote')
/*
 * Which local database to act on. The end-to-end suite keeps its own, entirely
 * separate from the one behind `npm run local`, so that running the tests never
 * disturbs a developer's data.
 */
const persistTo = process.argv
  .find((argument) => argument.startsWith('--persist-to='))
  ?.slice('--persist-to='.length)

/**
 * Ordered by filename, which is why they are numbered.
 *
 * Sorted with an explicit comparator rather than the default: the default sort
 * is lexicographic over UTF-16 units, which is the same thing here only because
 * the numbers are zero-padded. Stating the intent means a file named without
 * padding fails the format check below instead of quietly running last.
 */
const migrations = readdirSync(fileURLToPath(migrationsUrl))
  .filter((name) => name.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right, 'en'))

const misnamed = migrations.filter((name) => !/^\d{4}-[a-z0-9-]+\.sql$/u.test(name))
if (misnamed.length > 0) {
  throw new Error(
    `Migration filenames must be NNNN-kebab-case.sql: ${misnamed.join(', ')}`,
  )
}

const d1 = (args) =>
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
      'd1',
      'execute',
      'DB',
      remote ? '--remote' : '--local',
      ...(persistTo ? ['--persist-to', persistTo] : []),
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: undefined } },
  )

/**
 * What this database has already had applied.
 *
 * An error here means the ledger table is missing, which means the baseline was
 * never applied — so there is nothing to migrate and saying that plainly is
 * more useful than a SQL error about a missing table.
 */
let applied
try {
  const output = d1(['--json', '--command', 'SELECT id FROM core_schema_migration'])
  applied = new Set(
    (JSON.parse(output)[0]?.results ?? []).map((row) => row.id),
  )
} catch {
  throw new Error(
    'core_schema_migration is missing. Apply database/schema.sql first (npm run db:setup:local).',
  )
}

const pending = migrations.filter((name) => !applied.has(name.replace(/\.sql$/u, '')))

if (pending.length === 0) {
  console.log(`Nothing to do: ${applied.size} migration(s) already applied.`)
  process.exit(0)
}

for (const file of pending) {
  const id = file.replace(/\.sql$/u, '')
  /*
   * The ledger row is appended to the migration's own SQL so that both reach
   * the database as one statement list. wrangler runs a --file as a single
   * batch, which is what makes the pair atomic.
   */
  const body = stamping ? '' : readFileSync(new URL(file, migrationsUrl), 'utf8')
  const ledger = `INSERT INTO core_schema_migration (id, applied_at) VALUES ('${id}', ${Date.now()});`

  /*
   * Written to a file and applied with `--file`, never `--command`.
   *
   * `--command` does not reliably apply a multi-statement script — a sibling
   * script records losing half a seeded account to exactly that — and it is a
   * statement list that makes the migration and its ledger row one batch. With
   * `--command` a table rebuild could half-apply and then be re-run, which for
   * a rebuild destroys the rows it was copying rather than erroring.
   */
  const directory = mkdtempSync(join(tmpdir(), 'seb-migrate-'))
  try {
    const scratch = join(directory, `${id}.sql`)
    writeFileSync(scratch, `${body}\n${ledger}\n`)
    d1(['--file', scratch])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  console.log(stamping ? `Stamped ${id} (baseline already contains it).` : `Applied ${id}.`)
}

console.log(`${pending.length} migration(s) ${stamping ? 'stamped' : 'applied'}.`)
