import type { AppBindings } from '../bindings'
import type { Database } from '../db'

/**
 * Per-request state made available to GraphQL resolvers. `responseHeaders` is
 * separate because Yoga returns an immutable Response after resolver execution;
 * Hono merges cookies into the final response at the transport boundary.
 */
export type GraphQLContext = {
  env: AppBindings
  db: Database
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}
