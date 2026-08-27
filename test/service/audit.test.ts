/**
 * Reading the audit history.
 *
 * Two things are being protected here. One is the gate: this is the most
 * personal read in the portal — who did what, from which address — and only a
 * super administrator may make it. The other is that it stays fast: it reads
 * the largest table in the database, and the query most likely to be run is the
 * one with no filter at all.
 */
import { env, SELF } from '../support/worker'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionTokenDigest } from '../../src/services/auth/crypto'

import {
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


type Envelope<T> = { data?: T; errors?: unknown[] }

const graphql = async <T>(query: string, cookie?: string): Promise<Envelope<T>> => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: 'https://app.example.test',
  })
  if (cookie) headers.set('cookie', cookie)
  const response = await SELF.fetch('https://api.example.test/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  return response.json()
}

const sessionHolding = async (roles: string[]) => {
  const userId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_user (id, email, password_hash, email_verified_at,
        row_version, created_at, updated_at) VALUES (?, ?, 'unused', ?, 1, ?, ?)`,
    ).bind(userId, `${userId}@example.test`, now, now, now),
    ...roles.map((role) => env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at)
       VALUES (?, ?, ?, 'AUDIT_TEST', ?)`,
    ).bind(crypto.randomUUID(), userId, role, now)),
    env.DB.prepare(
      `INSERT INTO core_session (id, user_id, token_digest, expires_at,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), userId,
      await sessionTokenDigest(env.AUTH_SECRET!, token),
      now + 86_400_000, now, now,
    ),
  ])
  return { userId, cookie: `seb_session=${token}` }
}

const recordEvent = async (input: {
  actorUserId?: string | null
  action?: string
  entityType?: string
  entityId?: string | null
  outcome?: 'SUCCESS' | 'FAILURE'
  createdAt?: number
}) => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO core_audit_event (id, actor_user_id, action, entity_type, entity_id,
      outcome, request_id, ip_address, user_agent, changes_json, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ray-1', '203.0.113.9', 'curl/8', NULL, ?, ?)`,
  ).bind(
    id,
    input.actorUserId ?? null,
    input.action ?? 'SEB.APPLICATION_SUBMITTED',
    input.entityType ?? 'SEB_APPLICATION',
    input.entityId ?? crypto.randomUUID(),
    input.outcome ?? 'SUCCESS',
    JSON.stringify({ note: 'fixture' }),
    input.createdAt ?? Date.now(),
  ).run()
  return id
}

type EventsResult = {
  audit: {
    events: {
      success: boolean
      message: string | null
      response: {
        nodes: Array<{
          id: string
          action: string
          outcome: string
          metadata: string | null
          ipAddress: string | null
          actor: { id: string; email: string; roles: string[] } | null
        }>
        pageInfo: { endCursor: string | null; hasNextPage: boolean; totalCount: number }
      } | null
    }
  }
}

const EVENT_FIELDS = `success message response {
  nodes { id action outcome metadata ipAddress actor { id email roles } }
  pageInfo { endCursor hasNextPage totalCount }
}`

const events = (input: string, cookie?: string) =>
  graphql<EventsResult>(`query { audit { events(input: { ${input} }) { ${EVENT_FIELDS} } } }`, cookie)

describe('the audit history', () => {
  it('is readable only by a super administrator', async () => {
    for (const roles of [['REVIEWER'], ['APPROVER'], ['ADMIN'], ['APPLICANT']]) {
      const caller = await sessionHolding(roles)
      const result = await events('first: 5', caller.cookie)
      expect(result.data?.audit.events, roles.join()).toMatchObject({
        success: false,
        message: 'You do not have permission to do that.',
        response: null,
      })
    }
    // And not at all when signed out.
    expect((await events('first: 5')).data?.audit.events.success).toBe(false)

    const superAdmin = await sessionHolding(['SUPER_ADMIN'])
    expect((await events('first: 5', superAdmin.cookie)).data?.audit.events.success).toBe(true)
  })

  it('resolves the actor rather than returning a bare id', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const actor = await sessionHolding(['REVIEWER', 'APPROVER'])
    const id = await recordEvent({ actorUserId: actor.userId, action: 'AUDIT.RESOLVE_ONE' })

    const result = await events(`first: 50, action: ["AUDIT.RESOLVE_ONE"]`, reader.cookie)
    const node = result.data?.audit.events.response?.nodes.find((one) => one.id === id)
    expect(node?.actor?.id).toBe(actor.userId)
    expect(node?.actor?.email).toBe(`${actor.userId}@example.test`)
    // Two roles, one row: the roles are folded rather than joined, or this
    // event would appear twice.
    expect(node?.actor?.roles.sort()).toEqual(['APPROVER', 'REVIEWER'])
    expect(result.data?.audit.events.response?.nodes.filter((one) => one.id === id))
      .toHaveLength(1)
  })

  it('keeps events that have no actor at all', async () => {
    // Verified signup and the bootstrap record no operator. An inner join would
    // hide exactly the events nobody can be asked about.
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const id = await recordEvent({ actorUserId: null, action: 'AUDIT.NO_ACTOR' })
    const result = await events(`first: 50, action: ["AUDIT.NO_ACTOR"]`, reader.cookie)
    const node = result.data?.audit.events.response?.nodes.find((one) => one.id === id)
    expect(node).toBeDefined()
    expect(node?.actor).toBeNull()
  })

  it('scopes to selected people, and to everybody holding a role', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const first = await sessionHolding(['REVIEWER'])
    const second = await sessionHolding(['REVIEWER'])
    const other = await sessionHolding(['ADMIN'])
    const action = `AUDIT.SCOPE_${crypto.randomUUID().slice(0, 8)}`
    await recordEvent({ actorUserId: first.userId, action })
    await recordEvent({ actorUserId: second.userId, action })
    await recordEvent({ actorUserId: other.userId, action })

    const selected = await events(
      `first: 50, action: ["${action}"], actorUserIds: ["${first.userId}"]`, reader.cookie,
    )
    expect(selected.data?.audit.events.response?.pageInfo.totalCount).toBe(1)

    const byRole = await events(
      `first: 50, action: ["${action}"], actorRole: REVIEWER`, reader.cookie,
    )
    expect(byRole.data?.audit.events.response?.pageInfo.totalCount).toBe(2)

    // Both together is an intersection, not a contradiction.
    const both = await events(
      `first: 50, action: ["${action}"], actorRole: ADMIN, actorUserIds: ["${first.userId}"]`,
      reader.cookie,
    )
    expect(both.data?.audit.events.response?.pageInfo.totalCount).toBe(0)
  })

  it('counts everything matching the filters, not just the page', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const action = `AUDIT.COUNT_${crypto.randomUUID().slice(0, 8)}`
    for (let index = 0; index < 5; index += 1) await recordEvent({ action })

    const page = await events(`first: 2, action: ["${action}"]`, reader.cookie)
    const info = page.data?.audit.events.response?.pageInfo
    expect(page.data?.audit.events.response?.nodes).toHaveLength(2)
    // What lets a screen say "1-2 of 5" and tell an empty filter from an empty
    // list. Keyset pagination cannot derive it, so it is counted separately.
    expect(info?.totalCount).toBe(5)
    expect(info?.hasNextPage).toBe(true)
  })

  it('walks pages without repeating or skipping a row', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const action = `AUDIT.WALK_${crypto.randomUUID().slice(0, 8)}`
    const created = Date.now()
    // Deliberately identical timestamps: the id is the tiebreak, and without it
    // a page boundary landing mid-second would repeat or lose rows.
    for (let index = 0; index < 6; index += 1) {
      await recordEvent({ action, createdAt: created })
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 3; page += 1) {
      const result: Envelope<EventsResult> = await events(
        `first: 2, action: ["${action}"]${cursor ? `, after: "${cursor}"` : ''}`,
        reader.cookie,
      )
      const body = result.data!.audit.events.response!
      seen.push(...body.nodes.map((one) => one.id))
      cursor = body.pageInfo.endCursor
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  it('refuses a cursor minted under a different ordering', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    // A cursor from a list ordered by another column would seek the right
    // column from the wrong position and return a wrong page with no error.
    const foreign = btoa(JSON.stringify(['submittedAt', Date.now(), crypto.randomUUID()]))
    const result = await events(`first: 5, after: "${foreign}"`, reader.cookie)
    expect(result.data?.audit.events).toMatchObject({
      success: false, response: null,
    })
  })

  it('refuses an inverted date range rather than returning nothing', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const result = await events(
      `first: 5, from: "2026-06-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z"`,
      reader.cookie,
    )
    expect(result.data?.audit.events).toMatchObject({
      success: false,
      message: 'The start of the range is after its end.',
    })
  })

  it('bounds how many actors and actions one request may name', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const tooMany = Array.from({ length: 51 }, () => `"${crypto.randomUUID()}"`).join(', ')
    expect((await events(`first: 5, actorUserIds: [${tooMany}]`, reader.cookie))
      .data?.audit.events.success).toBe(false)
    const actions = Array.from({ length: 51 }, (_, index) => `"A.${index}"`).join(', ')
    expect((await events(`first: 5, action: [${actions}]`, reader.cookie))
      .data?.audit.events.success).toBe(false)
  })

  it('offers only action names that actually occur', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const action = `AUDIT.OFFERED_${crypto.randomUUID().slice(0, 8)}`
    await recordEvent({ action })
    const result = await graphql<{
      audit: { actions: { success: boolean; response: string[] | null } }
    }>('query { audit { actions { success response } } }', reader.cookie)
    expect(result.data?.audit.actions.response).toContain(action)
  })


  it('applies every remaining filter, and both orderings', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const applicationId = crypto.randomUUID()
    const action = `AUDIT.FILTERS_${crypto.randomUUID().slice(0, 8)}`
    const base = Date.UTC(2026, 0, 10)
    const oldest = await recordEvent({
      action, entityType: 'SEB_APPLICATION', entityId: applicationId,
      outcome: 'SUCCESS', createdAt: base,
    })
    const newest = await recordEvent({
      action, entityType: 'SEB_APPLICATION', entityId: applicationId,
      outcome: 'FAILURE', createdAt: base + 60_000,
    })
    // A different entity type, to prove entityType actually narrows.
    await recordEvent({ action, entityType: 'CORE_USER', createdAt: base + 120_000 })

    const byApplication = await events(
      `first: 50, action: ["${action}"], applicationId: "${applicationId}"`, reader.cookie,
    )
    expect(byApplication.data?.audit.events.response?.pageInfo.totalCount).toBe(2)

    const byEntityType = await events(
      `first: 50, action: ["${action}"], entityType: "CORE_USER"`, reader.cookie,
    )
    expect(byEntityType.data?.audit.events.response?.pageInfo.totalCount).toBe(1)

    const failures = await events(
      `first: 50, action: ["${action}"], outcome: FAILURE`, reader.cookie,
    )
    expect(failures.data?.audit.events.response?.nodes.map((one) => one.id)).toEqual([newest])

    const ranged = await events(
      `first: 50, action: ["${action}"], from: "${new Date(base).toISOString()}",
       to: "${new Date(base + 60_000).toISOString()}"`,
      reader.cookie,
    )
    expect(ranged.data?.audit.events.response?.pageInfo.totalCount).toBe(2)

    // Oldest first reverses both the comparison and the tiebreak, so a cursor
    // taken from one ordering is meaningless in the other — which is why the
    // cursor records which ordering minted it.
    const ascending = await events(
      `first: 1, action: ["${action}"], applicationId: "${applicationId}", order: OLDEST_FIRST`,
      reader.cookie,
    )
    const ascendingBody = ascending.data!.audit.events.response!
    expect(ascendingBody.nodes.map((one) => one.id)).toEqual([oldest])

    const ascendingNext = await events(
      `first: 5, action: ["${action}"], applicationId: "${applicationId}",
       order: OLDEST_FIRST, after: "${ascendingBody.pageInfo.endCursor}"`,
      reader.cookie,
    )
    expect(ascendingNext.data?.audit.events.response?.nodes.map((one) => one.id))
      .toEqual([newest])

    const descending = await events(
      `first: 1, action: ["${action}"], applicationId: "${applicationId}"`, reader.cookie,
    )
    expect(descending.data?.audit.events.response?.nodes.map((one) => one.id))
      .toEqual([newest])
  })

  it('refuses identifiers that are not identifiers', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    for (const input of [
      'first: 5, actorUserIds: ["not-a-uuid"]',
      'first: 5, applicationId: "also-not-a-uuid"',
      'first: 0',
      'first: 101',
    ]) {
      expect((await events(input, reader.cookie)).data?.audit.events, input)
        .toMatchObject({ success: false, response: null })
    }
  })


  it('refuses the action list to anyone who may not read audits', async () => {
    const caller = await sessionHolding(['ADMIN'])
    const result = await graphql<{
      audit: { actions: { success: boolean; response: string[] | null } }
    }>('query { audit { actions { success response } } }', caller.cookie)
    expect(result.data?.audit.actions).toMatchObject({ success: false, response: null })
  })

  it('reports no roles for an actor whose grants have all been revoked', async () => {
    /*
     * The audit row outlives the person's authority. Somebody fully
     * deactivated still has to be nameable, or the history of what they did
     * becomes unattributable at exactly the moment it matters most.
     */
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const actor = await sessionHolding(['ADMIN'])
    const action = `AUDIT.REVOKED_${crypto.randomUUID().slice(0, 8)}`
    await recordEvent({ actorUserId: actor.userId, action })
    await env.DB.prepare(
      `UPDATE core_user_role_grant SET revoked_at = ?, revocation_reason = 'TEST'
       WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(Date.now(), actor.userId).run()

    const result = await events(`first: 5, action: ["${action}"]`, reader.cookie)
    const node = result.data?.audit.events.response?.nodes[0]
    expect(node?.actor?.id).toBe(actor.userId)
    expect(node?.actor?.roles).toEqual([])
  })

  it('seeks the created index instead of scanning, with no filters at all', async () => {
    /*
     * The query most likely to be run against the largest table. Every other
     * index on this table leads with a filter column, so before
     * `core_audit_event_created_idx` existed this scanned and sorted.
     *
     * Asserting the plan rather than a duration: a timing test on a small
     * fixture would pass whether or not the index is used.
     *
     * **Seeded first, and that is the whole test.** Postgres sequentially scans
     * a small table whatever indexes exist, so a plan taken against a handful of
     * rows says nothing at all — it would report a scan for the right reason and
     * the assertion would fail against a correct database. Twenty thousand rows
     * and an `ANALYZE` are what make the planner's choice meaningful.
     */
    await activeDatabase().execute(sql`
      INSERT INTO core_audit_event
        (id, actor_user_id, action, entity_type, entity_id, outcome, created_at)
      SELECT gen_random_uuid()::text, NULL, 'SEB.CYCLE_OPENED', 'SEB_PROGRAMME_CYCLE',
             gen_random_uuid()::text, 'SUCCESS',
             now() - (g || ' seconds')::interval
      FROM generate_series(1, 20000) AS g
    `)
    await activeDatabase().execute(sql`ANALYZE core_audit_event`)

    const plan = await activeDatabase().execute(sql`
      EXPLAIN (FORMAT TEXT)
      SELECT id FROM core_audit_event ORDER BY created_at DESC, id DESC LIMIT 21
    `)
    const detail = plan.rows.map((row) => Object.values(row)[0]).join(' | ')
    /*
     * An index scan in the index's own order is the good outcome: Postgres
     * walks it backwards and stops at 21 rows. The bad outcome is a sequential
     * scan, and worse still a `Sort` — which is the node this index exists to
     * remove, and which would read every one of those 20,000 rows first.
     */
    expect(detail).toContain('core_audit_event_created_idx')
    expect(detail).not.toContain('Seq Scan')
    expect(detail).not.toContain('Sort')
  })
})
