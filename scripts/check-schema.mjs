import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canonicalHeader = `-- Canonical schema for a new Mission SEP D1 database.
-- This is a base schema, not an incremental migration.
PRAGMA foreign_keys = ON;

`

const canonicalSchemaUrl = new URL('../database/schema.sql', import.meta.url)

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

if (process.argv.includes('--write')) {
  writeFileSync(canonicalSchemaUrl, canonicalHeader + generatedSchema)
  console.log('Regenerated the canonical base schema from Drizzle.')
  process.exit(0)
}

const canonicalSchema = readFileSync(canonicalSchemaUrl, 'utf8')
if (!canonicalSchema.startsWith(canonicalHeader)) {
  throw new Error('database/schema.sql is missing its canonical base-schema header.')
}

if (canonicalSchema.slice(canonicalHeader.length) !== generatedSchema) {
  throw new Error(
    'database/schema.sql differs from the Drizzle schema. Regenerate and review the canonical SQL.',
  )
}

console.log('Canonical SQL matches the Drizzle schema.')
