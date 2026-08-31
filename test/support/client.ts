/**
 * The database the service suite runs against: PGlite, or a real Postgres.
 *
 * PGlite is the default because it is hermetic and fast — nothing to start, no
 * shared state, a fresh instance per file. A real Postgres is the gate: it is
 * what will actually run, and it is the only thing that can show a divergence.
 *
 * **A divergence between the two is a finding, never a flake.** The instinct on
 * the first red `test:neon` against a green `npm test` is to re-run it, and
 * that is the one response that loses the information.
 *
 * The two are behind one narrow interface rather than a driver abstraction,
 * because only three operations are needed: run a statement, run a script, and
 * close. Anything wider would be a second database layer to keep in step with
 * the real one in `src/db`.
 */
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { schema } from '../../src/db/schema'
import type { Database } from '../../src/db'

/** What the fixtures and the round-trip counter need, and nothing more. */
export type TestClient = {
  /*
   * `affectedRows` is PGlite's name for it and `rowCount` is node-postgres's;
   * both are carried so a fixture can ask "how many rows did that change"
   * without knowing which it is talking to.
   */
  query: <Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: Row[]; affectedRows?: number; rowCount?: number | null }>
  /** Runs a script that may hold several statements and takes no parameters. */
  exec: (sql: string) => Promise<unknown>
  close: () => Promise<void>
  /** Which of the two this is, for the few tests that may only run on one. */
  readonly driver: 'pglite' | 'postgres'
}

/**
 * Where a real-Postgres run connects, if one was asked for.
 *
 * Absent means PGlite, which is the ordinary case. Reading it here rather than
 * at each call site means one definition of "is this the gate run".
 */
export const testDatabaseUrl = (): string | null =>
  process.env.TEST_DATABASE_URL?.trim() || null

/**
 * A database of this worker's own.
 *
 * Vitest runs files in parallel and every one of them truncates every table,
 * so against a shared database each worker deletes the others' rows mid-test —
 * which does not fail cleanly, it fails as a fixture that was there a moment
 * ago. A fresh PGlite gives isolation for free; this buys the same thing.
 *
 * **A database, not a schema.** A schema per worker was tried and is subtly
 * wrong: the schema file declares foreign keys inline, so a table referencing
 * one declared later resolves the name against whatever else is on the
 * `search_path` — and every worker's constraints silently pointed at the
 * copy in `public`. Rows went into the worker's own tables and the keys were
 * checked against somebody else's. A separate database cannot be ambiguous.
 */
const workerDatabase = (base: string): string =>
  `${base}_w${(process.env.VITEST_WORKER_ID ?? '1').replace(/\W/gu, '')}`

/** The client, and the raw handle Drizzle needs to be built over. */
export type OpenedClient = { client: TestClient; raw: PGlite | pg.Client }

export const openTestClient = async (): Promise<OpenedClient> => {
  const url = testDatabaseUrl()
  if (url === null) {
    const pglite = new PGlite()
    return {
      raw: pglite,
      client: {
        query: (text, params) => pglite.query(text, params as unknown[]) as never,
        exec: (sql) => pglite.exec(sql),
        close: () => pglite.close(),
        driver: 'pglite',
      },
    }
  }

  const base = new URL(url)
  const name = workerDatabase(base.pathname.replace(/^\//u, ''))

  /*
   * `CREATE DATABASE` cannot run inside the database it creates, so the check
   * goes through the server's default one.
   */
  const administrative = new pg.Client({
    connectionString: new URL(`/postgres${base.search}`, url).href,
  })
  await administrative.connect()
  try {
    const { rowCount } = await administrative.query(
      'SELECT 1 FROM pg_database WHERE datname = $1', [name],
    )
    if (rowCount === 0) {
      await administrative.query(`CREATE DATABASE "${name.replace(/"/gu, '""')}"`)
    }
  } finally {
    await administrative.end()
  }

  const databaseUrl = new URL(`/${name}${base.search}`, url).href
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  /*
   * Dropped and recreated, so a previous run's leftovers cannot make this one
   * pass. Guarding with `IF NOT EXISTS` instead would make a re-run *look*
   * successful against a table already there in an older shape.
   */
  await client.query('DROP SCHEMA IF EXISTS public CASCADE')
  await client.query('CREATE SCHEMA public')
  await closeRequestPool()
  openRequestPool(databaseUrl)
  return {
    raw: client,
    client: {
      query: (text, params) => client.query(text, params as unknown[]) as never,
      exec: (sql) => client.query(sql),
      close: () => client.end(),
      driver: 'postgres',
    },
  }
}

/**
 * A pool over the same database, for handing each request its own connection.
 *
 * Production builds a client per request, so two concurrent requests never
 * share a session. Sharing one in tests is invisible on PGlite and wrong on
 * Postgres: a statement that fails aborts the whole transaction, and *every
 * later statement on that connection* is refused until it ends — so one
 * request losing a race takes the winner down with it. Which is not a race the
 * product can lose; it is one the harness invented.
 *
 * Null on PGlite, where the single in-memory instance is the database.
 */
let pool: pg.Pool | null = null

export const requestPool = (): pg.Pool | null => pool

const openRequestPool = (databaseUrl: string): pg.Pool => {
  pool ??= new pg.Pool({ connectionString: databaseUrl, max: 8 })
  return pool
}

export const closeRequestPool = async (): Promise<void> => {
  await pool?.end()
  pool = null
}

/** The Drizzle handle over whichever client this is. */
export const drizzleOver = ({ client, raw }: OpenedClient): Database =>
  (client.driver === 'pglite'
    ? drizzlePglite(raw as PGlite, { schema })
    : drizzlePostgres(raw as pg.Client, { schema })) as unknown as Database

/** A Drizzle handle over one pooled connection. */
export const drizzleOverPooled = (connection: pg.PoolClient): Database =>
  drizzlePostgres(connection, { schema }) as unknown as Database
