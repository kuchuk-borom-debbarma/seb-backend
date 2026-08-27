/**
 * The test harness itself, proved before anything is built on it.
 *
 * Four hundred fixture statements are about to be rewritten by machine rather
 * than by hand. That is only safer than hand-editing if the machine is right, so
 * the rewrite and the marshalling are asserted here directly — including the two
 * cases that would otherwise be silent: a `?` inside a string literal, and a
 * fixture number reaching a column whose type is not a number.
 */
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { positional, shimDatabase, type ShimDatabase } from '../support/d1-shim'
import type { TestClient } from '../support/client'
import {
  activeShim,
  closeDatabase,
  freshDatabase,
  resetDatabase,
  testEnv,
} from '../support/harness'
import worker from '../../src/index'
import { sessionTokenDigest } from '../../src/services/auth/crypto'

describe('rewriting a D1 statement', () => {
  it('numbers placeholders in the order they appear', () => {
    expect(positional('INSERT INTO t (a, b, c) VALUES (?, ?, ?)')).toBe(
      'INSERT INTO t (a, b, c) VALUES ($1, $2, $3)',
    )
  })

  it('leaves a question mark inside a string literal alone', () => {
    // The schema's own CHECK patterns contain `?`. Renumbering past one would
    // shift every parameter after it, which is the exact failure this rewrite
    // exists to make impossible.
    expect(positional(`SELECT ? WHERE code ~ 'a?b' AND x = ?`)).toBe(
      `SELECT $1 WHERE code ~ 'a?b' AND x = $2`,
    )
  })

  it('handles a doubled quote inside a literal', () => {
    expect(positional(`SELECT ? WHERE name = 'it''s ?' AND y = ?`)).toBe(
      `SELECT $1 WHERE name = 'it''s ?' AND y = $2`,
    )
  })
})

describe('marshalling a fixture value', () => {
  /*
   * Its own PGlite rather than the shared harness: this is about the shim's
   * own arithmetic on a table nothing else has, so it wants a database it can
   * shape freely and throw away.
   */
  let pglite: PGlite
  let db: TestClient
  let DB: ShimDatabase

  beforeEach(async () => {
    pglite = new PGlite()
    db = {
      query: (text, params) => pglite.query(text, params as unknown[]) as never,
      exec: (sql) => pglite.exec(sql),
      close: () => pglite.close(),
      driver: 'pglite',
    }
    await pglite.exec(`
      CREATE TABLE probe (
        id text PRIMARY KEY,
        at timestamp with time zone,
        on_day date,
        flag boolean,
        size bigint,
        label text
      );
    `)
    DB = shimDatabase(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('turns epoch milliseconds into the instant the column wants', async () => {
    const now = Date.UTC(2026, 3, 1, 9, 30)
    await DB.prepare('INSERT INTO probe (id, at) VALUES (?, ?)').bind('a', now).run()
    const stored = await DB.prepare('SELECT at FROM probe WHERE id = ?').bind('a').first<Date>('at')
    expect(new Date(stored as unknown as string).getTime()).toBe(now)
  })

  it('turns an integer boolean into a boolean', async () => {
    await DB.prepare('INSERT INTO probe (id, flag) VALUES (?, ?)').bind('a', 1).run()
    await DB.prepare('INSERT INTO probe (id, flag) VALUES (?, ?)').bind('b', 0).run()
    expect(await DB.prepare('SELECT flag FROM probe WHERE id = ?').bind('a').first('flag')).toBe(true)
    expect(await DB.prepare('SELECT flag FROM probe WHERE id = ?').bind('b').first('flag')).toBe(false)
  })

  /*
   * The reason marshalling reads the declared type instead of the value.
   *
   * 1_700_000_000 is a plausible file size and a plausible epoch second. A rule
   * that guessed from the value would have turned this into a date in 2023 and
   * nothing downstream would have noticed.
   */
  it('leaves a number alone when the column really is a number', async () => {
    await DB.prepare('INSERT INTO probe (id, size) VALUES (?, ?)')
      .bind('a', 1_700_000_000)
      .run()
    /*
     * Asserted by value, deliberately. **PGlite and node-postgres disagree about
     * how a `bigint` comes back**: PGlite parses one inside the safe range to a
     * number, node-postgres returns a string. Production never sees that,
     * because every money column is read through Drizzle's `paise()` with
     * `mode: 'number'` and the two raw reads that exist cast to `::int` — but a
     * test that asserted the representation would pass here and fail against
     * Neon, which is a divergence to know about rather than discover.
     */
    const stored = await DB.prepare('SELECT size FROM probe WHERE id = ?').bind('a').first('size')
    expect(Number(stored)).toBe(1_700_000_000)
  })

  it('reports how many rows a statement changed', async () => {
    await DB.prepare('INSERT INTO probe (id, label) VALUES (?, ?)').bind('a', 'x').run()
    await DB.prepare('INSERT INTO probe (id, label) VALUES (?, ?)').bind('b', 'x').run()
    const result = await DB.prepare('UPDATE probe SET label = ? WHERE label = ?')
      .bind('y', 'x')
      .run()
    expect(result.meta.changes).toBe(2)
  })

  it('rolls a batch back whole when one statement fails', async () => {
    await expect(
      DB.batch([
        DB.prepare('INSERT INTO probe (id, label) VALUES (?, ?)').bind('a', 'kept?'),
        // Same primary key: the second refuses, and the first must not survive.
        DB.prepare('INSERT INTO probe (id, label) VALUES (?, ?)').bind('a', 'no'),
      ]),
    ).rejects.toThrow()
    const rows = await DB.prepare('SELECT id FROM probe').all()
    expect(rows.results).toEqual([])
  })
})

describe('the Worker, driven over HTTP without workerd', () => {
  beforeAll(async () => {
    await freshDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('answers a GraphQL request against the test database', async () => {
    const response = await worker.fetch(
      new Request('https://api.example.test/graphql', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://app.example.test',
        },
        body: JSON.stringify({ query: '{ health { name status } }' }),
      }),
      testEnv(),
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { health: { status: string } } }
    expect(body.data.health.status).toBe('ok')
  })

  /*
   * Proves the seam actually reaches the test database.
   *
   * `health` above does not touch one, so it would pass against a Worker wired
   * to nothing. This reads a session, a user and a role grant this test wrote,
   * through Hono, the cookie parser, the resolvers and the service layer — and
   * asserts the role that came back, which is a value only this database holds.
   */
  it('reads rows the test wrote, through the whole Worker', async () => {
    const DB = activeShim()
    const env = testEnv()
    const token = 'a-session-token-for-this-test'
    const now = Date.now()
    await DB.batch([
      DB.prepare(
        `INSERT INTO core_user (id, email, password_hash, row_version, created_at, updated_at)
         VALUES (?, ?, 'unused', 1, ?, ?)`,
      ).bind('u1', 'someone@example.test', now, now),
      DB.prepare(
        `INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at)
         VALUES (?, ?, 'APPLICANT', 'TEST_FIXTURE', ?)`,
      ).bind(crypto.randomUUID(), 'u1', now),
      DB.prepare(
        `INSERT INTO core_session (id, user_id, token_digest, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        'u1',
        await sessionTokenDigest(env.AUTH_SECRET, token),
        now + 86_400_000,
        now,
        now,
      ),
    ])

    const response = await worker.fetch(
      new Request('https://api.example.test/graphql', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://app.example.test',
          cookie: `seb_session=${token}`,
        },
        body: JSON.stringify({
          query: '{ auth { currentSession { success response { user { email roles } } } } }',
        }),
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
    )
    const body = (await response.json()) as {
      data: {
        auth: {
          currentSession: {
            success: boolean
            response: { user: { email: string; roles: string[] } } | null
          }
        }
      }
    }
    expect(body.data.auth.currentSession.success).toBe(true)
    expect(body.data.auth.currentSession.response?.user.email).toBe('someone@example.test')
    expect(body.data.auth.currentSession.response?.user.roles).toEqual(['APPLICANT'])
  })
})
