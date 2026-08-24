/**
 * Proves the two ways to reach the current schema agree.
 *
 * A database can arrive at today's shape by two routes: applying
 * `database/schema.sql` to an empty file, or applying the migrations in order
 * to a database that predates them. Nothing makes those agree by construction —
 * they are written separately, and a change made to one and forgotten in the
 * other is invisible until a deploy.
 *
 * So both are built here and their `sqlite_master` compared. The check also
 * asserts the baseline is re-appliable, because that is the other property the
 * generated file is supposed to have and it costs one more `executescript` to
 * be sure of rather than to assume.
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

if (afterFirst.size !== afterSecond.size) {
  throw new Error(
    'database/schema.sql is not re-appliable: a second apply changed the schema.',
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
const rewind = [
  {
    migration: '0003-identifier-rules.sql',
    age: (sql) => {
      const start = sql.indexOf(
        'CREATE TABLE IF NOT EXISTS `seb_programme_cycle_identifier_rule` (',
      )
      const end = sql.indexOf('\n);\n', start) + '\n);\n'.length
      return (sql.slice(0, start) + sql.slice(end))
        .split('\n')
        .filter((line) => !line.includes(' ON `seb_programme_cycle_identifier_rule` '))
        .join('\n')
    },
  },
  {
    migration: '0002-upload-cap-5mb.sql',
    age: (sql) => sql.replaceAll('<= 5242880', '<= 10485760'),
  },
  {
    migration: '0001-staff-roles.sql',
    age: (sql) =>
      sql.replace(
        `CHECK("core_user_role_grant"."role" IN ('APPLICANT', 'REVIEWER', 'APPROVER', 'ADMIN', 'SUPER_ADMIN'))`,
        `CHECK("core_user_role_grant"."role" IN ('APPLICANT', 'ADMIN', 'SUPER_ADMIN'))`,
      ),
  },
]

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

const baselineShape = afterFirst
const migratedShape = shapeOf(migrated)

/**
 * Reports the difference in a form somebody can act on.
 *
 * Printing two normalised `CREATE TABLE` statements in full is technically
 * complete and practically useless — they are a thousand characters that differ
 * in four. Objects present on one side only are named; objects present on both
 * get the differing region, with a little context either side.
 */
const byKey = (shapes) => {
  const index = new Map()
  for (const shape of shapes) {
    const [type, name] = shape.split(' ')
    index.set(`${type} ${name}`, shape.slice(type.length + name.length + 2))
  }
  return index
}

const baselineByKey = byKey(baselineShape)
const migratedByKey = byKey(migratedShape)
const problems = []

for (const [key, baselineSqlText] of baselineByKey) {
  if (!migratedByKey.has(key)) {
    problems.push(`${key}: in the baseline, absent after migrating`)
    continue
  }
  const migratedSqlText = migratedByKey.get(key)
  if (migratedSqlText === baselineSqlText) continue

  // The first and last positions at which the two disagree, so the report is
  // the changed region rather than the whole statement.
  let head = 0
  while (
    head < baselineSqlText.length &&
    baselineSqlText[head] === migratedSqlText[head]
  ) head += 1
  let tail = 0
  while (
    tail < baselineSqlText.length - head &&
    tail < migratedSqlText.length - head &&
    baselineSqlText.at(-1 - tail) === migratedSqlText.at(-1 - tail)
  ) tail += 1

  const from = Math.max(0, head - 40)
  problems.push(
    `${key} differs:\n` +
      `    baseline: …${baselineSqlText.slice(from, baselineSqlText.length - tail + 40)}…\n` +
      `    migrated: …${migratedSqlText.slice(from, migratedSqlText.length - tail + 40)}…`,
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
