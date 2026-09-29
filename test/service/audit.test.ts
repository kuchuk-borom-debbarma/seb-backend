/**
 * Reading the audit history, and taking a copy of it.
 *
 * Three things are being protected here. One is the gate: this is the most
 * personal read in the portal — who did what, from which address — and only a
 * role holding `audit`/`read` may make it, and only one also holding
 * `audit`/`export` may take it away. Another is that it says what happened in
 * words a person can read, without losing what was actually recorded. The last
 * is that it stays fast: it reads the largest table in the database, and the
 * query most likely to be run is the one with no filter at all.
 */
import { env, SELF } from '../support/worker'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionTokenDigest } from '../../src/services/auth/crypto'

import {
  activeDatabase,
  activeDriverHandle,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { countRoundTrips } from '../support/round-trips'
import { openCycle, signIn } from '../support/api'
import { submittedProfile } from './support/intake-fixtures'

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

/**
 * A session holding the authorities named.
 *
 * `APPLICANT` and `SUPER_ADMIN` are decided in code and go in the grant's own
 * column; every other name is composed as a real role row and granted, which is
 * how the office actually holds one. The audit history filters and reports by
 * name, so this fixture has to produce names the same way the product does.
 */
const BUILTIN = new Set(['APPLICANT', 'SUPER_ADMIN'])

const sessionHolding = async (roles: string[], permissions: [string, string][] = []) => {
  const userId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const now = Date.now()

  // The identity first: a role records who composed it, so the row it points at
  // has to exist before the role does.
  await env.DB.prepare(
    `INSERT INTO core_user (id, email, password_hash, email_verified_at,
      row_version, created_at, updated_at) VALUES (?, ?, 'unused', ?, 1, ?, ?)`,
  ).bind(userId, `${userId}@example.test`, now, now, now).run()

  /*
   * A role key is unique, so two people holding the same role share one row —
   * as they do in the product. Created before the batch because the grants
   * below need its id, and `ON CONFLICT` is what makes the second caller reuse
   * the first's row rather than collide with it.
   */
  const composed: { role: string; id: string }[] = []
  for (const role of roles.filter((name) => !BUILTIN.has(name))) {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO core_role (id, key, name, description, current_version,
        created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, 'Composed by the audit suite.', 1, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
    ).bind(id, role, role, now, now, userId).run()
    const existing = await env.DB.prepare(
      `SELECT id FROM core_role WHERE key = ?`,
    ).bind(role).first<{ id: string }>()
    composed.push({ role, id: existing!.id })
  }

  await env.DB.batch([
    ...roles.filter((role) => BUILTIN.has(role)).map((role) => env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at)
       VALUES (?, ?, ?, 'AUDIT_TEST', ?)`,
    ).bind(crypto.randomUUID(), userId, role, now)),
    ...composed.flatMap(({ id }) => [
      ...permissions.map(([resource, action]) => env.DB.prepare(
        `INSERT INTO core_role_permission (id, role_id, resource, action, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(crypto.randomUUID(), id, resource, action, now)),
      env.DB.prepare(
        `INSERT INTO core_user_role_grant (id, user_id, role_id, grant_reason, granted_at)
         VALUES (?, ?, ?, 'AUDIT_TEST', ?)`,
      ).bind(crypto.randomUUID(), userId, id, now),
    ]),
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
  requestId?: string | null
  userAgent?: string
  subjectUserId?: string | null
  applicationId?: string | null
  /** A typed payload. Absent, the row is written as the legacy generation was. */
  payload?: Record<string, unknown>
}) => {
  const id = crypto.randomUUID()
  const typed = input.payload !== undefined
  await env.DB.prepare(
    `INSERT INTO core_audit_event (id, actor_user_id, action, entity_type, entity_id,
      outcome, request_id, ip_address, user_agent, changes_json, metadata_json, created_at,
      subject_user_id, application_id, payload, payload_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, '203.0.113.9', ?, NULL, ?, ?, ?, ?, ?::jsonb, ?)`,
  ).bind(
    id,
    input.actorUserId ?? null,
    input.action ?? 'SEB.APPLICATION_SUBMITTED',
    input.entityType ?? 'SEB_APPLICATION',
    input.entityId ?? crypto.randomUUID(),
    input.outcome ?? 'SUCCESS',
    input.requestId === undefined ? 'ray-1' : input.requestId,
    input.userAgent ?? 'curl/8',
    typed ? null : JSON.stringify({ note: 'fixture' }),
    input.createdAt ?? Date.now(),
    input.subjectUserId ?? null,
    input.applicationId ?? null,
    typed ? JSON.stringify(input.payload) : null,
    typed ? 1 : 0,
  ).run()
  return id
}

type Person = { id: string; email: string; roles: string[] }
type Detail = {
  key: string
  label: string
  kind: string
  value: string | null
  reference: { id: string; label: string | null; exists: boolean } | null
}
type Node = {
  id: string
  action: string
  actionLabel: string
  category: string
  summary: string
  detailed: boolean
  outcome: string
  payloadJson: string | null
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
  actor: Person | null
  subject: Person | null
  application: { id: string; label: string | null; exists: boolean } | null
  details: Detail[]
}

type EventsResult = {
  audit: {
    events: {
      success: boolean
      message: string | null
      response: {
        nodes: Node[]
        pageInfo: { endCursor: string | null; hasNextPage: boolean; totalCount: number }
      } | null
    }
  }
}

const NODE_FIELDS = `id action actionLabel category summary detailed outcome payloadJson
  ipAddress userAgent requestId
  actor { id email roles } subject { id email roles }
  application { id label exists }
  details { key label kind value reference { id label exists } }`

const EVENT_FIELDS = `success message response {
  nodes { ${NODE_FIELDS} }
  pageInfo { endCursor hasNextPage totalCount }
}`

/**
 * One page. `paging` is the page's own arguments; `filter` is the inside of the
 * filter object, both as GraphQL argument text.
 */
const events = (paging: string, filter = '', cookie?: string) =>
  graphql<EventsResult>(
    `query { audit { events(input: { ${paging}${filter ? `, filter: { ${filter} }` : ''} }) { ${EVENT_FIELDS} } } }`,
    cookie,
  )

const totalOf = (result: Envelope<EventsResult>) => result.data?.audit.events.response?.pageInfo.totalCount
const idsOf = (result: Envelope<EventsResult>) => result.data?.audit.events.response?.nodes.map((one) => one.id)

describe('the audit history', () => {
  it('is readable only by a role that may read it', async () => {
    for (const roles of [['DESK_REVIEWER'], ['DECISION_APPROVER'], ['CASEWORKER'], ['APPLICANT']]) {
      const caller = await sessionHolding(roles)
      const result = await events('first: 5', '', caller.cookie)
      expect(result.data?.audit.events, roles.join()).toMatchObject({
        success: false,
        message: 'You do not have permission to do that.',
        response: null,
      })
    }
    // And not at all when signed out.
    expect((await events('first: 5')).data?.audit.events.success).toBe(false)

    const superAdmin = await sessionHolding(['SUPER_ADMIN'])
    expect((await events('first: 5', '', superAdmin.cookie)).data?.audit.events.success).toBe(true)
    // A composed role holding only the permission is enough; no rank is implied.
    const historyReader = await sessionHolding(['HISTORY_READER'], [['audit', 'read']])
    expect((await events('first: 5', '', historyReader.cookie)).data?.audit.events.success).toBe(true)
  })

  it('resolves the actor rather than returning a bare id', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const actor = await sessionHolding(['DESK_REVIEWER', 'DECISION_APPROVER'])
    const id = await recordEvent({ actorUserId: actor.userId, action: 'AUDIT.RESOLVE_ONE' })

    const result = await events('first: 50', 'actions: ["AUDIT.RESOLVE_ONE"]', reader.cookie)
    const node = result.data?.audit.events.response?.nodes.find((one) => one.id === id)
    expect(node?.actor?.id).toBe(actor.userId)
    expect(node?.actor?.email).toBe(`${actor.userId}@example.test`)
    // Two roles, one row: the roles are folded rather than joined, or this
    // event would appear twice.
    expect(node?.actor?.roles.sort()).toEqual(['DECISION_APPROVER', 'DESK_REVIEWER'])
    expect(result.data?.audit.events.response?.nodes.filter((one) => one.id === id)).toHaveLength(1)
  })

  it('keeps events that have no actor at all', async () => {
    // Verified signup and the bootstrap record no operator. An inner join would
    // hide exactly the events nobody can be asked about.
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const id = await recordEvent({ actorUserId: null, action: 'AUDIT.NO_ACTOR' })
    const result = await events('first: 50', 'actions: ["AUDIT.NO_ACTOR"]', reader.cookie)
    const node = result.data?.audit.events.response?.nodes.find((one) => one.id === id)
    expect(node).toBeDefined()
    expect(node?.actor).toBeNull()
  })

  it('scopes to selected people, and to everybody holding a role', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const first = await sessionHolding(['DESK_REVIEWER'])
    const second = await sessionHolding(['DESK_REVIEWER'])
    const other = await sessionHolding(['CASEWORKER'])
    const action = `AUDIT.SCOPE_${crypto.randomUUID().slice(0, 8)}`
    await recordEvent({ actorUserId: first.userId, action })
    await recordEvent({ actorUserId: second.userId, action })
    await recordEvent({ actorUserId: other.userId, action })

    const scoped = (filter: string) => events('first: 50', `actions: ["${action}"], ${filter}`, reader.cookie)
    expect(totalOf(await scoped(`actorUserIds: ["${first.userId}"]`))).toBe(1)
    expect(totalOf(await scoped('actorRole: "DESK_REVIEWER"'))).toBe(2)
    // Both together is an intersection, not a contradiction.
    expect(totalOf(await scoped(`actorRole: "CASEWORKER", actorUserIds: ["${first.userId}"]`))).toBe(0)
  })

  it('tells what somebody did from what was done to them, and gives both as their history', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const officer = await sessionHolding(['CASEWORKER'])
    const applicant = await sessionHolding(['APPLICANT'])
    const action = `AUDIT.PEOPLE_${crypto.randomUUID().slice(0, 8)}`
    const byOfficer = await recordEvent({ action, actorUserId: officer.userId, subjectUserId: applicant.userId })
    const byApplicant = await recordEvent({ action, actorUserId: applicant.userId, subjectUserId: applicant.userId })
    await recordEvent({ action, actorUserId: officer.userId })

    const scoped = (filter: string) => events('first: 50', `actions: ["${action}"], ${filter}`, reader.cookie)
    expect(totalOf(await scoped(`subjectUserIds: ["${applicant.userId}"]`))).toBe(2)
    expect(totalOf(await scoped(`actorUserIds: ["${officer.userId}"]`))).toBe(2)
    // Their history: what they did, and what was done to them — each row once.
    expect(new Set(idsOf(await scoped(`involvingUserId: "${applicant.userId}"`)))).toEqual(
      new Set([byOfficer, byApplicant]),
    )
    const subjectOnPage = (await scoped(`involvingUserId: "${applicant.userId}"`))
      .data?.audit.events.response?.nodes.find((one) => one.id === byOfficer)
    expect(subjectOnPage?.subject?.id).toBe(applicant.userId)
    expect(subjectOnPage?.subject?.roles).toEqual(['APPLICANT'])
  })

  it('counts everything matching the filters, not just the page', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const action = `AUDIT.COUNT_${crypto.randomUUID().slice(0, 8)}`
    for (let index = 0; index < 5; index += 1) await recordEvent({ action })

    const page = await events('first: 2', `actions: ["${action}"]`, reader.cookie)
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
        `first: 2${cursor ? `, after: "${cursor}"` : ''}`,
        `actions: ["${action}"]`,
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
    expect((await events(`first: 5, after: "${foreign}"`, '', reader.cookie)).data?.audit.events)
      .toMatchObject({ success: false, response: null })

    /*
     * The same column read the other way round is just as wrong: a newest-first
     * cursor seeks rows *older* than its position, so reused oldest-first it
     * would skip everything newer and return a plausible, wrong page.
     */
    for (let index = 0; index < 3; index += 1) await recordEvent({ action: 'AUDIT.DIRECTION' })
    const newest = await events('first: 1', 'actions: ["AUDIT.DIRECTION"]', reader.cookie)
    const cursor = newest.data!.audit.events.response!.pageInfo.endCursor
    expect(
      (await events(`first: 5, order: OLDEST_FIRST, after: "${cursor}"`, 'actions: ["AUDIT.DIRECTION"]', reader.cookie))
        .data?.audit.events,
    ).toMatchObject({ success: false, response: null })
  })

  it('refuses an inverted date range rather than returning nothing', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const result = await events(
      'first: 5',
      'from: "2026-06-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z"',
      reader.cookie,
    )
    expect(result.data?.audit.events).toMatchObject({
      success: false,
      message: 'The start of the range is after its end.',
    })
  })

  it('bounds how many people, actions and entity types one request may name', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const tooManyPeople = Array.from({ length: 51 }, () => `"${crypto.randomUUID()}"`).join(', ')
    const tooManyActions = Array.from({ length: 51 }, (_, index) => `"A.${index}"`).join(', ')
    const tooManyTypes = Array.from({ length: 21 }, (_, index) => `"T_${index}"`).join(', ')
    for (const filter of [
      `actorUserIds: [${tooManyPeople}]`,
      `subjectUserIds: [${tooManyPeople}]`,
      `actions: [${tooManyActions}]`,
      `entityTypes: [${tooManyTypes}]`,
    ]) {
      expect((await events('first: 5', filter, reader.cookie)).data?.audit.events.success, filter).toBe(false)
    }
  })

  it('offers the action names that actually occur, labelled and grouped', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const unknown = `AUDIT.OFFERED_${crypto.randomUUID().slice(0, 8)}`
    await recordEvent({ action: unknown })
    await recordEvent({ action: 'RBAC.ROLE_CREATED' })
    const result = await graphql<{
      audit: { actions: { success: boolean; response: { action: string; label: string; category: string }[] | null } }
    }>('query { audit { actions { success response { action label category } } } }', reader.cookie)
    const offered = result.data?.audit.actions.response ?? []
    expect(offered).toContainEqual({ action: 'RBAC.ROLE_CREATED', label: 'Composed a role', category: 'ACCESS' })
    // A name this build never declared is still offered — it is in the
    // history — under OTHER, with a label made from its code.
    expect(offered.find((one) => one.action === unknown)?.category).toBe('OTHER')
    // Nothing is offered that was never recorded.
    expect(offered.map((one) => one.action)).not.toContain('RBAC.ROLE_RETIRED')
  })

  it('applies every remaining filter, and both orderings', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const applicationId = crypto.randomUUID()
    const action = `AUDIT.FILTERS_${crypto.randomUUID().slice(0, 8)}`
    const base = Date.UTC(2026, 0, 10)
    const oldest = await recordEvent({
      action, entityType: 'SEB_APPLICATION', entityId: applicationId, applicationId,
      outcome: 'SUCCESS', createdAt: base, requestId: 'ray-oldest',
    })
    // A child record of the same application: the application filter now
    // includes what happened to its documents, review and money.
    const newest = await recordEvent({
      action, entityType: 'SEB_APPLICATION_DOCUMENT', applicationId,
      outcome: 'FAILURE', createdAt: base + 60_000,
    })
    const unrelated = await recordEvent({ action, entityType: 'CORE_USER', entityId: 'u-1', createdAt: base + 120_000 })

    const scoped = (filter: string, paging = 'first: 50') => events(paging, `actions: ["${action}"], ${filter}`, reader.cookie)
    expect(new Set(idsOf(await scoped(`applicationId: "${applicationId}"`)))).toEqual(new Set([oldest, newest]))
    expect(idsOf(await scoped('entityTypes: ["CORE_USER"]'))).toEqual([unrelated])
    expect(idsOf(await scoped('entityTypes: ["CORE_USER"], entityId: "u-2"'))).toEqual([])
    expect(idsOf(await scoped('outcome: FAILURE'))).toEqual([newest])
    expect(idsOf(await scoped('requestId: "ray-oldest"'))).toEqual([oldest])
    expect(totalOf(await scoped(
      `from: "${new Date(base).toISOString()}", to: "${new Date(base + 60_000).toISOString()}"`,
    ))).toBe(2)

    // Oldest first reverses both the comparison and the tiebreak.
    const ascending = await scoped(`applicationId: "${applicationId}"`, 'first: 1, order: OLDEST_FIRST')
    const ascendingBody = ascending.data!.audit.events.response!
    expect(ascendingBody.nodes.map((one) => one.id)).toEqual([oldest])
    const ascendingNext = await scoped(
      `applicationId: "${applicationId}"`,
      `first: 5, order: OLDEST_FIRST, after: "${ascendingBody.pageInfo.endCursor}"`,
    )
    expect(idsOf(ascendingNext)).toEqual([newest])
    expect(idsOf(await scoped(`applicationId: "${applicationId}"`, 'first: 1'))).toEqual([newest])
  })

  it('filters by category, including actions this build does not know', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const access = await recordEvent({ action: 'RBAC.ROLE_CREATED', entityType: 'CORE_ROLE' })
    const funding = await recordEvent({ action: 'SEB.RELEASE_RECORDED', entityType: 'SEB_DISBURSEMENT' })
    const unknown = await recordEvent({ action: `LEGACY.RENAMED_${crypto.randomUUID().slice(0, 8)}` })

    const inCategories = async (categories: string) =>
      new Set(idsOf(await events('first: 50', `categories: [${categories}]`, reader.cookie)))
    expect(await inCategories('ACCESS')).toEqual(new Set([access]))
    expect(await inCategories('ACCESS, FUNDING')).toEqual(new Set([access, funding]))
    // OTHER is everything not declared — which is where a legacy name lives.
    expect((await inCategories('OTHER')).has(unknown)).toBe(true)
    expect((await inCategories('OTHER')).has(access)).toBe(false)
  })

  it('refuses identifiers that are not identifiers', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    for (const [paging, filter] of [
      ['first: 5', 'actorUserIds: ["not-a-uuid"]'],
      ['first: 5', 'subjectUserIds: ["not-a-uuid"]'],
      ['first: 5', 'involvingUserId: "not-a-uuid"'],
      ['first: 5', 'applicationId: "also-not-a-uuid"'],
      ['first: 0', ''],
      ['first: 101', ''],
    ] as const) {
      expect((await events(paging, filter, reader.cookie)).data?.audit.events, `${paging} ${filter}`)
        .toMatchObject({ success: false, response: null })
    }
  })

  it('refuses the action list to anyone who may not read audits', async () => {
    const caller = await sessionHolding(['CASEWORKER'])
    const result = await graphql<{
      audit: { actions: { success: boolean; response: unknown[] | null } }
    }>('query { audit { actions { success response { action } } } }', caller.cookie)
    expect(result.data?.audit.actions).toMatchObject({ success: false, response: null })
  })

  it('reports no roles for an actor whose grants have all been revoked', async () => {
    /*
     * The audit row outlives the person's authority. Somebody fully
     * deactivated still has to be nameable, or the history of what they did
     * becomes unattributable at exactly the moment it matters most.
     */
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const actor = await sessionHolding(['CASEWORKER'])
    const action = `AUDIT.REVOKED_${crypto.randomUUID().slice(0, 8)}`
    await recordEvent({ actorUserId: actor.userId, action })
    await env.DB.prepare(
      `UPDATE core_user_role_grant SET revoked_at = ?, revocation_reason = 'TEST'
       WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(Date.now(), actor.userId).run()

    const result = await events('first: 5', `actions: ["${action}"]`, reader.cookie)
    const node = result.data?.audit.events.response?.nodes[0]
    expect(node?.actor?.id).toBe(actor.userId)
    expect(node?.actor?.roles).toEqual([])
  })
})

describe('an application by its reference', () => {
  it('finds everything filed under the application whose reference is given, in any case', async () => {
    const officer = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(officer.cookie)
    const file = await submittedProfile({ cycleId: cycle.id })
    const reader = await sessionHolding(['SUPER_ADMIN'])

    const byReference = await events('first: 50', `applicationReference: "${file.referenceNumber.toLowerCase()}"`, reader.cookie)
    const actions = byReference.data?.audit.events.response?.nodes.map((one) => one.action) ?? []
    expect(actions).toContain('SEB.APPLICATION_SUBMITTED')
    expect(actions).toContain('SEB.APPLICATION_STARTED')
    // Every row is this file's, whatever record it was written against.
    const ids = new Set(byReference.data?.audit.events.response?.nodes.map((one) => one.application?.id))
    expect(ids).toEqual(new Set([file.applicationId]))
    expect(byReference.data?.audit.events.response?.nodes[0]?.application?.label).toBe(file.referenceNumber)
    // A reference that names nothing is an empty page, not an error.
    expect(totalOf(await events('first: 5', 'applicationReference: "SEB-NOPE-0000"', reader.cookie))).toBe(0)
  })
})

describe('what an entry says', () => {
  it('reads a typed entry through its action: labels, names, and one sentence', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const officer = await sessionHolding(['SUPER_ADMIN'])
    const holder = await sessionHolding(['CASEWORKER'])
    const id = await recordEvent({
      action: 'RBAC.ROLE_GRANTED',
      entityType: 'CORE_USER_ROLE_GRANT',
      actorUserId: officer.userId,
      subjectUserId: holder.userId,
      payload: { subjectUserId: holder.userId, role: 'CASEWORKER', via: 'DIRECT', reason: 'Joined the desk.' },
    })

    const node = (await events('first: 5', 'actions: ["RBAC.ROLE_GRANTED"]', reader.cookie))
      .data?.audit.events.response?.nodes.find((one) => one.id === id)
    expect(node).toMatchObject({ detailed: true, category: 'ACCESS', actionLabel: 'Granted a role' })
    // The ids in the payload arrive as the names a person recognizes.
    expect(node?.summary).toBe(`Gave ${holder.userId}@example.test the role CASEWORKER directly`)
    expect(node?.details).toEqual([
      {
        key: 'subjectUserId', label: 'Person', kind: 'USER', value: holder.userId,
        reference: { id: holder.userId, label: `${holder.userId}@example.test`, exists: true },
      },
      { key: 'role', label: 'Role', kind: 'ROLE', value: 'CASEWORKER', reference: { id: 'CASEWORKER', label: 'CASEWORKER', exists: true } },
      { key: 'via', label: 'How', kind: 'ENUM', value: 'DIRECT', reference: null },
      { key: 'reason', label: 'Reason', kind: 'REASON', value: 'Joined the desk.', reference: null },
    ])
    expect(JSON.parse(node!.payloadJson!)).toMatchObject({ role: 'CASEWORKER', via: 'DIRECT' })
  })

  it('shows an entry recorded before actions declared their details exactly as stored', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const id = await recordEvent({ action: 'SEB.DECISION_RECORDED', entityType: 'SEB_PROGRAMME_DECISION' })
    const node = (await events('first: 5', 'actions: ["SEB.DECISION_RECORDED"]', reader.cookie))
      .data?.audit.events.response?.nodes.find((one) => one.id === id)
    // Not restated in the new shape: the history does not edit itself.
    expect(node).toMatchObject({ detailed: false, summary: node?.actionLabel, payloadJson: '{"note":"fixture"}' })
    expect(node?.details).toEqual([{ key: 'note', label: 'Note', kind: 'TEXT', value: 'fixture', reference: null }])
  })

  it('names a record that no longer exists as unknown, and does not link to it', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const gone = crypto.randomUUID()
    const id = await recordEvent({ applicationId: gone, payload: { referenceNumber: 'SEB-X', version: 2 } })
    const node = (await events('first: 5', `applicationId: "${gone}"`, reader.cookie))
      .data?.audit.events.response?.nodes.find((one) => one.id === id)
    expect(node?.application).toEqual({ id: gone, label: null, exists: false })
  })
})

type DetailResult = {
  audit: {
    event: {
      success: boolean
      message: string | null
      response: { event: { id: string }; sameRequest: { id: string }[] } | null
    }
  }
}

const entry = (id: string, cookie?: string) =>
  graphql<DetailResult>(
    `query { audit { event(id: "${id}") { success message response { event { id } sameRequest { id } } } } }`,
    cookie,
  )

describe('one entry', () => {
  it('comes with the other entries its request produced, and only nearby ones', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const now = Date.now()
    const asked = await recordEvent({ requestId: 'ray-shared', createdAt: now })
    const sibling = await recordEvent({ requestId: 'ray-shared', createdAt: now + 1_000 })
    // The same request id an hour later is somebody repeating a header, not
    // the same request.
    await recordEvent({ requestId: 'ray-shared', createdAt: now + 3_600_000 })
    await recordEvent({ requestId: 'ray-other', createdAt: now })

    const result = await entry(asked, reader.cookie)
    expect(result.data?.audit.event.response?.event.id).toBe(asked)
    expect(result.data?.audit.event.response?.sameRequest.map((one) => one.id)).toEqual([sibling])
  })

  it('has no siblings when it recorded no request, and is refused to a non-reader', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const lone = await recordEvent({ requestId: null })
    await recordEvent({ requestId: null })
    expect((await entry(lone, reader.cookie)).data?.audit.event.response?.sameRequest).toEqual([])
    expect((await entry(crypto.randomUUID(), reader.cookie)).data?.audit.event)
      .toMatchObject({ success: false, message: 'That entry was not found.' })
    expect((await entry('x'.repeat(200), reader.cookie)).data?.audit.event)
      .toMatchObject({ success: false, response: null })
    const caller = await sessionHolding(['CASEWORKER'])
    expect((await entry(lone, caller.cookie)).data?.audit.event)
      .toMatchObject({ success: false, response: null })
  })
})

describe('the person filter', () => {
  type PeopleResult = { audit: { people: { success: boolean; message: string | null; response: Person[] | null } } }
  const people = (input: string, cookie?: string) =>
    graphql<PeopleResult>(`query { audit { people(input: { ${input} }) { success message response { id email roles } } } }`, cookie)

  it('finds one person by whole address, and names ids already chosen', async () => {
    const reader = await sessionHolding(['HISTORY_READER'], [['audit', 'read']])
    const somebody = await sessionHolding(['CASEWORKER'])
    const email = `${somebody.userId}@example.test`
    expect((await people(`email: "  ${email.toUpperCase()} "`, reader.cookie)).data?.audit.people.response)
      .toEqual([{ id: somebody.userId, email, roles: ['CASEWORKER'] }])
    // No partial match, so the filter cannot be used to list accounts.
    expect((await people(`email: "${email.slice(0, 10)}"`, reader.cookie)).data?.audit.people.success).toBe(false)
    expect((await people(`ids: ["${somebody.userId}"]`, reader.cookie)).data?.audit.people.response?.[0]?.email)
      .toBe(email)
    // Somebody holding nothing any more is still findable, with no roles.
    await env.DB.prepare(
      `UPDATE core_user_role_grant SET revoked_at = ?, revocation_reason = 'TEST' WHERE user_id = ?`,
    ).bind(Date.now(), somebody.userId).run()
    expect((await people(`ids: ["${somebody.userId}"]`, reader.cookie)).data?.audit.people.response?.[0]?.roles)
      .toEqual([])
  })

  it('takes exactly one kind of question, and only from a reader', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    expect((await people(`email: "a@b.in", ids: ["${crypto.randomUUID()}"]`, reader.cookie)).data?.audit.people.success)
      .toBe(false)
    expect((await people('ids: []', reader.cookie)).data?.audit.people.success).toBe(false)
    expect((await people('ids: ["not-an-id"]', reader.cookie)).data?.audit.people.success).toBe(false)
    const caller = await sessionHolding(['CASEWORKER'])
    expect((await people('email: "a@b.in"', caller.cookie)).data?.audit.people)
      .toMatchObject({ success: false, response: null })
  })
})

describe('taking a copy', () => {
  type ExportResult = {
    audit: {
      exportEvents: {
        success: boolean
        message: string | null
        response: { filename: string; csv: string; rowCount: number; truncated: boolean } | null
      }
    }
  }
  const exportEvents = (input: string, cookie?: string) =>
    graphql<ExportResult>(
      `mutation { audit { exportEvents(input: { ${input} }) { success message response { filename csv rowCount truncated } } } }`,
      cookie,
    )

  it('needs both the read and the export permission', async () => {
    for (const permissions of [[['audit', 'read']], [['audit', 'export']]] as [string, string][][]) {
      const caller = await sessionHolding([`ROLE_${crypto.randomUUID().slice(0, 6).toUpperCase()}`], permissions)
      expect((await exportEvents('purpose: "Review"', caller.cookie)).data?.audit.exportEvents, JSON.stringify(permissions))
        .toMatchObject({ success: false, response: null })
    }
    const exporter = await sessionHolding(['HISTORY_EXPORTER'], [['audit', 'read'], ['audit', 'export']])
    expect((await exportEvents('purpose: "Review"', exporter.cookie)).data?.audit.exportEvents.success).toBe(true)
  })

  it('refuses to export without a reason, or with a filter the page would refuse', async () => {
    const exporter = await sessionHolding(['SUPER_ADMIN'])
    expect((await exportEvents('purpose: "   "', exporter.cookie)).data?.audit.exportEvents)
      .toMatchObject({ success: false, message: 'Say why this history is being exported.' })
    expect((await exportEvents('purpose: "Review", filter: { applicationId: "nope" }', exporter.cookie))
      .data?.audit.exportEvents).toMatchObject({ success: false, response: null })
    // Refused before anything is recorded: a refusal is not an export.
    const recorded = await activeDatabase().execute(sql`SELECT 1 FROM core_audit_event WHERE action = 'AUDIT.EXPORTED'`)
    expect(recorded.rows).toHaveLength(0)
  })

  it('records a dated filter as the instants it used', async () => {
    const exporter = await sessionHolding(['SUPER_ADMIN'])
    await exportEvents('purpose: "Audit", filter: { from: "2026-01-01T00:00:00.000Z", outcome: FAILURE }', exporter.cookie)
    const recorded = await activeDatabase().execute<{ payload: { filters: Record<string, unknown> } }>(sql`
      SELECT payload FROM core_audit_event WHERE action = 'AUDIT.EXPORTED'`)
    expect(recorded.rows[0]?.payload.filters).toEqual({ from: '2026-01-01T00:00:00.000Z', outcome: 'FAILURE' })
  })

  it('writes the filtered rows, neutralizes formulas, and records that it did', async () => {
    const exporter = await sessionHolding(['SUPER_ADMIN'])
    const action = `AUDIT.EXPORTED_ROWS_${crypto.randomUUID().slice(0, 6)}`
    await recordEvent({ action, userAgent: '=HYPERLINK("https://evil.example","open")' })
    await recordEvent({ action })

    const result = await exportEvents(`filter: { actions: ["${action}"] }, purpose: "Quarterly review"`, exporter.cookie)
    const file = result.data?.audit.exportEvents.response
    expect(file).toMatchObject({ rowCount: 2, truncated: false })
    const lines = file!.csv.trimEnd().split('\r\n')
    expect(lines[0]).toMatch(/^id,created_at,category,action,/u)
    expect(lines).toHaveLength(3)
    // A cell a spreadsheet would run is made text.
    expect(file!.csv).toContain(`"'=HYPERLINK(""https://evil.example"",""open"")"`)
    expect(file!.csv).not.toMatch(/,=HYPERLINK/u)

    const recorded = await activeDatabase().execute<{ actor_user_id: string; payload: Record<string, unknown> }>(sql`
      SELECT actor_user_id, payload FROM core_audit_event WHERE action = 'AUDIT.EXPORTED'`)
    expect(recorded.rows).toHaveLength(1)
    expect(recorded.rows[0]).toMatchObject({
      actor_user_id: exporter.userId,
      payload: { purpose: 'Quarterly review', filters: { actions: [action] }, rowCount: 2, truncated: false, format: 'CSV' },
    })
  })
})

describe('what reading the history costs', () => {
  /*
   * Plans, not durations: a timing test on a small fixture passes whether or
   * not an index is used. **Seeded first, and that is the whole test.**
   * Postgres sequentially scans a small table whatever indexes exist, so a plan
   * taken against a handful of rows says nothing — a hundred thousand rows and
   * an `ANALYZE` are what make the planner's choice meaningful.
   */
  const SUBJECT = '00000000-0000-4000-8000-00000000000a'
  const APPLICATION = '00000000-0000-4000-8000-00000000000b'

  const seedHistory = async () => {
    // Two hundred actors, named arithmetically so the seed needs no array
    // parameter, and one subject every fiftieth event is about.
    await activeDatabase().execute(sql`
      INSERT INTO core_user (id, email, password_hash, email_verified_at, row_version, created_at, updated_at)
      SELECT id, id || '@example.test', 'unused', now(), 1, now(), now()
        FROM (SELECT '00000000-0000-4000-8000-' || lpad((1000 + n)::text, 12, '0') AS id
                FROM generate_series(0, 199) AS n
              UNION ALL SELECT ${SUBJECT}) AS people`)
    await activeDatabase().execute(sql`
      INSERT INTO core_audit_event
        (id, actor_user_id, action, entity_type, entity_id, outcome, created_at,
         subject_user_id, application_id, payload_version)
      SELECT gen_random_uuid()::text,
             '00000000-0000-4000-8000-' || lpad((1000 + g % 200)::text, 12, '0'),
             (ARRAY['SEB.CYCLE_OPENED','SEB.APPLICATION_SAVED','RBAC.ROLE_GRANTED','AUTH.SIGN_IN_SUCCEEDED',
                    'SEB.DECISION_RECORDED','SEB.RELEASE_RECORDED','SEB.DOCUMENT_FINALIZED'])[1 + g % 7],
             'T', gen_random_uuid()::text, 'SUCCESS',
             now() - (g || ' seconds')::interval,
             CASE WHEN g % 50 = 0 THEN ${SUBJECT} END,
             CASE WHEN g % 20 = 0 THEN ${APPLICATION}
                  WHEN g % 3 = 0 THEN gen_random_uuid()::text END,
             0
      FROM generate_series(1, 100000) AS g`)
    await activeDatabase().execute(sql`ANALYZE core_audit_event`)
  }

  const planOf = async (query: ReturnType<typeof sql>) => {
    const plan = await activeDatabase().execute(sql`EXPLAIN (FORMAT TEXT) ${query}`)
    return plan.rows.map((row) => Object.values(row)[0]).join(' | ')
  }

  it('seeks an index for every common view, and never sorts the whole table', async () => {
    await seedHistory()
    const page = sql`ORDER BY created_at DESC, id DESC LIMIT 51`

    // The unfiltered view: walked backwards along (created_at, id), stopping at 51.
    const unfiltered = await planOf(sql`SELECT id FROM core_audit_event ${page}`)
    expect(unfiltered).toContain('core_audit_event_created_idx')
    expect(unfiltered).not.toContain('Seq Scan')
    expect(unfiltered).not.toContain('Sort')

    // One application's history, and what was done to one person: each its
    // own partial index, already in cursor order.
    const application = await planOf(sql`SELECT id FROM core_audit_event WHERE application_id = ${APPLICATION} ${page}`)
    expect(application).toContain('core_audit_event_application_idx')
    expect(application).not.toContain('Seq Scan')
    const subject = await planOf(sql`SELECT id FROM core_audit_event WHERE subject_user_id = ${SUBJECT} ${page}`)
    expect(subject).toContain('core_audit_event_subject_idx')
    expect(subject).not.toContain('Seq Scan')

    /*
     * One person's whole history. Two good plans exist and the planner picks
     * by how common the person is: for somebody in a few percent of rows it
     * walks the created index backwards and stops at 51 matches; for a rare
     * person it combines the actor and subject indexes. Either is a seek. The
     * outcome that must never happen is reading the whole table.
     */
    const involving = await planOf(sql`
      SELECT id FROM core_audit_event
       WHERE actor_user_id = ${SUBJECT} OR subject_user_id = ${SUBJECT} ${page}`)
    expect(involving).toMatch(/core_audit_event_(created|subject)_idx/u)
    expect(involving).not.toContain('Seq Scan')

    // A category is a list of actions: seeks the action index.
    const category = await planOf(sql`
      SELECT id FROM core_audit_event
       WHERE action IN ('SEB.RELEASE_RECORDED', 'SEB.AWARD_CREATED', 'SEB.ASSESSMENT_RECORDED') ${page}`)
    expect(category).not.toContain('Seq Scan')
  })

  it('lists the recorded actions with one probe per name, not a pass over every row', async () => {
    await seedHistory()
    const plan = await planOf(sql`
      WITH RECURSIVE recorded(action) AS (
        (SELECT action FROM core_audit_event ORDER BY action LIMIT 1)
        UNION ALL
        SELECT (SELECT next_row.action FROM core_audit_event AS next_row
                 WHERE next_row.action > recorded.action ORDER BY next_row.action LIMIT 1)
          FROM recorded WHERE recorded.action IS NOT NULL)
      SELECT action FROM recorded WHERE action IS NOT NULL LIMIT 500`)
    expect(plan).toContain('core_audit_event_action_idx')
    expect(plan).not.toContain('Seq Scan')
  })

  it('costs the same number of statements for one row as for fifty', async () => {
    const reader = await sessionHolding(['SUPER_ADMIN'])
    const holder = await sessionHolding(['CASEWORKER'])
    for (let index = 0; index < 50; index += 1) {
      await recordEvent({
        action: 'RBAC.ROLE_GRANTED',
        entityType: 'CORE_USER_ROLE_GRANT',
        actorUserId: reader.userId,
        subjectUserId: holder.userId,
        applicationId: crypto.randomUUID(),
        payload: { subjectUserId: holder.userId, role: 'CASEWORKER', via: 'DIRECT' },
      })
    }
    const trips = countRoundTrips(activeDriverHandle() as never)
    trips.reset()
    await events('first: 1', 'actions: ["RBAC.ROLE_GRANTED"]', reader.cookie)
    const forOne = trips.count()
    trips.reset()
    const fifty = await events('first: 50', 'actions: ["RBAC.ROLE_GRANTED"]', reader.cookie)
    expect(fifty.data?.audit.events.response?.nodes).toHaveLength(50)
    /*
     * Fifty people, fifty applications and fifty roles to name, and not one
     * more statement than a single row: the rows, the total and one folded
     * read of every name, whatever the page holds.
     */
    expect(trips.count(), trips.statements().join('\n')).toBe(forOne)
  })
})
