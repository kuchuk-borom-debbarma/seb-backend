#!/usr/bin/env node
/**
 * Applies one SQL file to the database `DATABASE_URL` names, transactionally.
 *
 * The counterpart to `setup-local-db.mjs` for a database that holds something
 * worth keeping: that script drops and rebuilds the whole schema, which is
 * right for a local scratch database and wrong for a deployed one. This runs
 * exactly the statements it is given — an additive DDL file, a data fix —
 * inside one transaction, so a failure half-way leaves the database as it was
 * rather than on a shape no commit describes.
 *
 * Schema changes do not come through here — they travel the ordered chain
 * under `database/migrations/` via `db:generate` and `db:migrate`. This is
 * the escape hatch beside it, for the hand-written cases the chain's
 * `drizzle-kit generate --custom` anticipates: a data fix, a backfill, a
 * one-off correction — reviewed per change, applied whole or not at all.
 *
 *   npm run db:apply -- path/to/change.sql
 *
 * `DATABASE_URL` comes from the environment, `.env.local`, or `.env`, in that
 * precedence.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { loadRepositoryEnv } from './load-env.mjs'

loadRepositoryEnv()

const [, , file] = process.argv
if (!file) {
  console.error('Name the SQL file to apply: npm run db:apply -- path/to/change.sql')
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set — in the environment, .env.local or .env.')
  process.exit(1)
}

const sql = readFileSync(file, 'utf8')
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
  await client.query(sql)
  await client.query('COMMIT')
  console.log(`Applied ${file} to ${new URL(connectionString).host}.`)
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  // The message can quote the failing statement, which is the reviewed file's
  // own text — safe to show, and the one thing worth showing.
  console.error(`Rolled back: ${error.message}`)
  process.exit(1)
} finally {
  await client.end()
}
