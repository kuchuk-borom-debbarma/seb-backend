/**
 * Drizzle queries used by authentication workflows. SQL details and D1 batch
 * boundaries stay here so controllers can express policy without weakening
 * the race guarantees of signup or session ownership checks.
 */
import { and, eq, exists, gt, isNull, lte, ne, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  coreSession,
  coreSignupChallenge,
  coreUser,
} from '../../../db/schema'

export type UserRecord = typeof coreUser.$inferSelect
export type SessionRecord = typeof coreSession.$inferSelect
export type SignupChallengeRecord = typeof coreSignupChallenge.$inferSelect
export type AuditEventRecord = typeof coreAuditEvent.$inferInsert
export type PublicUserRecord = Pick<
  UserRecord,
  'id' | 'email' | 'emailVerifiedAt' | 'role' | 'createdAt' | 'updatedAt'
>
export type PublicSessionRecord = Omit<SessionRecord, 'tokenDigest'>

const changes = (result: D1Result): number => result.meta.changes ?? 0

/** Builds a guarded audit INSERT used inside the same D1 transaction as a mutation. */
const insertAuditEventWhere = (
  db: Database,
  value: AuditEventRecord,
  predicate: SQL,
) =>
  db.insert(coreAuditEvent).select(sql`
    SELECT
      ${value.id},
      ${value.actorUserId ?? null},
      ${value.action},
      ${value.entityType},
      ${value.entityId ?? null},
      ${value.outcome},
      ${value.requestId ?? null},
      ${value.ipAddress ?? null},
      ${value.userAgent ?? null},
      ${value.changesJson ?? null},
      ${value.metadataJson ?? null},
      ${(value.createdAt as Date).getTime()}
    WHERE ${predicate}
  `)

export const createAuditEvent = async (
  db: Database,
  value: AuditEventRecord,
): Promise<void> => {
  await db.insert(coreAuditEvent).values(value)
}

/** Includes soft-deleted users so their email addresses can never be reclaimed. */
export const findUserByEmail = async (
  db: Database,
  email: string,
): Promise<UserRecord | null> => {
  const [record] = await db.select().from(coreUser).where(eq(coreUser.email, email)).limit(1)
  return record ?? null
}

/** Credential authentication only considers users that have not been deleted. */
export const findActiveUserByEmail = async (
  db: Database,
  email: string,
): Promise<UserRecord | null> => {
  const [record] = await db
    .select()
    .from(coreUser)
    .where(and(eq(coreUser.email, email), isNull(coreUser.deletedAt)))
    .limit(1)
  return record ?? null
}

/** Atomically creates one challenge only while the normalized email is unused. */
export const createSignupChallenge = async (
  db: Database,
  challenge: SignupChallengeRecord,
  auditEvent: AuditEventRecord,
): Promise<boolean> => {
  const insertChallenge = db
    .insert(coreSignupChallenge)
    .select(sql`
      SELECT
        ${challenge.id},
        ${challenge.email},
        ${challenge.challengeDigest},
        ${challenge.otpDigest},
        ${challenge.attemptsRemaining},
        ${challenge.expiresAt.getTime()},
        ${challenge.status},
        NULL,
        NULL,
        NULL,
        ${challenge.createdAt.getTime()},
        ${challenge.updatedAt.getTime()}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${coreUser} WHERE ${coreUser.email} = ${challenge.email}
      )
    `)
    .returning({ id: coreSignupChallenge.id })

  const insertAudit = insertAuditEventWhere(
    db,
    auditEvent,
    exists(
      db
        .select({ id: coreSignupChallenge.id })
        .from(coreSignupChallenge)
        .where(eq(coreSignupChallenge.id, challenge.id)),
    ),
  )

  const [inserted] = await db.batch([insertChallenge, insertAudit])
  return inserted.length === 1
}

/** Marks an undeliverable challenge unusable without erasing its history. */
export const markSignupChallengeDeliveryFailed = async (
  db: Database,
  challengeId: string,
  now: Date,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  const markFailed = db
    .update(coreSignupChallenge)
    .set({
      status: 'DELIVERY_FAILED',
      invalidatedAt: now,
      invalidationReason: 'NOTIFICATION_DELIVERY_FAILED',
      updatedAt: now,
    })
    .where(
      and(
        eq(coreSignupChallenge.id, challengeId),
        eq(coreSignupChallenge.status, 'PENDING'),
      ),
    )

  const insertAudit = insertAuditEventWhere(
    db,
    auditEvent,
    exists(
      db
        .select({ id: coreSignupChallenge.id })
        .from(coreSignupChallenge)
        .where(
          and(
            eq(coreSignupChallenge.id, challengeId),
            eq(coreSignupChallenge.status, 'DELIVERY_FAILED'),
          ),
        ),
    ),
  )

  await db.batch([markFailed, insertAudit])
}

/**
 * Performs the authoritative, race-safe signup claim. Every mutation is gated
 * by the newly generated user ID, so a losing concurrent redemption cannot
 * consume challenges or emit a successful user-creation audit event.
 */
export const createUserFromSignupChallenge = async (
  db: Database,
  input: {
    user: UserRecord
    challenge: SignupChallengeRecord
    submittedOtpDigest: string
    now: Date
    auditEvent: AuditEventRecord
  },
): Promise<boolean> => {
  const { user, challenge, submittedOtpDigest, now, auditEvent } = input
  const userExists = exists(
    db.select({ id: coreUser.id }).from(coreUser).where(eq(coreUser.id, user.id)),
  )

  const insertUser = db
    .insert(coreUser)
    .select(sql`
      SELECT
        ${user.id},
        ${coreSignupChallenge.email},
        ${user.passwordHash},
        ${user.emailVerifiedAt?.getTime() ?? null},
        ${user.role},
        ${user.rowVersion},
        ${user.createdAt.getTime()},
        ${user.updatedAt.getTime()},
        NULL,
        NULL,
        NULL
      FROM ${coreSignupChallenge}
      WHERE ${coreSignupChallenge.id} = ${challenge.id}
        AND ${coreSignupChallenge.challengeDigest} = ${challenge.challengeDigest}
        AND ${coreSignupChallenge.otpDigest} = ${submittedOtpDigest}
        AND ${coreSignupChallenge.status} = 'PENDING'
        AND ${coreSignupChallenge.attemptsRemaining} > 0
        AND ${coreSignupChallenge.expiresAt} > ${now.getTime()}
    `)
    .onConflictDoNothing({ target: coreUser.email })
    .returning({ id: coreUser.id })

  const consumeWinner = db
    .update(coreSignupChallenge)
    .set({
      status: 'CONSUMED',
      consumedByUserId: user.id,
      invalidatedAt: now,
      invalidationReason: 'SIGNUP_COMPLETED',
      updatedAt: now,
    })
    .where(and(eq(coreSignupChallenge.id, challenge.id), userExists))

  const cancelSiblings = db
    .update(coreSignupChallenge)
    .set({
      status: 'CANCELLED',
      invalidatedAt: now,
      invalidationReason: 'SIBLING_CHALLENGE_CONSUMED',
      updatedAt: now,
    })
    .where(
      and(
        eq(coreSignupChallenge.email, challenge.email),
        ne(coreSignupChallenge.id, challenge.id),
        eq(coreSignupChallenge.status, 'PENDING'),
        userExists,
      ),
    )

  const insertAudit = insertAuditEventWhere(db, auditEvent, userExists)
  const [inserted] = await db.batch([
    insertUser,
    consumeWinner,
    cancelSiblings,
    insertAudit,
  ])
  return inserted.length === 1
}

/** Cancels remaining challenges when another request already claimed the email. */
export const cancelSignupChallengesForEmail = async (
  db: Database,
  email: string,
  now: Date,
): Promise<void> => {
  await db
    .update(coreSignupChallenge)
    .set({
      status: 'CANCELLED',
      invalidatedAt: now,
      invalidationReason: 'EMAIL_ALREADY_REGISTERED',
      updatedAt: now,
    })
    .where(
      and(eq(coreSignupChallenge.email, email), eq(coreSignupChallenge.status, 'PENDING')),
    )
}

export const findSignupChallenge = async (
  db: Database,
  challengeDigest: string,
): Promise<SignupChallengeRecord | null> => {
  const [record] = await db
    .select()
    .from(coreSignupChallenge)
    .where(eq(coreSignupChallenge.challengeDigest, challengeDigest))
    .limit(1)
  return record ?? null
}

/** Atomically decrements a pending challenge or exhausts its final attempt. */
export const consumeWrongOtpAttempt = async (
  db: Database,
  challengeId: string,
  now: Date,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  const exhaust = db
    .update(coreSignupChallenge)
    .set({
      attemptsRemaining: 0,
      status: 'EXHAUSTED',
      invalidatedAt: now,
      invalidationReason: 'OTP_ATTEMPTS_EXHAUSTED',
      updatedAt: now,
    })
    .where(
      and(
        eq(coreSignupChallenge.id, challengeId),
        eq(coreSignupChallenge.status, 'PENDING'),
        gt(coreSignupChallenge.expiresAt, now),
        gt(coreSignupChallenge.attemptsRemaining, 0),
        lte(coreSignupChallenge.attemptsRemaining, 1),
      ),
    )

  const decrement = db
    .update(coreSignupChallenge)
    .set({
      attemptsRemaining: sql`${coreSignupChallenge.attemptsRemaining} - 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(coreSignupChallenge.id, challengeId),
        eq(coreSignupChallenge.status, 'PENDING'),
        gt(coreSignupChallenge.expiresAt, now),
        gt(coreSignupChallenge.attemptsRemaining, 1),
      ),
    )

  await db.batch([exhaust, decrement, db.insert(coreAuditEvent).values(auditEvent)])
}

export const createUserSession = async (
  db: Database,
  value: SessionRecord,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  await db.batch([
    db.insert(coreSession).values(value),
    db.insert(coreAuditEvent).values(auditEvent),
  ])
}

/** Resolves one live token digest and its non-deleted owning user in one query. */
export const findUserSessionByDigest = async (
  db: Database,
  tokenDigest: string,
  now: Date,
): Promise<{ user: PublicUserRecord; session: PublicSessionRecord } | null> => {
  const [record] = await db
    .select({
      user: {
        id: coreUser.id,
        email: coreUser.email,
        emailVerifiedAt: coreUser.emailVerifiedAt,
        role: coreUser.role,
        createdAt: coreUser.createdAt,
        updatedAt: coreUser.updatedAt,
      },
      session: {
        id: coreSession.id,
        userId: coreSession.userId,
        expiresAt: coreSession.expiresAt,
        createdAt: coreSession.createdAt,
        updatedAt: coreSession.updatedAt,
        ipAddress: coreSession.ipAddress,
        userAgent: coreSession.userAgent,
      },
    })
    .from(coreSession)
    .innerJoin(coreUser, eq(coreUser.id, coreSession.userId))
    .where(
      and(
        eq(coreSession.tokenDigest, tokenDigest),
        gt(coreSession.expiresAt, now),
        isNull(coreUser.deletedAt),
      ),
    )
    .limit(1)
  return record ?? null
}

/** Marks expired challenges but physically removes expired transient sessions. */
export const cleanupExpiredAuthenticationState = async (
  db: Database,
  now: Date,
): Promise<void> => {
  await db.batch([
    db
      .update(coreSignupChallenge)
      .set({
        status: 'EXPIRED',
        invalidatedAt: now,
        invalidationReason: 'CHALLENGE_EXPIRED',
        updatedAt: now,
      })
      .where(
        and(
          eq(coreSignupChallenge.status, 'PENDING'),
          lte(coreSignupChallenge.expiresAt, now),
        ),
      ),
    db.delete(coreSession).where(lte(coreSession.expiresAt, now)),
  ])
}

/** Selects only browser-safe session columns; token digests never leave this layer. */
export const listUserSessions = async (
  db: Database,
  userId: string,
  now: Date,
): Promise<PublicSessionRecord[]> =>
  db
    .select({
      id: coreSession.id,
      userId: coreSession.userId,
      expiresAt: coreSession.expiresAt,
      createdAt: coreSession.createdAt,
      updatedAt: coreSession.updatedAt,
      ipAddress: coreSession.ipAddress,
      userAgent: coreSession.userAgent,
    })
    .from(coreSession)
    .where(and(eq(coreSession.userId, userId), gt(coreSession.expiresAt, now)))
    .orderBy(coreSession.createdAt)

/** Deletes only an owned public session ID and atomically audits a successful match. */
export const deleteUserSession = async (
  db: Database,
  sessionId: string,
  userId: string,
  auditEvent: AuditEventRecord,
): Promise<boolean> => {
  const ownedSessionExists = exists(
    db
      .select({ id: coreSession.id })
      .from(coreSession)
      .where(and(eq(coreSession.id, sessionId), eq(coreSession.userId, userId))),
  )
  const insertAudit = insertAuditEventWhere(db, auditEvent, ownedSessionExists)
  const deleteSession = db
    .delete(coreSession)
    .where(and(eq(coreSession.id, sessionId), eq(coreSession.userId, userId)))
  const [, deleted] = await db.batch([insertAudit, deleteSession])
  return changes(deleted) === 1
}

export const deleteUserSessionByDigest = async (
  db: Database,
  tokenDigest: string,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  await db.batch([
    db.insert(coreAuditEvent).values(auditEvent),
    db.delete(coreSession).where(eq(coreSession.tokenDigest, tokenDigest)),
  ])
}

export const deleteOtherUserSessions = async (
  db: Database,
  userId: string,
  currentSessionId: string,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  await db.batch([
    db.insert(coreAuditEvent).values(auditEvent),
    db
      .delete(coreSession)
      .where(and(eq(coreSession.userId, userId), ne(coreSession.id, currentSessionId))),
  ])
}

export const deleteAllUserSessions = async (
  db: Database,
  userId: string,
  auditEvent: AuditEventRecord,
): Promise<void> => {
  await db.batch([
    db.insert(coreAuditEvent).values(auditEvent),
    db.delete(coreSession).where(eq(coreSession.userId, userId)),
  ])
}
