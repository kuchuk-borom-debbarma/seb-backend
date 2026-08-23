/**
 * Drizzle queries used by authentication workflows. SQL details and D1 batch
 * boundaries stay here so controllers can express policy without weakening
 * the race guarantees of signup or session ownership checks.
 */
import { and, desc, eq, exists, gt, isNotNull, isNull, lte, ne, not, notExists, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  coreSession,
  coreSignupChallenge,
  coreUser,
  coreUserRoleGrant,
  sebEnterprise,
  userRoles,
  type UserRole,
} from '../../../db/schema'

export type UserRecord = typeof coreUser.$inferSelect
export type UserRoleGrantRecord = typeof coreUserRoleGrant.$inferSelect
export type SessionRecord = typeof coreSession.$inferSelect
export type SignupChallengeRecord = typeof coreSignupChallenge.$inferSelect
export type AuditEventRecord = typeof coreAuditEvent.$inferInsert
export type PublicUserRecord = Pick<
  UserRecord,
  'id' | 'email' | 'emailVerifiedAt' | 'createdAt' | 'updatedAt'
>
export type PublicSessionRecord = Omit<SessionRecord, 'tokenDigest'>

const changes = (result: D1Result): number => result.meta.changes ?? 0

/** Builds a guarded audit INSERT used inside the same D1 transaction as a mutation. */
export const insertAuditEventWhere = (
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

/**
 * True while the person still holds at least one unrevoked grant.
 *
 * Accepts either a literal user ID or the `core_user.id` column so the same
 * rule can be correlated into an outer query or pinned to one known user.
 */
const hasActiveRoleGrant = (db: Database, userId: AnyColumn | string): SQL => exists(
  db
    .select({ id: coreUserRoleGrant.id })
    .from(coreUserRoleGrant)
    .where(
      and(
        eq(coreUserRoleGrant.userId, userId),
        isNull(coreUserRoleGrant.revokedAt),
      ),
    ),
)

/**
 * Credential authentication requires a live identity and at least one active
 * role grant of any kind. The role is deliberately not narrowed here: an
 * administrator who was never an applicant must be able to sign in, while a
 * person whose every grant has been revoked must not.
 *
 * Resolving the grant on each sign-in rather than trusting a cached user row
 * means a revocation cannot be outlived by stale state.
 */
export const findActiveUserByEmail = async (
  db: Database,
  email: string,
): Promise<UserRecord | null> => {
  const [record] = await db
    .select()
    .from(coreUser)
    .where(
      and(
        eq(coreUser.email, email),
        isNull(coreUser.deletedAt),
        hasActiveRoleGrant(db, coreUser.id),
      ),
    )
    .limit(1)
  return record ?? null
}

/**
 * Deduplicates and orders roles by the schema's own role catalogue.
 *
 * Every role-reading path runs this so a public response never depends on the
 * order D1 happened to return grant rows in. Filtering against `userRoles`
 * rather than a local copy means a role added to the schema cannot be silently
 * dropped from public responses.
 */
export const orderedRoles = (roles: Iterable<UserRole>): UserRole[] => {
  const active = new Set(roles)
  return userRoles.filter((role) => active.has(role))
}

/** Returns active roles in the fixed catalogue order used by public responses. */
export const findActiveUserRoles = async (
  db: Database,
  userId: string,
): Promise<UserRole[]> => {
  const records = await db
    .select({ role: coreUserRoleGrant.role })
    .from(coreUserRoleGrant)
    .where(
      and(
        eq(coreUserRoleGrant.userId, userId),
        isNull(coreUserRoleGrant.revokedAt),
      ),
    )
  return orderedRoles(records.map(({ role }) => role))
}

type FirstSuperAdminGrantInput = {
  userId: string
  email: string
  verifiedPasswordHash: string
  roleGrant: UserRoleGrantRecord
  roleGrantAuditEvent: AuditEventRecord
  roleRevocationAuditEvent: AuditEventRecord
  bootstrapAuditEvent: AuditEventRecord
}

/**
 * True while the person owns no enterprise at all.
 *
 * Bootstrap revokes APPLICANT, and no operation can grant it back — role
 * administration deliberately covers ADMIN and SUPER_ADMIN only — so promoting
 * an owner would orphan their enterprises and applications permanently.
 * Soft-deleted enterprises count because they are restorable.
 */
const ownsNoEnterprise = (db: Database, userId: string): SQL => notExists(
  db
    .select({ id: sebEnterprise.id })
    .from(sebEnterprise)
    .where(eq(sebEnterprise.portalOwnerUserId, userId)),
)

/** True while the person holds an active grant of exactly this one role. */
export const hasActiveRole = (db: Database, userId: string, role: UserRole): SQL => exists(
  db
    .select({ id: coreUserRoleGrant.id })
    .from(coreUserRoleGrant)
    .where(
      and(
        eq(coreUserRoleGrant.userId, userId),
        eq(coreUserRoleGrant.role, role),
        isNull(coreUserRoleGrant.revokedAt),
      ),
    ),
)

/** Repeats every mutable candidate condition at the authoritative write. */
const firstSuperAdminCandidateExists = (
  db: Database,
  input: FirstSuperAdminGrantInput,
): SQL => exists(
  db
    .select({ id: coreUser.id })
    .from(coreUser)
    .where(
      and(
        eq(coreUser.id, input.userId),
        eq(coreUser.email, input.email),
        eq(coreUser.passwordHash, input.verifiedPasswordHash),
        isNotNull(coreUser.emailVerifiedAt),
        isNull(coreUser.deletedAt),
        hasActiveRole(db, input.userId, 'APPLICANT'),
        ownsNoEnterprise(db, input.userId),
      ),
    ),
)

/** A revoked SUPER_ADMIN still proves that the one-time bootstrap was used. */
const firstSuperAdminNeverGranted = (db: Database): SQL => notExists(
  db
    .select({ id: coreUserRoleGrant.id })
    .from(coreUserRoleGrant)
    .where(eq(coreUserRoleGrant.role, 'SUPER_ADMIN')),
)

/**
 * Finds the configured credential owner only while bootstrap is still open.
 *
 * Keeping the historical-grant predicate in this lookup prevents needless
 * memory-hard password verification after bootstrap has permanently closed.
 * The write query repeats every condition to remain authoritative under races.
 */
export const findFirstSuperAdminCandidateByEmail = async (
  db: Database,
  email: string,
): Promise<UserRecord | null> => {
  const activeApplicantGrant = exists(
    db
      .select({ id: coreUserRoleGrant.id })
      .from(coreUserRoleGrant)
      .where(
        and(
          eq(coreUserRoleGrant.userId, coreUser.id),
          eq(coreUserRoleGrant.role, 'APPLICANT'),
          isNull(coreUserRoleGrant.revokedAt),
        ),
      ),
  )
  const ownsNoEnterpriseYet = notExists(
    db
      .select({ id: sebEnterprise.id })
      .from(sebEnterprise)
      .where(eq(sebEnterprise.portalOwnerUserId, coreUser.id)),
  )
  const [record] = await db
    .select()
    .from(coreUser)
    .where(
      and(
        eq(coreUser.email, email),
        isNotNull(coreUser.emailVerifiedAt),
        isNull(coreUser.deletedAt),
        activeApplicantGrant,
        ownsNoEnterpriseYet,
        firstSuperAdminNeverGranted(db),
      ),
    )
    .limit(1)
  return record ?? null
}

/**
 * Performs the only transition allowed to create the first SUPER_ADMIN grant.
 *
 * The promoted person's APPLICANT grant is revoked in the same transition, so
 * bootstrap yields an administrator-only account rather than a dual-role one.
 * Both role events are retained in grant history.
 *
 * The absence check intentionally includes revoked grants. Since grants are
 * retained forever, the first historical SUPER_ADMIN row doubles as the
 * permanent bootstrap-completed marker without introducing mutable flag state.
 * The password hash is repeated in the write predicate so a concurrent password
 * change defeats a request that verified stale credentials.
 */
export const grantFirstSuperAdmin = async (
  db: Database,
  input: FirstSuperAdminGrantInput,
): Promise<boolean> => {
  const insertGrant = db
    .insert(coreUserRoleGrant)
    .select(sql`
      SELECT
        ${input.roleGrant.id},
        ${input.roleGrant.userId},
        ${input.roleGrant.role},
        NULL,
        ${input.roleGrant.grantReason},
        ${input.roleGrant.grantedAt.getTime()},
        NULL,
        NULL,
        NULL
      WHERE ${firstSuperAdminCandidateExists(db, input)}
        AND ${firstSuperAdminNeverGranted(db)}
    `)
    .returning({ id: coreUserRoleGrant.id })
  const grantExists = exists(
    db
      .select({ id: coreUserRoleGrant.id })
      .from(coreUserRoleGrant)
      .where(eq(coreUserRoleGrant.id, input.roleGrant.id)),
  )

  // Matching on user and role rather than on a grant ID read earlier. A grant
  // revoked and re-created between that read and this write would leave a stale
  // ID matching nothing, silently leaving the account with both roles.
  //
  // Sharing the SUPER_ADMIN insert's guard is what makes the swap safe: a
  // request that loses the bootstrap race revokes nothing, instead of stranding
  // the account with no active role and therefore no way to sign in.
  const revokeApplicantGrant = db
    .update(coreUserRoleGrant)
    .set({
      // Authority comes from trusted bootstrap configuration, not from another
      // portal user, so the revocation has no actor for the same reason the
      // grant has no granter.
      revokedByUserId: null,
      // Taking both values from the grant keeps the swap structurally one
      // event: the pair cannot drift to different times or different reasons.
      revokedAt: input.roleGrant.grantedAt,
      revocationReason: input.roleGrant.grantReason,
    })
    .where(
      and(
        eq(coreUserRoleGrant.userId, input.userId),
        eq(coreUserRoleGrant.role, 'APPLICANT'),
        isNull(coreUserRoleGrant.revokedAt),
        grantExists,
      ),
    )

  // Every session this account already held was issued to an applicant. Leaving
  // them alive would silently upgrade each one to full administrative authority
  // without the holder re-proving the password, so the swap destroys them and
  // the new administrator signs in again.
  const destroyExistingSessions = db
    .delete(coreSession)
    .where(and(eq(coreSession.userId, input.userId), grantExists))

  // One batch, one D1 transaction: the swap, the session purge, and all three
  // audits are never observable half-applied.
  const [inserted] = await db.batch([
    insertGrant,
    revokeApplicantGrant,
    destroyExistingSessions,
    insertAuditEventWhere(db, input.roleGrantAuditEvent, grantExists),
    insertAuditEventWhere(db, input.roleRevocationAuditEvent, grantExists),
    insertAuditEventWhere(db, input.bootstrapAuditEvent, grantExists),
  ])
  return inserted.length === 1
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
    roleGrant: UserRoleGrantRecord
    challenge: SignupChallengeRecord
    submittedOtpDigest: string
    now: Date
    auditEvent: AuditEventRecord
    roleAuditEvent: AuditEventRecord
  },
): Promise<boolean> => {
  const {
    user,
    roleGrant,
    challenge,
    submittedOtpDigest,
    now,
    auditEvent,
    roleAuditEvent,
  } = input
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

  // The grant is part of the same batch and depends on the freshly generated
  // user ID. Any role-insert failure rolls back the identity and challenge
  // transition, so a verified applicant can never exist without APPLICANT.
  const insertRoleGrant = db.insert(coreUserRoleGrant).select(sql`
    SELECT
      ${roleGrant.id},
      ${user.id},
      ${roleGrant.role},
      ${roleGrant.grantedByUserId},
      ${roleGrant.grantReason},
      ${roleGrant.grantedAt.getTime()},
      NULL,
      NULL,
      NULL
    WHERE ${userExists}
  `)

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
  const insertRoleAudit = insertAuditEventWhere(db, roleAuditEvent, userExists)
  const [inserted] = await db.batch([
    insertUser,
    insertRoleGrant,
    consumeWinner,
    cancelSiblings,
    insertAudit,
    insertRoleAudit,
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

/**
 * Creates a session only while the identity and at least one role grant are
 * still authoritative. Password verification is intentionally outside D1 and
 * may be slow, so the INSERT repeats those conditions at write time instead of
 * trusting the controller's earlier credential lookup.
 */
export const createUserSession = async (
  db: Database,
  value: SessionRecord,
  auditEvent: AuditEventRecord,
): Promise<boolean> => {
  const userIsStillActive = exists(
    db
      .select({ id: coreUserRoleGrant.id })
      .from(coreUserRoleGrant)
      .innerJoin(coreUser, eq(coreUser.id, coreUserRoleGrant.userId))
      .where(
        and(
          eq(coreUserRoleGrant.userId, value.userId),
          isNull(coreUserRoleGrant.revokedAt),
          isNull(coreUser.deletedAt),
          sql`${coreUser.emailVerifiedAt} IS NOT NULL`,
        ),
      ),
  )

  const insertSession = db
    .insert(coreSession)
    .select(sql`
      SELECT
        ${value.id},
        ${value.userId},
        ${value.tokenDigest},
        ${value.expiresAt.getTime()},
        ${value.ipAddress},
        ${value.userAgent},
        ${value.createdAt.getTime()},
        ${value.updatedAt.getTime()}
      WHERE ${userIsStillActive}
    `)
    .returning({ id: coreSession.id })
  const sessionExists = exists(
    db.select({ id: coreSession.id }).from(coreSession).where(eq(coreSession.id, value.id)),
  )
  const insertAudit = insertAuditEventWhere(db, auditEvent, sessionExists)
  const [inserted] = await db.batch([insertSession, insertAudit])
  return inserted.length === 1
}

/**
 * Resolves one live token digest, its non-deleted owner, and current roles in
 * one query. Roles are joined live rather than copied into the session so a
 * grant or revocation takes effect on the very next request.
 */
export const findUserSessionByDigest = async (
  db: Database,
  tokenDigest: string,
  now: Date,
): Promise<{
  user: PublicUserRecord
  roles: UserRole[]
  session: PublicSessionRecord
} | null> => {
  const records = await db
    .select({
      user: {
        id: coreUser.id,
        email: coreUser.email,
        emailVerifiedAt: coreUser.emailVerifiedAt,
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
      role: coreUserRoleGrant.role,
    })
    .from(coreSession)
    .innerJoin(coreUser, eq(coreUser.id, coreSession.userId))
    .leftJoin(
      coreUserRoleGrant,
      and(
        eq(coreUserRoleGrant.userId, coreUser.id),
        isNull(coreUserRoleGrant.revokedAt),
      ),
    )
    .where(
      and(
        eq(coreSession.tokenDigest, tokenDigest),
        gt(coreSession.expiresAt, now),
        isNull(coreUser.deletedAt),
      ),
    )
  const first = records[0]
  if (!first) return null
  const roles = orderedRoles(
    records.flatMap(({ role }) => role === null ? [] : [role]),
  )
  return { user: first.user, session: first.session, roles }
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
    // A person holding no active role cannot authenticate, but their rows would
    // otherwise survive until expiry and start working again the moment any
    // role is granted back. Sweeping them makes deactivation durable.
    db.delete(coreSession).where(not(hasActiveRoleGrant(db, coreSession.userId))),
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
    /*
     * Newest first and capped. This is the one collection a person can inflate
     * on purpose — every sign-in mints a session — and nobody manages a
     * thousand devices from a list. "Sign out everywhere" still ends all of
     * them, capped or not, because that is a bulk write rather than a walk of
     * this array. The id breaks ties so the order is stable between reads.
     */
    .orderBy(desc(coreSession.createdAt), desc(coreSession.id))
    .limit(MAX_SESSIONS_SHOWN)

/** Enough to recognise and revoke a device; more is a list nobody reads. */
const MAX_SESSIONS_SHOWN = 100

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
