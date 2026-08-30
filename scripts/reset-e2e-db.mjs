#!/usr/bin/env node
/**
 * Gives the end-to-end suite a clean database of its own.
 *
 * **Its own, deliberately.** The suite creates users, cycles and applications
 * on every run and expects to find nothing else; the database behind
 * `npm run local` is where somebody's afternoon of clicking lives. Sharing one
 * would mean either the suite fails on data it did not create or a developer
 * loses theirs, and both happen at the worst moment. So this owns
 * `seb_backend_e2e`, and `npm run test:worker` points the Worker's Hyperdrive
 * binding at it.
 *
 * **Recreates rather than patches**, for the reason `setup-local-db.mjs` gives:
 * a re-run guarded by `IF NOT EXISTS` reports success against a table already
 * there in an older shape.
 *
 * This used to run `wrangler d1 execute` against a local D1 file and then stamp
 * the migration ledger. There is no D1 and no ledger; the schema is applied
 * whole.
 */
import { readFileSync } from 'node:fs'
import { rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { ANNOUNCEMENT_BOARD_SEED } from './board-seed.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * Wrangler still keeps the Worker's own local state — the KV behind rate
 * limiting, the R2 bucket documents are written to — under `--persist-to`.
 * Only the database moved to Postgres, so this directory is still cleared.
 */
const stateDirectory = 'dev-web/.playwright/state'
await rm(stateDirectory, { recursive: true, force: true })
await mkdir(stateDirectory, { recursive: true })

export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/seb_backend_e2e'

const url = new URL(E2E_DATABASE_URL)
const databaseName = url.pathname.replace(/^\//u, '')
if (!databaseName) {
  console.error('E2E_DATABASE_URL names no database.')
  process.exit(1)
}

/*
 * `CREATE DATABASE` cannot run inside the database it creates, so the first
 * connection is to the server's default one. A first run on a new machine has
 * no `seb_backend_e2e` to connect to at all.
 */
const administrative = new pg.Client({
  connectionString: new URL(`/postgres${url.search}`, E2E_DATABASE_URL).href,
})

try {
  await administrative.connect()
} catch (error) {
  // Names the host, never the password — a connection string carries one.
  console.error(`Could not reach Postgres at ${url.host}: ${error.code ?? error.message}`)
  console.error('Start one with `npm run db:setup:local`, or set E2E_DATABASE_URL.')
  process.exit(1)
}

try {
  const { rowCount } = await administrative.query(
    'SELECT 1 FROM pg_database WHERE datname = $1', [databaseName],
  )
  // The name comes from a connection string an operator supplied, so it cannot
  // be a parameter here — `CREATE DATABASE` takes an identifier. Quoted, and
  // any embedded quote doubled, which is how Postgres escapes one.
  if (rowCount === 0) {
    await administrative.query(`CREATE DATABASE "${databaseName.replace(/"/gu, '""')}"`)
  }
} finally {
  await administrative.end()
}

const client = new pg.Client({ connectionString: E2E_DATABASE_URL })
await client.connect()

try {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  await client.query('CREATE SCHEMA public')
  await client.query(readFileSync(join(root, 'database', 'schema.sql'), 'utf8'))
  await client.query(ANNOUNCEMENT_BOARD_SEED)
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
  )
  console.log(`End-to-end database ready: ${databaseName}, ${rows[0].n} tables.`)
} catch (error) {
  console.error(`Applying the schema failed: ${error.message.split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await client.end()
}
