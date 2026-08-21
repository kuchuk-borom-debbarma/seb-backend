/**
 * Drizzle queries used by authentication workflows. Every exported function is
 * intentionally small so controllers express policy without embedding SQL.
 */
import { and, eq, exists, gt, lte, ne, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
import { applicant, applicantSession, applicantSignupPair } from '../../../db/schema'

export type ApplicantRecord = typeof applicant.$inferSelect
export type SessionRecord = typeof applicantSession.$inferSelect
export type PublicApplicantRecord = Omit<ApplicantRecord, 'passwordHash'>
export type PublicSessionRecord = Omit<SessionRecord, 'tokenDigest'>

export type SignupPairRecord = {
  id: string
  email: string
  challengeDigest: string
  otpDigest: string
  expiresAt: number
  attemptsRemaining: number
}

const changes = (result: D1Result): number => result.meta.changes ?? 0

/** Finds the credential-bearing applicant row through its unique email index. */
export const findApplicantByEmail = async (
  db: Database,
  email: string,
): Promise<ApplicantRecord | null> => {
  const [record] = await db.select().from(applicant).where(eq(applicant.email, email)).limit(1)
  return record ?? null
}

/** Atomically creates a pair only while the normalized email is unregistered. */
export const createSignupPair = async (
  db: Database,
  pair: SignupPairRecord & { createdAt: number },
): Promise<boolean> => {
  // The INSERT itself checks for an applicant, closing the race between an
  // initial existence check and writing a new signup pair.
  const inserted = await db
    .insert(applicantSignupPair)
    .select(sql`
      SELECT
        ${pair.id},
        ${pair.email},
        ${pair.challengeDigest},
        ${pair.otpDigest},
        ${pair.expiresAt},
        ${pair.attemptsRemaining},
        ${pair.createdAt},
        ${pair.createdAt}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${applicant} WHERE ${applicant.email} = ${pair.email}
      )
    `)
    .returning({ id: applicantSignupPair.id })
  return inserted.length === 1
}

/**
 * Performs the final race-safe signup claim. D1 batches are transactional: the
 * applicant insert and deletion of every sibling challenge commit or roll back
 * together. A stale controller read cannot authorize this guarded INSERT.
 */
export const createApplicantFromSignupPair = async (
  db: Database,
  input: {
    applicant: ApplicantRecord
    pair: SignupPairRecord
    submittedOtpDigest: string
    now: number
  },
): Promise<boolean> => {
  const { applicant: value, pair, submittedOtpDigest, now } = input
  // This transaction is the authoritative OTP claim. It rechecks the pair at
  // write time, inserts at most one applicant, and removes every sibling pair.
  // Concurrent wrong attempts and redemptions are serialized by D1.
  const insertApplicant = db
    .insert(applicant)
    .select(sql`
      SELECT
        ${value.id},
        ${applicantSignupPair.email},
        ${value.passwordHash},
        ${value.emailVerified ? 1 : 0},
        ${value.role},
        ${value.createdAt.getTime()},
        ${value.updatedAt.getTime()}
      FROM ${applicantSignupPair}
      WHERE ${applicantSignupPair.id} = ${pair.id}
        AND ${applicantSignupPair.challengeDigest} = ${pair.challengeDigest}
        AND ${applicantSignupPair.otpDigest} = ${submittedOtpDigest}
        AND ${applicantSignupPair.expiresAt} > ${now}
    `)
    .onConflictDoNothing({ target: applicant.email })
    .returning({ id: applicant.id })

  // The applicant-id condition makes this a no-op when the guarded insert did
  // not run. A cleanup failure rolls the insert back with the entire batch.
  const deleteSiblingPairs = db.delete(applicantSignupPair).where(
    and(
      eq(applicantSignupPair.email, pair.email),
      exists(db.select({ id: applicant.id }).from(applicant).where(eq(applicant.id, value.id))),
    ),
  )

  const [inserted] = await db.batch([insertApplicant, deleteSiblingPairs])
  return inserted.length === 1
}

export const deleteSignupPair = async (db: Database, id: string): Promise<void> => {
  await db.delete(applicantSignupPair).where(eq(applicantSignupPair.id, id))
}

export const deleteSignupPairsForEmail = async (
  db: Database,
  email: string,
): Promise<void> => {
  await db.delete(applicantSignupPair).where(eq(applicantSignupPair.email, email))
}

export const findSignupPair = async (
  db: Database,
  challengeDigest: string,
): Promise<SignupPairRecord | null> => {
  const [record] = await db
    .select({
      id: applicantSignupPair.id,
      email: applicantSignupPair.email,
      challengeDigest: applicantSignupPair.challengeDigest,
      otpDigest: applicantSignupPair.otpDigest,
      expiresAt: applicantSignupPair.expiresAt,
      attemptsRemaining: applicantSignupPair.attemptsRemaining,
    })
    .from(applicantSignupPair)
    .where(eq(applicantSignupPair.challengeDigest, challengeDigest))
    .limit(1)
  return record ?? null
}

/**
 * Consumes exactly one attempt at D1's write ordering point. On the final
 * attempt the row is deleted rather than decremented to an invalid zero value.
 */
export const consumeWrongOtpAttempt = async (
  db: Database,
  pairId: string,
  now: number,
): Promise<void> => {
  // Delete first when this is the last attempt, then decrement all other
  // matching rows. D1 batches make the pair-specific transition atomic.
  await db.batch([
    db.delete(applicantSignupPair).where(
      and(
        eq(applicantSignupPair.id, pairId),
        gt(applicantSignupPair.expiresAt, now),
        lte(applicantSignupPair.attemptsRemaining, 1),
      ),
    ),
    db
      .update(applicantSignupPair)
      .set({
        attemptsRemaining: sql`${applicantSignupPair.attemptsRemaining} - 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(applicantSignupPair.id, pairId),
          gt(applicantSignupPair.expiresAt, now),
          gt(applicantSignupPair.attemptsRemaining, 1),
        ),
      ),
  ])
}

export const createApplicantSession = async (
  db: Database,
  value: typeof applicantSession.$inferInsert,
): Promise<void> => {
  await db.insert(applicantSession).values(value)
}

/** Resolves one live bearer-token digest and its owning applicant in one query. */
export const findApplicantSessionByDigest = async (
  db: Database,
  tokenDigest: string,
  now: Date,
): Promise<{ applicant: PublicApplicantRecord; session: PublicSessionRecord } | null> => {
  const [record] = await db
    .select({
      applicant: {
        id: applicant.id,
        email: applicant.email,
        emailVerified: applicant.emailVerified,
        role: applicant.role,
        createdAt: applicant.createdAt,
        updatedAt: applicant.updatedAt,
      },
      session: {
        id: applicantSession.id,
        applicantId: applicantSession.applicantId,
        expiresAt: applicantSession.expiresAt,
        createdAt: applicantSession.createdAt,
        updatedAt: applicantSession.updatedAt,
        ipAddress: applicantSession.ipAddress,
        userAgent: applicantSession.userAgent,
      },
    })
    .from(applicantSession)
    .innerJoin(applicant, eq(applicant.id, applicantSession.applicantId))
    .where(
      and(
        eq(applicantSession.tokenDigest, tokenDigest),
        gt(applicantSession.expiresAt, now),
      ),
    )
    .limit(1)
  return record ?? null
}

/** Bulk maintenance called by Cron; expiry indexes keep both deletes bounded. */
export const deleteExpiredAuthenticationState = async (
  db: Database,
  now: Date,
): Promise<void> => {
  await db.batch([
    db.delete(applicantSignupPair).where(lte(applicantSignupPair.expiresAt, now.getTime())),
    db.delete(applicantSession).where(lte(applicantSession.expiresAt, now)),
  ])
}

/** Selects only browser-safe session columns; token digests never leave this layer. */
export const listApplicantSessions = async (
  db: Database,
  applicantId: string,
  now: Date,
): Promise<PublicSessionRecord[]> => {
  return db
    .select({
      id: applicantSession.id,
      applicantId: applicantSession.applicantId,
      expiresAt: applicantSession.expiresAt,
      createdAt: applicantSession.createdAt,
      updatedAt: applicantSession.updatedAt,
      ipAddress: applicantSession.ipAddress,
      userAgent: applicantSession.userAgent,
    })
    .from(applicantSession)
    .where(
      and(eq(applicantSession.applicantId, applicantId), gt(applicantSession.expiresAt, now)),
    )
    .orderBy(applicantSession.createdAt)
}

/** Deletes by both public session ID and owner, preventing cross-account revocation. */
export const deleteApplicantSession = async (
  db: Database,
  sessionId: string,
  applicantId: string,
): Promise<boolean> => {
  const result = await db
    .delete(applicantSession)
    .where(
      and(eq(applicantSession.id, sessionId), eq(applicantSession.applicantId, applicantId)),
    )
  return changes(result) === 1
}

export const deleteApplicantSessionByDigest = async (
  db: Database,
  tokenDigest: string,
): Promise<void> => {
  await db.delete(applicantSession).where(eq(applicantSession.tokenDigest, tokenDigest))
}

export const deleteOtherApplicantSessions = async (
  db: Database,
  applicantId: string,
  currentSessionId: string,
): Promise<void> => {
  await db
    .delete(applicantSession)
    .where(
      and(
        eq(applicantSession.applicantId, applicantId),
        ne(applicantSession.id, currentSessionId),
      ),
    )
}

export const deleteAllApplicantSessions = async (
  db: Database,
  applicantId: string,
): Promise<void> => {
  await db.delete(applicantSession).where(eq(applicantSession.applicantId, applicantId))
}
