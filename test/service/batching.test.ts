/**
 * What a read costs, and what a transition guarantees.
 *
 * ## The file this replaces measured a database that is gone
 *
 * It asserted D1's `db.batch` trap — results read back by column name while an
 * awaited query mapped positionally, so a join of two tables that both have
 * `id` came back silently shifted. And it carried measurements (232s to 145s,
 * 5.0s to 34.7s) taken against a binding co-located with the isolate.
 *
 * None of that survives. `batch` now awaits statements in order through Drizzle,
 * so results map exactly as they do outside one, and the cost model is a network
 * hop per statement rather than a call per binding invocation. The numbers are
 * therefore **not carried across** — a bound copied without re-measuring is
 * folklore — but the rule they existed for is, and it is the reason this file
 * still exists: *measure, do not reason*. A fan-out that reads as one query and
 * issues twelve is invisible in the code and obvious here.
 */
import { count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { batch } from '../../src/db'
import { coreAuditEvent, coreUser } from '../../src/db/schema'
import { env } from '../support/worker'
import {
  activeDriverHandle,
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { countRoundTrips } from '../support/round-trips'

beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})

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

const where = eq(coreAuditEvent.action, 'BATCH.PROBE')

describe('what a transition costs', () => {
  it('is one round trip per statement, and two for the transaction', async () => {
    await seed()
    const db = activeDatabase()
    const trips = countRoundTrips(activeDriverHandle() as never)
    trips.reset()

    await batch(db, (tx) => [
      tx.select().from(coreAuditEvent).where(where),
      tx.select({ value: count() }).from(coreAuditEvent).where(where),
    ])

    /*
     * Two, not four. `BEGIN` and `COMMIT` are real hops and are deliberately
     * not counted — see `countRoundTrips`. What this asserts is that a
     * transition costs one hop per statement and adds nothing per statement of
     * its own: no per-row read, no re-read to confirm.
     */
    expect(trips.count(), trips.statements().join('\n')).toBe(2)
  })

  it('reads back exactly as the same statements do outside a transition', async () => {
    /*
     * The D1 trap, asserted to be gone rather than assumed.
     *
     * `core_audit_event.id` and `core_user.id` are both `id`. Under D1's batch
     * they collided, every value moved one place left, and nothing threw — which
     * is why `loadWorkspace` had to keep its joined reads out of its batch. That
     * constraint no longer applies, and this is what says so.
     */
    const { userId, eventId } = await seed()
    const db = activeDatabase()
    const joined = db
      .select({ id: coreAuditEvent.id, actorId: coreUser.id, email: coreUser.email })
      .from(coreAuditEvent)
      .leftJoin(coreUser, eq(coreUser.id, coreAuditEvent.actorUserId))
      .where(where)

    const direct = await joined
    expect(direct).toEqual([
      { id: eventId, actorId: userId, email: `${userId}@example.test` },
    ])

    const [batched] = await batch(db, (tx) =>
      [
        tx
          .select({ id: coreAuditEvent.id, actorId: coreUser.id, email: coreUser.email })
          .from(coreAuditEvent)
          .leftJoin(coreUser, eq(coreUser.id, coreAuditEvent.actorUserId))
          .where(where),
      ] as const,
    )
    expect(batched).toEqual(direct)
  })
})

describe('what a transition guarantees', () => {
  it('writes nothing at all when one statement fails', async () => {
    const db = activeDatabase()
    const id = crypto.randomUUID()
    await expect(
      batch(db, (tx) => [
        tx.insert(coreAuditEvent).values({
          id,
          actorUserId: null,
          action: 'BATCH.ROLLBACK',
          entityType: 'T',
          entityId: 'e',
          outcome: 'SUCCESS',
          createdAt: new Date(),
        }),
        // The same primary key: refused, and the first must not survive it.
        tx.insert(coreAuditEvent).values({
          id,
          actorUserId: null,
          action: 'BATCH.ROLLBACK',
          entityType: 'T',
          entityId: 'e',
          outcome: 'SUCCESS',
          createdAt: new Date(),
        }),
      ]),
    ).rejects.toThrow()

    const [remaining] = await db
      .select({ value: count() })
      .from(coreAuditEvent)
      .where(eq(coreAuditEvent.action, 'BATCH.ROLLBACK'))
    expect(remaining?.value).toBe(0)
  })

  /*
   * The hazard that came with running the transition on the caller's own
   * connection.
   *
   * A connection has one transaction. Two transitions issued concurrently on
   * the same handle would interleave their `BEGIN`s — the second finds one
   * already open, its statements join the first's, and a rollback in either
   * takes both down. Nothing throws; the writes are simply not the transitions
   * they were written as. `batch` serialises for that reason, and this is what
   * says the serialisation is real.
   */
  it('does not let two concurrent transitions interleave', async () => {
    const db = activeDatabase()
    const insert = (action: string, fail: boolean) =>
      batch(db, (tx) => [
        tx.insert(coreAuditEvent).values({
          id: crypto.randomUUID(),
          actorUserId: null,
          action,
          entityType: 'T',
          entityId: 'e',
          outcome: 'SUCCESS',
          createdAt: new Date(),
        }),
        ...(fail
          ? [tx.execute(sql`SELECT 1 / 0`)]
          : []),
      ])

    const results = await Promise.allSettled([
      insert('BATCH.KEPT', false),
      insert('BATCH.LOST', true),
      insert('BATCH.KEPT', false),
    ])
    expect(results.map((each) => each.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])

    // The failing transition took only its own row down. Interleaved, its
    // rollback would have taken the others with it.
    const [kept] = await db
      .select({ value: count() })
      .from(coreAuditEvent)
      .where(eq(coreAuditEvent.action, 'BATCH.KEPT'))
    expect(kept?.value).toBe(2)
    const [lost] = await db
      .select({ value: count() })
      .from(coreAuditEvent)
      .where(eq(coreAuditEvent.action, 'BATCH.LOST'))
    expect(lost?.value).toBe(0)
  })
})
