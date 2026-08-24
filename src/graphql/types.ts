import type { AppBindings } from '../bindings'
import type { Database } from '../db'
import type { Loaders } from '../loaders'

/**
 * Per-request state made available to GraphQL resolvers. `responseHeaders` is
 * separate because Yoga returns an immutable Response after resolver execution;
 * Hono merges cookies into the final response at the transport boundary.
 */
export type GraphQLContext = {
  env: AppBindings
  db: Database
  /**
   * Batched lookups for this request only.
   *
   * Built here rather than imported from a module because a loader is a cache,
   * and one shared between requests would answer one person's query with
   * another's data. See `src/loaders.ts`.
   */
  loaders: Loaders
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}
