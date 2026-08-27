// fallow-ignore-file unused-file
// A vitest `setupFiles` entry, named in the config rather than imported, so
// nothing reaches it from a module graph.
/**
 * The connection seam, registered before any test file's imports run.
 *
 * `vi.mock` is hoisted to the top of the *file that calls it*, so calling it
 * from inside a helper is too late — `src/index.ts` has already pulled in the
 * real `src/db` and every request dials a Postgres that is not there. A setup
 * file is the one place a mock can be declared once and still beat the imports
 * of every suite.
 *
 * Only `withDatabase` and `openDatabase` are replaced. Everything else in the
 * Worker runs as written: Hono, the CORS rules, the body limit, the GraphQL
 * validation rules, the resolvers and the whole service layer. Mocking any
 * lower would be testing the mock.
 */
import { vi } from 'vitest'

vi.mock('../../src/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db')>()
  const { activeDatabase, withRequestDatabase } = await import('./harness')
  return {
    ...original,
    /*
     * The connection is deliberately *not* closed, unlike production. A test's
     * database has to outlive its request so an assertion can read what the
     * request wrote.
     */
    withDatabase: async <T>(
      _connection: string,
      work: (db: ReturnType<typeof activeDatabase>) => Promise<T>,
    ) => withRequestDatabase(work as never) as Promise<T>,
    openDatabase: () => ({
      db: activeDatabase(),
      ready: Promise.resolve(),
      close: async () => undefined,
    }),
  }
})
