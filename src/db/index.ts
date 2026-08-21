import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { schema } from './schema'

/** The schema-aware database type passed through request-scoped services. */
export type Database = DrizzleD1Database<typeof schema>

/**
 * Drizzle is intentionally created per request. This wrapper is lightweight;
 * the underlying D1 connection is the Cloudflare binding managed by the runtime.
 */
export const createDatabase = (binding: D1Database): Database => drizzle(binding, { schema })
