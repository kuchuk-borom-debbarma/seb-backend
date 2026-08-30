#!/usr/bin/env node
/**
 * Creates a local database from `database/schema.sql`.
 *
 * **Recreates rather than patches.** The public schema is dropped and rebuilt,
 * so what you get is exactly the checked-in schema and nothing left over from a
 * previous shape. That is deliberate: guarding every statement with
 * `IF NOT EXISTS` would make a re-run *look* successful against a table that is
 * already there in an older shape — the statement is skipped and reported as
 * done, leaving the database on the old definition while the code assumes the
 * new one.
 *
 * Safe because a local database holds nothing worth keeping. A database that
 * does — the deployed one — moves through the ordered chain instead:
 * `npm run db:migrate` against `database/migrations/`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { ANNOUNCEMENT_BOARD_SEED } from './board-seed.mjs'
import { loadRepositoryEnv } from './load-env.mjs'

loadRepositoryEnv()

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

const schema = readFileSync(join(root, 'database', 'schema.sql'), 'utf8')

/*
 * Created if it is not there.
 *
 * This is the first command a new machine runs, and on a new machine the
 * database does not exist yet — so it used to fail with a bare `3D000` and
 * leave the reader to work out that Postgres was running fine and only the
 * database was missing. `CREATE DATABASE` cannot run inside the database it
 * creates, so the check goes through the server's default one.
 */
const url = new URL(connectionString)
const databaseName = url.pathname.replace(/^\//u, '')
if (!databaseName) {
  console.error('DATABASE_URL names no database.')
  process.exit(1)
}

const administrative = new pg.Client({
  connectionString: new URL(`/postgres${url.search}`, connectionString).href,
})

try {
  await administrative.connect()
} catch (error) {
  // Names the host, never the password — a connection string carries one.
  console.error(`Could not reach Postgres at ${url.host}: ${error.code ?? error.message}`)
  process.exit(1)
}

try {
  const { rowCount } = await administrative.query(
    'SELECT 1 FROM pg_database WHERE datname = $1', [databaseName],
  )
  // The name comes from a connection string, so it cannot be a parameter here
  // — `CREATE DATABASE` takes an identifier. Quoted, with any embedded quote
  // doubled, which is how Postgres escapes one.
  if (rowCount === 0) {
    await administrative.query(`CREATE DATABASE "${databaseName.replace(/"/gu, '""')}"`)
    console.log(`Created ${databaseName}.`)
  }
} finally {
  await administrative.end()
}

const client = new pg.Client({ connectionString })

try {
  await client.connect()
} catch (error) {
  console.error(`Could not reach the database: ${error.code ?? error.message}`)
  process.exit(1)
}

try {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  await client.query('CREATE SCHEMA public')
  await client.query(schema)
  await client.query(ANNOUNCEMENT_BOARD_SEED)
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
  )
  console.log(`Local database ready: ${rows[0].n} tables.`)
} catch (error) {
  console.error(`Applying the schema failed: ${error.message.split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await client.end()
}
