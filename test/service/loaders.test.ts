/**
 * Per-request batched lookups.
 *
 * Two properties matter here and only one of them is about speed.
 *
 * The batching is why the loader exists: a page of rows naming many people
 * costs one query rather than one per row. The **isolation** is why it is
 * created per request — a loader is a cache, and one shared between requests
 * would answer one person's query with another's data.
 */
import { env } from '../support/worker'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createLoaders, type StaffMember } from '../../src/loaders'
import { countRoundTrips } from '../support/round-trips'

import {
  activeDriverHandle,
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'

/*
 * One schema per file, emptied between tests. `isolatedStorage` gave the
 * Workers pool the same guarantee; applying the schema per test instead
 * costs four and a half seconds a time.
 */
beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})


/**
 * Somebody holding the composed roles named.
 *
 * Roles are rows, so the fixture makes real ones — sharing a row when two
 * people hold the same key, exactly as the product does.
 */
const person = async (roles: string[] = ['DESK_REVIEWER']) => {
  const id = crypto.randomUUID()
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO core_user (id, email, password_hash, email_verified_at,
      row_version, created_at, updated_at) VALUES (?, ?, 'x', ?, 1, ?, ?)`,
  ).bind(id, `${id}@example.test`, now, now, now).run()

  for (const key of roles) {
    await env.DB.prepare(
      `INSERT INTO core_role (id, key, name, description, current_version,
        created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, 'Composed by the loader suite.', 1, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
    ).bind(crypto.randomUUID(), key, key, now, now, id).run()
    const role = await env.DB.prepare(
      `SELECT id FROM core_role WHERE key = ?`,
    ).bind(key).first<{ id: string }>()
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role_id, grant_reason, granted_at)
       VALUES (?, ?, ?, 'LOADER_TEST', ?)`,
    ).bind(crypto.randomUUID(), id, role!.id, now).run()
  }
  return id
}

describe('resolving people by id', () => {
  it('answers a page of rows without a query per row', async () => {
    /*
     * Twenty rows naming twelve distinct people. Resolved one at a time that
     * is twelve queries; this asserts it is not.
     */
    const twelve = await Promise.all(Array.from({ length: 12 }, () => person()))
    const twentyRows = Array.from({ length: 20 }, (_, index) => twelve[index % 12]!)

    const trips = countRoundTrips(activeDriverHandle() as never)
    const loaders = createLoaders(activeDatabase())
    trips.reset()
    const resolved: Array<StaffMember | null> = await Promise.all(
      twentyRows.map((id) => loaders.userById.load(id)),
    )

    expect(resolved).toHaveLength(20)
    expect(resolved.every((one) => one !== null)).toBe(true)
    // Two: the people, and their role grants. Not twelve, and not twenty.
    expect(trips.count(), trips.statements().join('\n')).toBe(2)
  })

  it('keeps a missing person in their own place rather than dropping them', async () => {
    /*
     * DataLoader's contract, and the easy thing to get wrong. Omitting an
     * absent key shifts every later answer onto the wrong row — silently, and
     * only for pages that happen to contain a deleted account.
     */
    const first = await person()
    const third = await person()
    const missing = crypto.randomUUID()
    const loaders = createLoaders(activeDatabase())

    const resolved = await Promise.all(
      [first, missing, third].map((id) => loaders.userById.load(id)),
    )
    expect(resolved.map((one) => one?.id ?? null)).toEqual([first, null, third])
  })

  it('reports the roles held now, not the ones since revoked', async () => {
    const id = await person(['DESK_REVIEWER', 'DECISION_APPROVER'])
    await env.DB.prepare(
      `UPDATE core_user_role_grant SET revoked_at = ?, revocation_reason = 'TEST'
       WHERE user_id = ? AND role_id = (
         SELECT id FROM core_role WHERE key = 'DECISION_APPROVER')`,
    ).bind(Date.now(), id).run()

    const loaders = createLoaders(activeDatabase())
    // Revocation closes a grant rather than deleting it, so an unfiltered read
    // would report authority this person no longer has.
    expect((await loaders.userById.load(id))?.roles).toEqual(['DESK_REVIEWER'])
  })

  it('does not carry one request\'s answers into another', async () => {
    /*
     * The property the whole design rests on. A loader is a cache; if it were
     * built once and shared, a role granted after the first request would keep
     * reading as absent, and — far worse — one person's row could answer
     * somebody else's query.
     */
    const id = await person([])
    const db = activeDatabase()

    const firstRequest = createLoaders(db)
    expect((await firstRequest.userById.load(id))?.roles).toEqual([])

    const roleId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO core_role (id, key, name, description, current_version,
        created_at, updated_at, created_by_user_id)
       VALUES (?, 'CASEWORKER', 'Caseworker', 'Works applications.', 1, ?, ?, ?)`,
    ).bind(roleId, Date.now(), Date.now(), id).run()
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role_id, grant_reason, granted_at)
       VALUES (?, ?, ?, 'LOADER_TEST', ?)`,
    ).bind(crypto.randomUUID(), id, roleId, Date.now()).run()

    // Same isolate, same database, a new request: it must see the grant.
    const secondRequest = createLoaders(db)
    expect((await secondRequest.userById.load(id))?.roles).toEqual(['CASEWORKER'])

    // And the first request's loader still holds what it read, which is
    // correct — one request is one instant.
    expect((await firstRequest.userById.load(id))?.roles).toEqual([])
  })
})
