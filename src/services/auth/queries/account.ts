/**
 * Drizzle queries for the things a person can change about their own account:
 * a forgotten password, a chosen password, their address, and their name.
 *
 * Separate from `auth.ts` for the reason `access.ts` is: that file is about
 * becoming authenticated, this one is about editing an identity that already
 * exists. They share the challenge mechanism and nothing else.
 *
 * Every mutation here follows the same shape as the signup claim — one
 * `db.batch`, which is one D1 transaction, with the audit row inserted by
 * `insertAuditEventWhere` so it lands only if the change did. A credential
 * check happens outside D1 and is slow, so the guarded write repeats its
 * conditions at write time rather than trusting what was read.
 */
import { and, eq, exists, gt, isNull, lte, ne, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { batch, type Database, type Transaction } from '../../../db'
import { constraintSafe } from '../../constraints'
import {
  coreAccountChallenge,
  coreAuditEvent,
  coreSession,
  coreUser,
  type AccountChallengePurpose,
} from '../../../db/schema'
import {
  hasActiveRoleGrant,
  insertAuditEventWhere,
  type AuditEventRecord,
} from './auth'

export type AccountChallengeRecord = typeof coreAccountChallenge.$inferSelect

/*
 * Whether the guarded statement actually changed its one row.
 *
 * Compared directly rather than through a `?? 0` fallback: D1 always reports a
 * count, so the fallback would be a branch no test could ever reach, and an
 * unreachable branch in gated code is a permanent hole in the coverage that
 * proves the rest.
 */
/**
 * Whether a guarded write moved exactly the one row it claimed.
 *
 * Zero means somebody else acted first. More than one would mean the predicate
 * was not specific to a single row, which is a bug rather than a race.
 */
const changedOne = (result: { rowCount: number | null }): boolean => result.rowCount === 1

/**
 * Records a challenge, but only for an account that could actually use it.
 *
 * The predicate is the enumeration defence: an address that names nobody, a
 * deleted account, or one with no active role grant inserts nothing, and the
 * controller answers exactly as it would have anyway. A person who cannot sign
 * in is not sent a code to reach a door that stays shut.
 *
 * Returns whether a row was written, which is also whether a message should be
 * sent — the two must not be decided separately.
 */
export const createAccountChallenge = async (
  db: Database,
  challenge: typeof coreAccountChallenge.$inferInsert,
  auditEvent: AuditEventRecord,
): Promise<boolean> => {
  const insertChallenge = db
    .insert(coreAccountChallenge)
    .select(
      sql`
        SELECT
          ${challenge.id},
          ${challenge.purpose},
          ${challenge.userId},
          ${challenge.email},
          ${challenge.challengeDigest},
          ${challenge.otpDigest},
          ${challenge.attemptsRemaining},
          ${challenge.expiresAt},
          ${challenge.status ?? 'PENDING'},
          NULL,
          NULL,
          NULL,
          ${challenge.createdAt},
          ${challenge.updatedAt}
        WHERE ${exists(
          db
            .select({ id: coreUser.id })
            .from(coreUser)
            .where(
              and(
                eq(coreUser.id, challenge.userId),
                isNull(coreUser.deletedAt),
                hasActiveRoleGrant(db, coreUser.id),
              ),
            ),
        )}
      `,
    )

  const insertAudit = insertAuditEventWhere(
    db,
    auditEvent,
    exists(
      db
        .select({ id: coreAccountChallenge.id })
        .from(coreAccountChallenge)
        .where(eq(coreAccountChallenge.id, challenge.id)),
    ),
  )

  const [inserted] = await batch(db, (tx) => [insertChallenge, insertAudit])
  return changedOne(inserted)
}

/**
 * Supersedes an account's outstanding challenges for one purpose.
 *
 * Asking again should not leave the previous code working: two live codes for
 * one account double the guessing surface for no benefit, and a person who
 * asked twice is reading the newer message.
 */
export const supersedeAccountChallenges = (
  db: Database,
  userId: string,
  purpose: AccountChallengePurpose,
  now: Date,
) =>
  db
    .update(coreAccountChallenge)
    .set({
      status: 'CANCELLED',
      invalidatedAt: now,
      invalidationReason: 'SUPERSEDED_BY_NEWER_REQUEST',
      updatedAt: now,
    })
    .where(
      and(
        eq(coreAccountChallenge.userId, userId),
        eq(coreAccountChallenge.purpose, purpose),
        eq(coreAccountChallenge.status, 'PENDING'),
      ),
    )

/**
 * The one live challenge a token identifies, or null.
 *
 * Purpose is part of the lookup, not a property of what was found: a reset code
 * must be unusable against an email change even if somebody holds both.
 */
export const findActiveAccountChallenge = async (
  db: Database,
  purpose: AccountChallengePurpose,
  challengeDigest: string,
  now: Date,
): Promise<AccountChallengeRecord | null> => {
  const [record] = await db
    .select()
    .from(coreAccountChallenge)
    .where(
      and(
        eq(coreAccountChallenge.challengeDigest, challengeDigest),
        eq(coreAccountChallenge.purpose, purpose),
        eq(coreAccountChallenge.status, 'PENDING'),
        gt(coreAccountChallenge.attemptsRemaining, 0),
        gt(coreAccountChallenge.expiresAt, now),
      ),
    )
    .limit(1)
  return record ?? null
}

/**
 * Spends one wrong guess, exhausting the challenge when it was the last.
 *
 * Two guarded updates rather than a read and a write, for the reason the signup
 * flow gives: only this challenge's counter moves, and a concurrent attempt
 * cannot make the pair skip past zero.
 */
export const consumeWrongAccountOtpAttempt = async (
  db: Database,
  challengeId: string,
  now: Date,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  const exhaust = db
    .update(coreAccountChallenge)
    .set({
      attemptsRemaining: 0,
      status: 'EXHAUSTED',
      invalidatedAt: now,
      invalidationReason: 'OTP_ATTEMPTS_EXHAUSTED',
      updatedAt: now,
    })
    .where(
      and(
        eq(coreAccountChallenge.id, challengeId),
        eq(coreAccountChallenge.status, 'PENDING'),
        gt(coreAccountChallenge.expiresAt, now),
        gt(coreAccountChallenge.attemptsRemaining, 0),
        lte(coreAccountChallenge.attemptsRemaining, 1),
      ),
    )

  const decrement = db
    .update(coreAccountChallenge)
    .set({
      attemptsRemaining: sql`${coreAccountChallenge.attemptsRemaining} - 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(coreAccountChallenge.id, challengeId),
        eq(coreAccountChallenge.status, 'PENDING'),
        gt(coreAccountChallenge.expiresAt, now),
        gt(coreAccountChallenge.attemptsRemaining, 1),
      ),
    )

  await batch(db, (tx) => [exhaust, decrement, tx.insert(coreAuditEvent).values(auditEvent)])
}

/** Marks an undeliverable challenge unusable without erasing its history. */
export const markAccountChallengeDeliveryFailed = async (
  db: Database,
  challengeId: string,
  now: Date,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  await batch(db, (tx) => [
    db
      .update(coreAccountChallenge)
      .set({
        status: 'DELIVERY_FAILED',
        invalidatedAt: now,
        invalidationReason: 'NOTIFICATION_DELIVERY_FAILED',
        updatedAt: now,
      })
      .where(
        and(
          eq(coreAccountChallenge.id, challengeId),
          eq(coreAccountChallenge.status, 'PENDING'),
        ),
      ),
    tx.insert(coreAuditEvent).values(auditEvent),
  ])
}

/**
 * Sets a new password against a proved challenge, and ends every session.
 *
 * The challenge is consumed in the same batch as the password write and the
 * whole predicate is repeated in SQL, so a challenge exhausted while scrypt was
 * running cannot still produce a password change.
 *
 * **Every session goes, including the one asking.** A forgotten password is
 * indistinguishable from a stolen one, and the safe reading of "I could not get
 * in" is that somebody else could.
 */
export const applyPasswordReset = async (
  db: Database,
  input: {
    challengeId: string
    userId: string
    passwordHash: string
    now: Date
    auditEvent: AuditEventRecord
  },
): Promise<boolean> => {
  const live = and(
    eq(coreAccountChallenge.id, input.challengeId),
    eq(coreAccountChallenge.status, 'PENDING'),
    gt(coreAccountChallenge.expiresAt, input.now),
    gt(coreAccountChallenge.attemptsRemaining, 0),
  )

  const consume = db
    .update(coreAccountChallenge)
    .set({ status: 'CONSUMED', consumedAt: input.now, updatedAt: input.now })
    .where(live)

  const stillConsumed = exists(
    db
      .select({ id: coreAccountChallenge.id })
      .from(coreAccountChallenge)
      .where(
        and(
          eq(coreAccountChallenge.id, input.challengeId),
          eq(coreAccountChallenge.status, 'CONSUMED'),
          eq(coreAccountChallenge.consumedAt, input.now),
        ),
      ),
  )

  const setPassword = db
    .update(coreUser)
    .set({
      passwordHash: input.passwordHash,
      rowVersion: sql`${coreUser.rowVersion} + 1`,
      updatedAt: input.now,
    })
    .where(and(
      eq(coreUser.id, input.userId),
      /*
       * A closed account does not get new credentials.
       *
       * The reset is refused at the start for a deleted account, so this is
       * about the window between: a code goes out, the office closes the
       * account, and the code comes back. Without this the write happily set a
       * working password on it. Nothing could sign in with it today, but that
       * is a property of a *different* check — and this write is the one that
       * has to be authoritative about who it is writing for.
       */
      isNull(coreUser.deletedAt),
      stillConsumed,
    ))

  const [, updated] = await batch(db, (tx) => [
    consume,
    setPassword,
    tx.delete(coreSession).where(and(eq(coreSession.userId, input.userId), stillConsumed)),
    insertAuditEventWhere(tx, input.auditEvent, stillConsumed),
  ])
  // Whether the password changed, not whether the code was spent — the two
  // stopped being the same thing the moment the write gained a term of its own.
  return changedOne(updated)
}

/**
 * Changes the password of somebody who is signed in and proved the old one.
 *
 * Guarded on the hash that was verified, so a password changed by another
 * session while scrypt ran defeats this write rather than overwriting it.
 * Other sessions end; the one asking stays, because the person is holding it.
 */
export const applyPasswordChange = async (
  db: Database,
  input: {
    userId: string
    verifiedPasswordHash: string
    passwordHash: string
    currentSessionId: string
    now: Date
    auditEvent: AuditEventRecord
  },
): Promise<boolean> => {
  const guard = and(
    eq(coreUser.id, input.userId),
    eq(coreUser.passwordHash, input.verifiedPasswordHash),
    isNull(coreUser.deletedAt),
  )

  const setPassword = db
    .update(coreUser)
    .set({
      passwordHash: input.passwordHash,
      rowVersion: sql`${coreUser.rowVersion} + 1`,
      updatedAt: input.now,
    })
    .where(guard)

  const changed = exists(
    db
      .select({ id: coreUser.id })
      .from(coreUser)
      .where(and(eq(coreUser.id, input.userId), eq(coreUser.passwordHash, input.passwordHash))),
  )

  const [updated] = await batch(db, (tx) => [
    setPassword,
    db
      .delete(coreSession)
      .where(
        and(
          eq(coreSession.userId, input.userId),
          ne(coreSession.id, input.currentSessionId),
          changed,
        ),
      ),
    insertAuditEventWhere(tx, input.auditEvent, changed),
  ])
  return changedOne(updated)
}

/**
 * Moves an account to an address whose control was just proved.
 *
 * The uniqueness of `core_user.email` is the last word, and it covers
 * soft-deleted rows — a released address stays reserved. So the write is
 * guarded on the address still being free at write time rather than on the
 * check that ran before the code was sent.
 */
export const applyEmailChange = async (
  db: Database,
  input: {
    challengeId: string
    userId: string
    newEmail: string
    currentSessionId: string
    now: Date
    auditEvent: AuditEventRecord
  },
): Promise<boolean> => {
  const consume = db
    .update(coreAccountChallenge)
    .set({ status: 'CONSUMED', consumedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(coreAccountChallenge.id, input.challengeId),
        eq(coreAccountChallenge.status, 'PENDING'),
        gt(coreAccountChallenge.expiresAt, input.now),
        gt(coreAccountChallenge.attemptsRemaining, 0),
      ),
    )

  const stillConsumed = exists(
    db
      .select({ id: coreAccountChallenge.id })
      .from(coreAccountChallenge)
      .where(
        and(
          eq(coreAccountChallenge.id, input.challengeId),
          eq(coreAccountChallenge.status, 'CONSUMED'),
          eq(coreAccountChallenge.consumedAt, input.now),
        ),
      ),
  )

  /*
   * The address is still free, as a term in the write rather than a read
   * before it.
   *
   * Its caller has always answered "That address is no longer available" when
   * this returns false — and this could not return false. `core_user.email` is
   * unique, so an address claimed between the code being sent and redeemed
   * made the `UPDATE` raise `23505`, uncaught, and the applicant got an
   * unhandled error in place of the sentence written for them. The refusal was
   * described but never reachable.
   *
   * Aliased for the reason the super-administrator guard is: this is a subquery
   * inside an `UPDATE` of the same table, where an unqualified self-reference
   * resolves to the row being written.
   */
  const otherUser = alias(coreUser, 'other_user')
  const addressIsFree = notExists(
    db
      .select({ id: otherUser.id })
      .from(otherUser)
      .where(and(eq(otherUser.email, input.newEmail), ne(otherUser.id, input.userId))),
  )

  const setEmail = db
    .update(coreUser)
    .set({
      email: input.newEmail,
      // The new address was proved just now; that is what verification means.
      emailVerifiedAt: input.now,
      rowVersion: sql`${coreUser.rowVersion} + 1`,
      updatedAt: input.now,
    })
    .where(and(
      eq(coreUser.id, input.userId),
      // A closed account does not get to move: the session check above reads
      // live, but a deletion landing inside this window would slip past it.
      isNull(coreUser.deletedAt),
      addressIsFree,
      stillConsumed,
    ))

  const moved = exists(
    db
      .select({ id: coreUser.id })
      .from(coreUser)
      .where(and(eq(coreUser.id, input.userId), eq(coreUser.email, input.newEmail))),
  )

  /*
   * `constraintSafe`, for the same reason the role grant and the bootstrap
   * carry it: `addressIsFree` reads rows this `UPDATE` does not write, so
   * nothing blocks and a true dead heat still reaches the unique index on
   * `core_user.email`. A concurrent signup claiming the same address — or a
   * second email change to it — commits first, this raises `23505`, and without
   * this it propagates out of `batch` as an unhandled error.
   *
   * The predicate is not redundant: it is what makes the *ordinary* late
   * request a clean refusal rather than a caught violation. The index is the
   * only thing that can decide a dead heat, because an uncommitted row is
   * invisible to any predicate.
   */
  const written = await constraintSafe(() => batch(db, (tx) => [
    consume,
    setEmail,
    db
      .delete(coreSession)
      .where(
        and(
          eq(coreSession.userId, input.userId),
          ne(coreSession.id, input.currentSessionId),
          moved,
        ),
      ),
    insertAuditEventWhere(tx, input.auditEvent, moved),
  ]))
  if (!written) return false
  const [, updated] = written
  /*
   * Whether the *address moved*, not whether the challenge was consumed.
   *
   * It reported the consumption, which was indistinguishable from the move
   * only because the move could not fail quietly — it raised `23505` instead.
   * Now that a taken address is refused by a predicate, reading the wrong
   * statement would tell the applicant their address had changed while leaving
   * them on the old one.
   *
   * The challenge is spent either way, deliberately: a code that has been
   * redeemed once must not work a second time, whatever it achieved.
   */
  return changedOne(updated)
}

/** Whether an address is already spoken for, soft-deleted accounts included. */
export const emailIsTaken = async (db: Database, email: string): Promise<boolean> => {
  const [record] = await db
    .select({ id: coreUser.id })
    .from(coreUser)
    .where(eq(coreUser.email, email))
    .limit(1)
  return record !== undefined
}

/** Records what somebody calls themselves. */
export const applyDisplayNameChange = async (
  db: Database,
  input: {
    userId: string
    displayName: string | null
    now: Date
    auditEvent: AuditEventRecord
  },
): Promise<boolean> => {
  const guard = and(eq(coreUser.id, input.userId), isNull(coreUser.deletedAt))

  const [updated] = await batch(db, (tx) => [
    db
      .update(coreUser)
      .set({
        displayName: input.displayName,
        rowVersion: sql`${coreUser.rowVersion} + 1`,
        updatedAt: input.now,
      })
      .where(guard),
    insertAuditEventWhere(
      db,
      input.auditEvent,
      exists(tx.select({ id: coreUser.id }).from(coreUser).where(guard)),
    ),
  ])
  return changedOne(updated)
}
