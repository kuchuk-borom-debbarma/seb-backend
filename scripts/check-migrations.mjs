/**
 * Proves the ways to reach the current schema agree.
 *
 * Two properties, and only one of them depends on a migration existing.
 *
 * **The baseline is executable and re-appliable.** `database/schema.sql` is
 * applied twice to an empty database and the resulting shape compared. The
 * first apply is what proves the generated file parses at all; the second is
 * what proves `IF NOT EXISTS` does what the file's own header claims. Nothing
 * else in the repo applies it twice, so if this goes, that claim is untested.
 *
 * **The baseline and the migration chain agree.** A database can also reach
 * today's shape by applying the migrations in order to one that predates them.
 * Nothing makes the two agree by construction — they are written separately,
 * and a change made to one and forgotten in the other is invisible until a
 * deploy.
 *
 * `database/migrations/` is currently empty, so the second proof is skipped
 * rather than run against nothing. Run anyway it would compare the baseline
 * with itself and could not fail, which is worse than not running: it would
 * report agreement that was never tested. See the directory's README for when
 * the first migration becomes necessary.
 *
 * Runs against node:sqlite rather than D1. D1 *is* SQLite, the statements here
 * are plain DDL, and needing a Worker to run a schema check would mean it never
 * ran in CI.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const baselineSql = readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8')
const migrationsUrl = new URL('../database/migrations/', import.meta.url)
const migrations = readdirSync(fileURLToPath(migrationsUrl))
  .filter((name) => name.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right, 'en'))

/**
 * Puts stored DDL into a form where only real differences survive.
 *
 * Two cosmetic differences are unavoidable and would otherwise fail every run:
 *
 *   * `ALTER TABLE ... RENAME` rewrites the stored DDL and quotes the table
 *     name with double quotes, where drizzle-kit emits backticks.
 *   * A rebuilt table's CHECK constraints name their columns unqualified,
 *     because a CHECK that qualifies its own table does not survive the rename.
 *
 * Both are spelling. Everything that matters — which columns exist, what each
 * constraint actually tests, which indexes are present — is preserved, so a
 * changed bound or a dropped column still fails.
 */
const normalize = (sql) =>
  (sql ?? '')
    .replaceAll('`', '"')
    .replace(/"[a-z0-9_]+"\."/gu, '"')
    .replace(/\s+/gu, ' ')
    .trim()

/** Every object a database contains, as a comparable set. */
const shapeOf = (db) =>
  new Set(
    db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all()
      .map((row) => `${row.type} ${row.name} ${normalize(row.sql)}`),
  )

// --- The baseline, applied twice ------------------------------------------
const fresh = new DatabaseSync(':memory:')
fresh.exec(baselineSql)
const afterFirst = shapeOf(fresh)
fresh.exec(baselineSql)
const afterSecond = shapeOf(fresh)

/*
 * Compared by contents, not by count. Counting would pass a second apply that
 * replaced an object's definition while leaving the number of objects alone —
 * unlikely from `IF NOT EXISTS` DDL, which can only add, but this is the only
 * proof the baseline has and a proof worth keeping is worth making exact.
 */
const changedOnReapply = [
  ...[...afterSecond].filter((object) => !afterFirst.has(object)),
  ...[...afterFirst].filter((object) => !afterSecond.has(object)),
]
if (changedOnReapply.length > 0) {
  throw new Error(
    'database/schema.sql is not re-appliable: a second apply changed the ' +
      `schema.\n\n${changedOnReapply.map((object) => `  ${object}`).join('\n')}\n`,
  )
}

// --- The migration chain ---------------------------------------------------
/*
 * The starting point is the baseline with each migration's effect undone,
 * which is the closest thing to a pre-migration database that exists — no old
 * baseline is kept, and keeping one would only move the problem.
 *
 * Each entry says how to age the schema back past one migration. They are
 * applied newest-first, so this list reads in the opposite order to the
 * directory.
 */
const rewind = []

const unknown = rewind.filter((entry) => !migrations.includes(entry.migration))
const unrewound = migrations.filter(
  (name) => !rewind.some((entry) => entry.migration === name),
)
if (unknown.length > 0 || unrewound.length > 0) {
  throw new Error(
    'Every migration needs an entry in `rewind` so this check can build a ' +
      `database that predates it. Missing: ${unrewound.join(', ') || 'none'}. ` +
      `Stale: ${unknown.map((entry) => entry.migration).join(', ') || 'none'}.`,
  )
}

/**
 * Indexes a shape by object, so the two sides can be compared one at a time.
 *
 * Printing two normalised `CREATE TABLE` statements in full is technically
 * complete and practically useless — they are a thousand characters that differ
 * in four. Splitting them lets objects present on one side only be named, and
 * objects present on both be reported as just the differing region.
 */
const byKey = (shapes) => {
  const index = new Map()
  for (const shape of shapes) {
    const [type, name] = shape.split(' ')
    index.set(`${type} ${name}`, shape.slice(type.length + name.length + 2))
  }
  return index
}

/*
 * The other route to today's shape, compared with the baseline.
 *
 * Only built when there is a chain to compare. With none, ageing the baseline
 * is the identity and this would compare the file with itself — a check that
 * always passes and therefore proves nothing. Written inline rather than as
 * helpers because nothing here is reachable from a test: scripts carry no
 * coverage, so a named function would report as untested code forever.
 */
if (migrations.length === 0) {
  console.log(
    'database/schema.sql is the whole schema: it applies cleanly and re-applies '
      + 'to no effect. No migrations to reconcile it with.',
  )
} else {
  let agedSql = baselineSql
  for (const entry of rewind) agedSql = entry.age(agedSql)

  if (agedSql === baselineSql) {
    throw new Error('Ageing the baseline changed nothing; the rewind rules no longer match.')
  }

  const migrated = new DatabaseSync(':memory:')
  migrated.exec(agedSql)
  for (const name of migrations) {
    migrated.exec(readFileSync(new URL(name, migrationsUrl), 'utf8'))
  }

  const baselineByKey = byKey(afterFirst)
  const migratedByKey = byKey(shapeOf(migrated))
  const problems = []

  for (const [key, before] of baselineByKey) {
    if (!migratedByKey.has(key)) {
      problems.push(`${key}: in the baseline, absent after migrating`)
      continue
    }
    const after = migratedByKey.get(key)
    if (after === before) continue

    // The first and last positions at which the two disagree, so the report is
    // the changed region rather than the whole statement.
    let head = 0
    while (head < before.length && before[head] === after[head]) head += 1
    let tail = 0
    while (
      tail < before.length - head &&
      tail < after.length - head &&
      before.at(-1 - tail) === after.at(-1 - tail)
    ) tail += 1

    const from = Math.max(0, head - 40)
    problems.push(
      `${key} differs:\n` +
        `    baseline: \u2026${before.slice(from, before.length - tail + 40)}\u2026\n` +
        `    migrated: \u2026${after.slice(from, after.length - tail + 40)}\u2026`,
    )
  }

  for (const key of migratedByKey.keys()) {
    if (!baselineByKey.has(key)) {
      problems.push(`${key}: created by a migration, absent from the baseline`)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'The baseline and the migration chain do not agree. One of the two was ' +
        `updated without the other.\n\n${problems.map((line) => `  ${line}`).join('\n')}\n`,
    )
  }

  console.log(
    `Schema paths agree: baseline re-applies cleanly, and ${migrations.length} ` +
      'migration(s) reproduce it exactly.',
  )
}
