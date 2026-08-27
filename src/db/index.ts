import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import { Client } from 'pg'
import { schema } from './schema'

/** The schema-aware database type passed through request-scoped services. */
export type Database = NodePgDatabase<typeof schema>

/**
 * A database handle inside a transaction.
 *
 * The same handle as the outer `Database`, deliberately — see `batch`. It is a
 * distinct type only so a call site reads as being inside a transition; either
 * handle builds a statement that runs inside it.
 */
export type Transaction = PgTransaction<
  never,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

/** Either handle, for a read that does not care which it is on. */
export type Executor = Database | Transaction

/**
 * Runs several statements as one transition, in order, and returns each result.
 *
 * ## Why this issues its own `BEGIN` rather than using `db.transaction`
 *
 * Because a driver's `transaction()` may hand the callback a **different
 * connection**, and every call site in this repository builds its statements
 * from the outer handle. node-postgres given a `Client` reuses the same session,
 * so that worked; PGlite checks out a second one, and a statement built from the
 * outer handle then queues behind a transaction that is waiting for it —
 * a deadlock, not a wrong answer.
 *
 * Both behaviours are legitimate. What is not legitimate is code whose atomicity
 * depends on which of them a driver chose, so the transaction is opened on the
 * handle the statements were built from and the question stops existing. `tx` is
 * handed to `build` as the same handle, so a call site may use either and both
 * are correct.
 *
 * This rests on **one connection per request**, which `openDatabase` asserts
 * rather than assumes: given a pool, `BEGIN` and the statements after it could
 * land on different connections and the atomicity would be silently absent.
 *
 * They run **sequentially**, and that is not a limitation to optimise away — a
 * transaction is one connection, so issuing them concurrently would queue them
 * on it anyway while reading as though it did not.
 *
 * **READ COMMITTED, deliberately the default.** An `UPDATE … WHERE
 * current_version = 5` that blocks on a concurrent writer re-evaluates its
 * predicate against the committed row once the lock releases, so a bumped
 * version yields no rows — exactly the refusal wanted. Raising the isolation
 * level would turn that clean refusal into a serialization failure the caller
 * has to retry, which is worse for no gain.
 *
 * Each statement already carries its own predicate, so a dependent whose guard
 * no longer holds writes nothing and the transition still commits — the same
 * outcome the D1 batch this replaces produced.
 *
 * **Never await R2, the queue or a provider inside `build`.** That holds the
 * connection open across a network call to somebody else's service.
 */
export const batch = async <const T extends readonly PromiseLike<unknown>[]>(
  db: Database,
  build: (tx: Transaction) => T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> =>
  serially(db, async () => {
    const statements = build(db as unknown as Transaction)
    await db.execute(sql`BEGIN`)
    try {
      const results: unknown[] = []
      for (const statement of statements) results.push(await statement)
      await db.execute(sql`COMMIT`)
      return results as { -readonly [K in keyof T]: Awaited<T[K]> }
    } catch (error) {
      await db.execute(sql`ROLLBACK`)
      throw error
    }
  })

/**
 * Runs transitions on one connection one at a time.
 *
 * A connection has one transaction, so two `batch` calls issued concurrently on
 * the same handle would interleave their `BEGIN`s — the second finds a
 * transaction already in progress, its statements join the first's, and a
 * `ROLLBACK` in either takes both down. Nothing throws; the writes are simply
 * not the transitions they were written as.
 *
 * A request never does this today, because each awaits the last. This exists so
 * that when somebody eventually writes `Promise.all([...])` over two guarded
 * writes — which reads as an obvious optimisation — they get the serialisation a
 * single connection can actually offer rather than silent interleaving. It buys
 * no parallelism, and there was none to have: the statements would have queued
 * on the one wire regardless.
 */
const pending = new WeakMap<Database, Promise<unknown>>()

const serially = <T>(db: Database, work: () => Promise<T>): Promise<T> => {
  const queued = (pending.get(db) ?? Promise.resolve()).then(work, work)
  // The chain must not reject, or every later caller inherits the rejection.
  pending.set(db, queued.catch(() => undefined))
  return queued
}

/** What a statement returns: rows if it asked for them, a count if it did not. */
export type WriteResult = readonly unknown[] | { readonly rowCount: number | null }

/**
 * Whether a guarded write moved exactly the one row it claimed.
 *
 * Zero means somebody else acted first and the caller is told the record
 * changed. More than one would mean the predicate was not specific enough to a
 * single row, which is a bug rather than a race — hence the equality rather
 * than a truthiness check.
 *
 * **Both shapes, because the driver returns two.** A statement with
 * `.returning()` yields an array of rows; one without yields a command result
 * carrying `rowCount`. This read `.length` and nothing else, so every write
 * whose first statement was an `INSERT … SELECT` — the audit row that opens
 * several of them — read `undefined === 1` and reported **no change however
 * well it worked**. Removing a document did remove it and told the applicant
 * it had not.
 */
export const changedExactlyOne = (returned: WriteResult): boolean =>
  Array.isArray(returned) ? returned.length === 1 : (returned as { rowCount: number | null }).rowCount === 1

/**
 * A connection and the Drizzle wrapper around it, built for one request.
 *
 * Per request rather than per isolate, for the reason `src/index.ts` gives about
 * its own configuration: a cached instance is shared by every request the
 * isolate serves, and the test suite runs `singleWorker: true`, so a singleton
 * here would be one connection shared across every test in a run.
 *
 * Hyperdrive holds the pool at the edge, so opening a client costs one hop
 * rather than a TLS and authentication handshake to Neon. The caller owns
 * closing it — see `withDatabase`.
 */
export const openDatabase = (connectionString: string) => {
  const client = new Client({ connectionString })
  /*
   * A single connection, asserted rather than assumed.
   *
   * Drizzle only checks out a separate connection for a transaction when it is
   * given a pool. With one client, `atomically` runs `BEGIN` on the same wire as
   * every statement built from the outer handle — which is what makes the
   * guarded writes atomic without each of them having to thread `tx` through.
   *
   * A pool would keep every type and every test green and quietly undo that, so
   * the check is here rather than in a comment asking the next person not to.
   */
  if (Object.getPrototypeOf(client).constructor.name.includes('Pool')) {
    throw new TypeError(
      'The database handle must be a single client: a pool gives a transaction '
      + 'its own connection, so statements built from the outer handle would '
      + 'commit outside it.',
    )
  }
  const connected = client.connect()
  return {
    db: drizzle(client, { schema }) as Database,
    /** Resolves once the socket is up; awaited only where a caller must know. */
    ready: connected,
    close: async () => {
      // A close that throws must not fail the request it belongs to: the
      // response has already been written by the time this runs.
      await connected.catch(() => undefined)
      await client.end().catch(() => undefined)
    },
  }
}

/**
 * Runs one unit of work against a fresh connection and always releases it.
 *
 * A leaked client holds a Hyperdrive slot until it times out, so the release is
 * structural rather than remembered at each call site — the same argument
 * `createLoaders` makes for being called from exactly one place.
 */
export const withDatabase = async <T>(
  connectionString: string,
  work: (db: Database) => Promise<T>,
): Promise<T> => {
  const { db, close } = openDatabase(connectionString)
  try {
    return await work(db)
  } finally {
    await close()
  }
}
