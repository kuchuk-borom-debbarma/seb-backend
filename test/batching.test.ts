/**
 * How reads are batched: which ones may be, and which ones should be.
 *
 * In Workers each Drizzle call is its own D1 binding call, so `Promise.all`
 * makes reads concurrent rather than fewer. `db.batch` makes them one call.
 *
 * Two things about that are not obvious, and both were found by measuring
 * rather than by reasoning:
 *
 * **Which statements *may* be batched.** A batch is read back by column name
 * while an awaited query maps positionally, so a statement whose output has
 * two columns of the same name — every join of two tables that both have `id`
 * — comes back with its values silently shifted. Asserted below.
 *
 * **Which statements *should* be.** Fewer calls is not automatically faster.
 * Batching the administrative workspace's twelve collection reads took the
 * journey test from 5.0s to 34.7s — seven times slower for four fewer calls,
 * because a batch is a transaction and its whole combined result is
 * materialised at once. Batching the small fan-outs elsewhere took the suite
 * from 232s to 145s.
 *
 * So the rule is about size, not count: batch a handful of small reads, never
 * a pile of large collections.
 */
import { env } from 'cloudflare:test'
import { count, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../src/db'
import { counting } from './counting-db'
import { coreAuditEvent, coreUser } from '../src/db/schema'

const seed = async () => {
  const userId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_user (id, email, password_hash, email_verified_at,
        row_version, created_at, updated_at) VALUES (?, ?, 'x', ?, 1, ?, ?)`,
    ).bind(userId, `${userId}@example.test`, now, now, now),
    env.DB.prepare(
      `INSERT INTO core_audit_event (id, actor_user_id, action, entity_type,
        entity_id, outcome, created_at)
       VALUES (?, ?, 'BATCH.PROBE', 'T', 'e', 'SUCCESS', ?)`,
    ).bind(eventId, userId, now),
  ])
  return { userId, eventId }
}

describe('what may be batched', () => {
  const where = eq(coreAuditEvent.action, 'BATCH.PROBE')

  it('maps a single-table read and an aggregate identically', async () => {
    await seed()
    const db = createDatabase(env.DB)
    const rows = db.select().from(coreAuditEvent).where(where)
    const total = db.select({ value: count() }).from(coreAuditEvent).where(where)

    const [batchedRows, batchedTotal] = await db.batch([rows, total])
    expect(batchedRows).toEqual(await rows)
    expect(batchedTotal).toEqual(await total)
  })

  it('SHIFTS THE VALUES of a join whose columns share a name', async () => {
    /*
     * The trap, asserted rather than described.
     *
     * `db.batch` reads results back by column name; an awaited query maps them
     * positionally. `core_audit_event.id` and `core_user.id` are both `id`, so
     * batched they collide — every value moves one place left and the last is
     * dropped. Nothing throws, and the object still has the right shape.
     *
     * This is why `loadWorkspace` keeps its four joined reads out of its batch,
     * and why anything joined must be aliased before it goes near one.
     */
    const { userId, eventId } = await seed()
    const db = createDatabase(env.DB)
    const joined = db
      .select({ id: coreAuditEvent.id, actorId: coreUser.id, email: coreUser.email })
      .from(coreAuditEvent)
      .leftJoin(coreUser, eq(coreUser.id, coreAuditEvent.actorUserId))
      .where(where)

    expect(await joined).toEqual([
      { id: eventId, actorId: userId, email: `${userId}@example.test` },
    ])

    const [batched] = await db.batch([joined])
    // Wrong, and quietly so: `id` now holds the actor's id.
    expect(batched).not.toEqual(await joined)
    expect((batched as Array<{ id: string }>)[0]!.id).toBe(userId)
  })

  it('maps a join correctly once every column is uniquely named', async () => {
    // The escape hatch, if a joined read ever has to be batched: alias the
    // colliding columns so no two share an output name.
    const { userId, eventId } = await seed()
    const db = createDatabase(env.DB)
    const aliased = db
      .select({
        id: coreAuditEvent.id,
        actorId: sql<string>`${coreUser.id}`.as('actor_id'),
        actorEmail: sql<string>`${coreUser.email}`.as('actor_email'),
      })
      .from(coreAuditEvent)
      .leftJoin(coreUser, eq(coreUser.id, coreAuditEvent.actorUserId))
      .where(where)

    const [batched] = await db.batch([aliased])
    expect(batched).toEqual(await aliased)
    expect((batched as Array<{ id: string; actorId: string }>)[0])
      .toMatchObject({ id: eventId, actorId: userId })
  })
})

describe('what a read costs', () => {
  const where = eq(coreAuditEvent.action, 'BATCH.PROBE')

  it('spends one binding call for a batch, not one per statement', async () => {
    /*
     * The claim that batching reduces round trips, measured rather than
     * asserted. A number in a commit message that nothing checks is a number
     * that stops being true.
     */
    await seed()
    const { database, calls } = counting(env.DB)
    const db = createDatabase(database)
    const one = () => db.select().from(coreAuditEvent).where(where)

    const before = calls()
    await Promise.all([one(), one(), one(), one()])
    const concurrent = calls() - before
    await db.batch([one(), one(), one(), one()])
    const batched = calls() - before - concurrent

    expect(concurrent).toBe(4)
    expect(batched).toBe(1)
  })
})
