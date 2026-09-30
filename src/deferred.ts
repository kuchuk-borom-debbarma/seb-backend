import type { Database } from './db'

/**
 * Work a response does not wait for (docs/rules/performance.md, rule 6).
 *
 * For what should happen but may be lost — a confirmation email. What must
 * happen belongs on the queue, which retries; what the answer depends on is
 * not deferrable at all.
 *
 * The task is handed a way to open a connection of its own, not a connection.
 * The request's is closed before the response is returned, deliberately (see
 * the `/graphql` route), so a task that captured it would write to a closed
 * client. And most tasks need none on their happy path — a confirmation
 * touches the database only to record that it failed — so opening one up
 * front would cost every request a connection, and a failure to connect would
 * stop work that never needed the database.
 */
export type DatabaseAccess = <T>(work: (db: Database) => Promise<T>) => Promise<T>
export type DeferredTask = (database: DatabaseAccess) => Promise<void>
export type Defer = (task: DeferredTask) => void

/**
 * Runs `task` after the response where the context can, and now where it
 * cannot: a context built by hand — a test's, the scheduled handler's — has no
 * response to run after, and its caller expects the work done on return.
 */
export const afterResponse = async (
  context: { db: Database; defer?: Defer },
  task: DeferredTask,
): Promise<void> => {
  if (context.defer) context.defer(task)
  else await task((work) => work(context.db))
}
