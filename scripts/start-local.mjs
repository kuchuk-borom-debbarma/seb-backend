#!/usr/bin/env node
/**
 * Starts the local Worker only after its Postgres dependency is usable.
 *
 * Workerd reports a refused Hyperdrive socket only when the first GraphQL
 * request is already in flight. Probing here makes `npm run local` name the
 * missing prerequisite before the Worker begins accepting requests. The URL is
 * passed through Wrangler's documented local Hyperdrive override so this probe
 * and the Worker cannot point at different databases.
 */
import { spawn } from 'node:child_process'
import pg from 'pg'
import { localDatabaseUrl } from './local-database.mjs'

const connectionString = localDatabaseUrl()

let location
try {
  location = new URL(connectionString)
} catch {
  console.error('DATABASE_URL must be a valid Postgres connection URL.')
  process.exit(1)
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3_000 })
try {
  await client.connect()
} catch {
  // The location identifies the server without disclosing a URL password.
  console.error(`Cannot reach local Postgres at ${location.host}.`)
  console.error('Start Postgres, then run `npm run db:setup:local` if its schema is new.')
  process.exit(1)
}

try {
  // An open socket is not enough: D1 data from before the Postgres migration
  // has no tables for this Worker to query, and otherwise fails on a request.
  await client.query('SELECT 1 FROM core_user LIMIT 1')
} catch {
  console.error('The local Postgres database does not have the Mission SEP schema.')
  console.error('Run `npm run db:setup:local` to rebuild it before starting the Worker.')
  process.exit(1)
} finally {
  await client.end().catch(() => undefined)
}

const worker = spawn(
  'npx',
  ['wrangler', 'dev', '--config', 'wrangler.dev.jsonc', '--port', '9999'],
  {
    env: {
      ...process.env,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: connectionString,
    },
    stdio: 'inherit',
  },
)

worker.on('error', () => {
  console.error('Could not start Wrangler.')
  process.exit(1)
})
worker.on('exit', (code) => process.exit(code ?? 1))
