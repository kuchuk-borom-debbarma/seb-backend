/**
 * One database, one Worker, one request — for a test file.
 *
 * ## Why the Workers pool is gone
 *
 * The suite used to run inside workerd so that `env.DB` was a real D1 binding.
 * There is no D1 any more, and almost nothing here needs the runtime: what these
 * tests actually exercise is SQL, guards and resolvers. PGlite is a real
 * Postgres compiled to WebAssembly — same planner, same constraints, same
 * transaction semantics — so the assertions get *stronger* by moving, because
 * they now run against the engine the product will run on.
 *
 * What genuinely needs workerd — R2 bindings, the queue consumer's `ack`/`retry`,
 * `waitUntil` outliving a response, the edge body and CORS limits — stays in
 * `test/runtime/`, and must keep at least one test that opens a real connection
 * through the Hyperdrive binding. Nothing else would notice a missing
 * `nodejs_compat` until deploy.
 *
 * ## The one seam
 *
 * `withDatabase` is mocked, and only that. Every other line of the Worker runs
 * as written: Hono, the CORS rules, the body limit, the GraphQL validation
 * rules, the resolvers and the whole service layer. Mocking lower — a service, a
 * controller — would be testing the mock; mocking here swaps the socket and
 * nothing else.
 */
import { readFileSync } from 'node:fs'
import {
  closeRequestPool,
  drizzleOver,
  drizzleOverPooled,
  openTestClient,
  requestPool,
  testDatabaseUrl,
  type TestClient,
} from './client'
import type { Database } from '../../src/db'
import type { AppBindings } from '../../src/bindings'
import { shimDatabase, type ShimDatabase } from './d1-shim'

const SCHEMA = readFileSync(new URL('../../database/schema.sql', import.meta.url), 'utf8')

/**
 * The connection the mocked `withDatabase` hands out.
 *
 * Module-level because `vi.mock` is hoisted above every import and cannot close
 * over a value created later. `freshDatabase` replaces it per file, so two files
 * never share rows even when they run in the same process.
 */
let current: {
  client: TestClient
  raw: object
  db: Database
  shim: ShimDatabase
  tables: string[]
} | null = null

/**
 * The handle Drizzle itself holds, for the two tests that count round trips.
 *
 * They work by patching `query` on the object every statement goes through,
 * and Drizzle keeps a direct reference to the driver rather than to the
 * wrapper above it — so patching the wrapper counts nothing and the test
 * passes reporting zero. Deliberately the raw handle and not the client
 * interface, because a fixture has no business reaching past that interface —
 * this exists only so a round-trip counter can see the wire.
 */
export const activeDriverHandle = (): object => {
  if (!current) throw new Error('No test database. Call freshDatabase() in beforeAll.')
  return current.raw
}

export const activeDatabase = (): Database => {
  if (!current) throw new Error('No test database. Call freshDatabase() in beforeAll.')
  return current.db
}

/** The D1-shaped fixture handle over the current database. */
export const activeShim = (): ShimDatabase => {
  if (!current) throw new Error('No test database. Call freshDatabase() in beforeAll.')
  return current.shim
}

/**
 * A database with the schema applied, and the D1-shaped fixture handle over it.
 *
 * A fresh instance rather than truncating tables between tests: it is cheaper,
 * and it means one test can never leave a row that changes what the next one
 * sees. `isolatedStorage` did the same job for the Workers pool.
 *
 * The schema is applied with `exec`, not by splitting on `;`. The old setup
 * hand-rolled a splitter, which would break on any dollar-quoted body — and the
 * schema will grow one the first time it declares a function.
 */
export const freshDatabase = async (): Promise<{ db: Database; DB: ShimDatabase }> => {
  const opened = await openTestClient()
  await opened.client.exec(SCHEMA)
  const db = drizzleOver(opened)
  const shim = shimDatabase(opened.client)
  current = {
    client: opened.client,
    raw: opened.raw,
    db,
    shim,
    tables: await tableNames(opened.client),
  }
  return { db, DB: shim }
}

/**
 * Empties every table, which is how one test stops affecting the next.
 *
 * **Not a fresh instance.** Applying the 1300-line schema costs about four and
 * a half seconds, so a database per test put the auth suite alone over five
 * minutes; one `TRUNCATE` of the whole schema costs milliseconds. `isolatedStorage`
 * gave the Workers pool the same guarantee, and this is the same guarantee.
 *
 * `CASCADE` because the tables are a graph of restrict-on-delete foreign keys —
 * truncating them one at a time in dependency order would be a second copy of
 * the schema, maintained by hand, and wrong the first time somebody adds a
 * table.
 */
export const resetDatabase = async (): Promise<void> => {
  if (!current) throw new Error('No test database. Call freshDatabase() first.')
  if (current.tables.length === 0) return
  await current.client.exec(
    `TRUNCATE ${current.tables.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`,
  )
}

/*
 * The current schema's tables, not `public`'s. Against a real Postgres each
 * worker owns a schema of its own and `search_path` points at it, so asking
 * for `public` by name would find somebody else's tables — or none.
 */
const tableNames = async (client: TestClient): Promise<string[]> => {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  )
  return result.rows.map((row) => row.table_name)
}

export const closeDatabase = async (): Promise<void> => {
  await current?.client.close()
  await closeRequestPool()
  current = null
}

/**
 * One request's own connection, released when it is done.
 *
 * On PGlite there is one database and one handle, so every request shares it —
 * which is what an in-memory instance *is*. On Postgres each request takes a
 * connection from the pool, as production does when it builds a client per
 * request. That difference is not cosmetic: a failed statement aborts a
 * Postgres transaction and every later statement on that session, so two
 * concurrent requests sharing one connection make the loser of a race take the
 * winner down with it — a failure the product cannot have and the harness
 * would otherwise invent.
 */
export const withRequestDatabase = async <T>(
  work: (db: Database) => Promise<T>,
): Promise<T> => {
  const pool = testDatabaseUrl() === null ? null : requestPool()
  if (!pool) return work(activeDatabase())
  const connection = await pool.connect()
  try {
    return await work(drizzleOverPooled(connection))
  } finally {
    connection.release()
  }
}

/**
 * The bindings a test Worker runs with.
 *
 * The same values the Workers pool used to inject, minus D1. `HYPERDRIVE`
 * carries a connection string nothing dials — the factory above never reads
 * it — but it is present because `connectionString(env)` reads it and a missing
 * binding would be an unrelated failure.
 */
/**
 * An object store held in a Map.
 *
 * Only the three methods the storage transports actually call, because a
 * fuller stand-in would invite tests to assert against R2 behaviour it does
 * not have. What R2 really does with an object is the runtime suite's subject;
 * what this exists for is that a download decision reaches its authorization
 * check instead of throwing on a missing binding.
 */
const memoryBucket = (): R2Bucket => {
  const objects = new Map<
    string,
    { body: ArrayBuffer; sha256: ArrayBuffer; contentType: string | null }
  >()
  const described = (
    key: string,
    stored: { body: ArrayBuffer; sha256: ArrayBuffer; contentType: string | null },
  ) => ({
    key,
    size: stored.body.byteLength,
    etag: key,
    httpEtag: `"${key}"`,
    uploaded: new Date(0),
    /*
     * R2 computes this on write and the finalize path reads it back to check
     * the bytes are the ones the applicant said they were sending. A bucket
     * that omitted it made every upload fail on `checksums.sha256`.
     */
    checksums: { sha256: stored.sha256 },
    /*
     * R2 keeps the type it was given, and the relaying download reads it back
     * to decide what to serve the object as. A bucket that omitted it served
     * every document as `application/octet-stream` — the default the store
     * falls back to for an object stored without one — so a browser offered a
     * PDF as an unknown blob and nothing said why.
     */
    httpMetadata: stored.contentType === null ? {} : { contentType: stored.contentType },
    arrayBuffer: async () => stored.body,
    text: async () => new TextDecoder().decode(stored.body),
    /*
     * A real stream, because the relaying download hands `object.body`
     * straight to a `Response`. This was `null`, so every locally served
     * document had a body of zero bytes — and a test asserting only the
     * headers would go on passing while the applicant downloaded nothing.
     *
     * `head` overrides it back to `null`, which is what R2 does: a head
     * returns the object's facts and none of its bytes.
     */
    body: new Response(stored.body).body,
  })
  const bytesOf = (body: ArrayBuffer | ArrayBufferView | string | null): ArrayBuffer => {
    if (typeof body === 'string') return new TextEncoder().encode(body).buffer as ArrayBuffer
    if (ArrayBuffer.isView(body)) {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
    }
    return (body ?? new ArrayBuffer(0)) as ArrayBuffer
  }
  return {
    put: async (
      key: string,
      body: ArrayBuffer | ArrayBufferView | string | null,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      const bytes = bytesOf(body)
      // Computed rather than taken from the caller's `sha256` option, so a
      // wrong checksum is caught by the product's own check and not by this.
      const sha256 = await crypto.subtle.digest('SHA-256', bytes)
      objects.set(key, {
        body: bytes,
        sha256,
        contentType: options?.httpMetadata?.contentType ?? null,
      })
      return described(key, objects.get(key)!)
    },
    get: async (key: string) => {
      const stored = objects.get(key)
      return stored ? described(key, stored) : null
    },
    head: async (key: string) => {
      const stored = objects.get(key)
      return stored ? { ...described(key, stored), body: null } : null
    },
    /*
     * One key or many: R2 accepts both, and the sweep that removes expired
     * upload objects passes a list. Handling only the single-key form left
     * every swept object in place while the database said it was gone.
     */
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
  } as unknown as R2Bucket
}

export const testEnv = (overrides: Partial<AppBindings> = {}): AppBindings =>
  ({
    HYPERDRIVE: { connectionString: 'postgres://test/test' },
    /*
     * Local, as an unset `ENVIRONMENT` means — the Worker relays documents
     * itself, which is what the upload and download suites are written
     * against. What was missing is only the bucket underneath: workerd used to
     * supply one, so every download refused with a configuration error rather
     * than answering the authorization question the test was asking.
     */
    STORAGE: memoryBucket(),
    RATE_LIMIT_DISABLED: 'true',
    AUTH_SECRET: 'test-secret-that-is-at-least-thirty-two-bytes',
    ROLE_INVITE_SECRET: 'test-invite-secret-that-is-at-least-32-bytes',
    /*
     * Under the Workers pool wrangler loaded this from `.dev.vars`, so it was
     * never written down here. Nothing outside the node harness supplies it
     * now, and without it every desk review that transcribes an identity
     * number throws rather than refusing.
     */
    IDENTIFIER_SECRET: 'test-identifier-secret-that-is-at-least-32-bytes',
    PORTAL_BASE_URL: 'https://portal.example.test',
    FRONTEND_ORIGINS: 'https://app.example.test',
    AUTH_COOKIE_SAME_SITE: 'lax',
    APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT: '5',
    FIRST_SUPER_ADMIN_EMAIL: 'applicant@example.com',
    FIRST_SUPER_ADMIN_SECRET: 'test-first-super-admin-secret-at-least-32-bytes',
    R2_ACCOUNT_ID: 'test-account-id',
    R2_BUCKET_NAME: 'seb-backend-test',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
    ...overrides,
  }) as unknown as AppBindings
