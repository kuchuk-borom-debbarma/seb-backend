#!/usr/bin/env node
/**
 * Marks migrations as already applied, for a database that already has their
 * shape.
 *
 * The migration chain began after a database was deployed, so its first
 * entries describe tables that database already holds — running them would
 * fail on the first `CREATE TABLE`. This records them in the bookkeeping
 * drizzle's migrator reads (`drizzle.__drizzle_migrations`: the file's
 * sha256 and the journal's `when`), so `npm run db:migrate` applies only what
 * comes after.
 *
 *   npm run db:baseline -- 0000_baseline
 *
 * Marks every journal entry up to and including the named tag. Refuses a tag
 * the journal does not carry, and never marks past one it does — a database
 * must not be told it holds a shape nobody checked it for.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { loadRepositoryEnv } from './load-env.mjs'

loadRepositoryEnv()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrations = join(root, 'database', 'migrations')

const [, , throughTag] = process.argv
if (!throughTag) {
  console.error('Name the tag to baseline through: npm run db:baseline -- 0000_baseline')
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set — in the environment, .env.local or .env.')
  process.exit(1)
}

const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8'))
const boundary = journal.entries.findIndex((entry) => entry.tag === throughTag)
if (boundary === -1) {
  console.error(`The journal carries no migration tagged ${throughTag}.`)
  process.exit(1)
}

const client = new pg.Client({ connectionString })
try {
  await client.connect()
} catch (error) {
  // Names the host, never the password — a connection string carries one.
  console.error(
    `Could not reach Postgres at ${new URL(connectionString).host}: `
    + `${error.code ?? error.message}`,
  )
  process.exit(1)
}

try {
  await client.query('BEGIN')
  // Exactly the table drizzle's migrator creates, so whichever runs first the
  // other recognizes what it finds.
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"')
  await client.query(`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )`)
  for (const entry of journal.entries.slice(0, boundary + 1)) {
    const file = readFileSync(join(migrations, `${entry.tag}.sql`), 'utf8')
    const { rowCount } = await client.query(
      'SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE created_at = $1',
      [entry.when],
    )
    if (rowCount > 0) {
      console.log(`${entry.tag} was already marked.`)
      continue
    }
    await client.query(
      'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
      [createHash('sha256').update(file).digest('hex'), entry.when],
    )
    console.log(`Marked ${entry.tag} as applied.`)
  }
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(`Rolled back: ${error.message}`)
  process.exit(1)
} finally {
  await client.end()
}
