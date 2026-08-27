/**
 * A real connection, through the Hyperdrive binding, from inside workerd.
 *
 * **This is the only place that proves the Worker can reach a database at all.**
 * Everything else moved to the service suite, which runs in Node against PGlite;
 * nothing there would notice a missing `nodejs_compat` flag, a node-postgres
 * import workerd cannot resolve, or a Hyperdrive binding that is not wired — and
 * none of those fail until deploy.
 *
 * It needs a Postgres listening at the binding's local connection string. When
 * there is none the tests that use it are **skipped, loudly**, rather than
 * passing: a connection test that quietly passes without connecting is worse
 * than no connection test. `npm run db:setup:local` provides one.
 */
import { env } from 'cloudflare:test'
import { openDatabase } from '../../src/db'
import type { Database } from '../../src/db'

let reachable: boolean | null = null

/**
 * Whether a database is there, asked once per run.
 *
 * **Bounded.** Hyperdrive's binding does not refuse promptly when nothing is
 * listening — it waits — so an unbounded probe hangs the whole suite on a
 * developer machine with no Postgres, which is the common case and the one this
 * must handle gracefully. Two seconds is far longer than a local connection
 * needs and far shorter than anybody's patience.
 */
export const databaseIsReachable = async (): Promise<boolean> => {
  if (reachable !== null) return reachable
  const { ready, close } = openDatabase(env.HYPERDRIVE.connectionString)
  try {
    await Promise.race([
      ready,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('timed out')), 2_000),
      ),
    ])
    reachable = true
  } catch {
    reachable = false
  } finally {
    void close()
  }
  return reachable
}

/** Runs one unit of work against a real connection, and always releases it. */
export const withRealDatabase = async <T>(
  work: (db: Database) => Promise<T>,
): Promise<T> => {
  const { db, ready, close } = openDatabase(env.HYPERDRIVE.connectionString)
  try {
    await ready
    return await work(db)
  } finally {
    await close()
  }
}
