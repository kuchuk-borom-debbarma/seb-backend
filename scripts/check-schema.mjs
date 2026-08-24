import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canonicalHeader = `-- Canonical schema for a Mission SEP D1 database.
--
-- Safe to apply to an empty database and safe to apply again: every statement
-- is guarded with IF NOT EXISTS, so a re-run is a no-op and a half-created
-- database recovers rather than erroring partway through.
--
-- That is NOT the same as being a migration. IF NOT EXISTS only ever helps an
-- object that does not exist yet; it cannot alter a table that does. Changes to
-- an existing table — a widened CHECK, a new column, a dropped index — belong
-- in database/migrations/ and are applied by \`npm run db:migrate\`. This file
-- is the baseline a brand new database starts from.
--
-- Generated from the Drizzle schema. Never hand-edit: run \`npm run
-- db:schema:generate\`.
PRAGMA foreign_keys = ON;

`

const canonicalSchemaUrl = new URL('../database/schema.sql', import.meta.url)

/**
 * Makes every generated statement re-appliable.
 *
 * Drizzle emits bare `CREATE TABLE` and `CREATE INDEX`, which fail the second
 * time the file is applied and leave the rest of it unapplied. Guarding them
 * turns a re-run into a no-op.
 *
 * Applied to both the generated text and the comparison below, so the
 * byte-exact check that stops anyone hand-editing the file still holds.
 *
 * Deliberately anchored to the start of a line: the same words appear inside
 * quoted default values and comments, and rewriting those would corrupt the
 * schema rather than guard it.
 */
const reappliable = (sql) =>
  sql
    .replace(/^CREATE TABLE /gmu, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/^CREATE UNIQUE INDEX /gmu, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
    .replace(/^CREATE INDEX /gmu, 'CREATE INDEX IF NOT EXISTS ')

// Execute Drizzle directly instead of relying on a platform-specific shell
// pipeline. Check mode leaves the workspace untouched; --write deliberately
// replaces only the canonical generated file.
const generatedSchema = execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/drizzle-kit/bin.cjs', import.meta.url)),
    'export',
    '--config',
    'drizzle.config.ts',
  ],
  { encoding: 'utf8' },
)

const guardedSchema = reappliable(generatedSchema)

if (process.argv.includes('--write')) {
  writeFileSync(canonicalSchemaUrl, canonicalHeader + guardedSchema)
  console.log('Regenerated the canonical base schema from Drizzle.')
  process.exit(0)
}

const canonicalSchema = readFileSync(canonicalSchemaUrl, 'utf8')
if (!canonicalSchema.startsWith(canonicalHeader)) {
  throw new Error('database/schema.sql is missing its canonical base-schema header.')
}

if (canonicalSchema.slice(canonicalHeader.length) !== guardedSchema) {
  throw new Error(
    'database/schema.sql differs from the Drizzle schema. Regenerate and review the canonical SQL.',
  )
}

console.log('Canonical SQL matches the Drizzle schema.')
