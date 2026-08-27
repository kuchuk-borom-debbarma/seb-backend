import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  type AnyPgColumn,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { instant, softDeleteColumns } from '../shared'

/**
 * Fixed authorization vocabulary for the portal.
 *
 * Roles intentionally live in code rather than a configurable registry. This
 * keeps authorization reviewable: adding a role requires a schema and service
 * change instead of an arbitrary production data edit.
 */
export const userRoles = [
  'APPLICANT',
  'REVIEWER',
  'APPROVER',
  'ADMIN',
  'SUPER_ADMIN',
] as const
export type UserRole = (typeof userRoles)[number]
export const signupChallengeStatuses = [
  'PENDING',
  'CONSUMED',
  'EXHAUSTED',
  'EXPIRED',
  'CANCELLED',
  'DELIVERY_FAILED',
] as const

/**
 * Authentication identity shared by every product domain.
 *
 * Deleted email addresses remain in this table and therefore stay reserved by
 * the unique constraint. Password history is intentionally not retained: an
 * audit event records that a password changed without copying credential data.
 * Authorization is deliberately absent from this row; retained role grants
 * allow one identity to act as an applicant and administrator independently.
 */
export const coreUser = pgTable(
  'core_user',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: instant('email_verified_at'),
    rowVersion: integer('row_version').notNull().default(1),
    ...softDeleteColumns((): AnyPgColumn => coreUser.id),
    /*
     * What this person is called, when they have said. Nullable because an
     * account may never have answered, and inventing one from the email address
     * would be a guess presented as a fact.
     *
     * Deliberately not unique and not an identifier: the address remains how an
     * account is addressed and how the office refers to each other. This is a
     * label, so two people called the same thing is not a conflict.
     */
    displayName: text('display_name'),
  },
  (table) => [
    check('core_user_row_version_check', sql`${table.rowVersion} >= 1`),
  ],
)

/**
 * Retained history of roles granted to an identity.
 *
 * Revocation closes a grant instead of deleting it. A later re-grant creates a
 * new row, preserving who held which authority at the time of every audit
 * event. The partial unique index is the concurrency guard that prevents two
 * active copies of the same role while still permitting historical copies.
 */
export const coreUserRoleGrant = pgTable(
  'core_user_role_grant',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    role: text('role', { enum: userRoles }).notNull(),
    // Null identifies a trusted system transition such as verified signup or
    // the one-time first-super-admin bootstrap. Public input never controls it.
    grantedByUserId: text('granted_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    grantReason: text('grant_reason').notNull(),
    grantedAt: instant('granted_at').notNull(),
    revokedByUserId: text('revoked_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    revokedAt: instant('revoked_at'),
    revocationReason: text('revocation_reason'),
  },
  (table) => [
    check(
      'core_user_role_grant_role_check',
      sql`${table.role} IN ('APPLICANT', 'REVIEWER', 'APPROVER', 'ADMIN', 'SUPER_ADMIN')`,
    ),
    // Active grants contain no revocation metadata. Automated revocation may
    // have no user actor, but every closed grant must retain when and why.
    check(
      'core_user_role_grant_revocation_check',
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationReason} IS NULL)
        OR (${table.revokedAt} IS NOT NULL
          AND ${table.revocationReason} IS NOT NULL
          AND ${table.revokedAt} >= ${table.grantedAt})`,
    ),
    uniqueIndex('core_user_role_grant_active_uq')
      .on(table.userId, table.role)
      .where(sql`${table.revokedAt} IS NULL`),
    index('core_user_role_grant_user_idx').on(table.userId, table.revokedAt, table.role),
    index('core_user_role_grant_role_idx').on(table.role, table.revokedAt, table.userId),
  ],
)

/**
 * Browser sessions are the sole hard-delete exception in the data model.
 * Only the keyed digest of the opaque cookie token is stored.
 */
export const coreSession = pgTable(
  'core_session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    tokenDigest: text('token_digest').notNull().unique(),
    expiresAt: instant('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    index('core_session_user_expiry_idx').on(table.userId, table.expiresAt),
    index('core_session_expiry_idx').on(table.expiresAt),
  ],
)

/**
 * One signup request and its OTP. Challenges transition through lifecycle
 * states instead of being deleted, preserving the security history without
 * ever retaining the raw challenge token or OTP.
 */
export const coreSignupChallenge = pgTable(
  'core_signup_challenge',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    challengeDigest: text('challenge_digest').notNull().unique(),
    otpDigest: text('otp_digest').notNull(),
    attemptsRemaining: integer('attempts_remaining').notNull(),
    expiresAt: instant('expires_at').notNull(),
    status: text('status', { enum: signupChallengeStatuses }).notNull().default('PENDING'),
    consumedByUserId: text('consumed_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    invalidatedAt: instant('invalidated_at'),
    invalidationReason: text('invalidation_reason'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    check(
      'core_signup_challenge_attempts_check',
      sql`${table.attemptsRemaining} BETWEEN 0 AND 20`,
    ),
    check(
      'core_signup_challenge_status_check',
      sql`${table.status} IN ('PENDING', 'CONSUMED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'DELIVERY_FAILED')`,
    ),
    index('core_signup_challenge_email_status_expiry_idx').on(
      table.email,
      table.status,
      table.expiresAt,
    ),
    // Cleanup first selects the small PENDING subset, then applies an expiry
    // range. Keeping the equality column first prevents retained challenge
    // history from making each cron run scan every old expired row.
    index('core_signup_challenge_status_expiry_idx').on(table.status, table.expiresAt),
  ],
)

/**
 * What an account challenge is proving.
 *
 * Both purposes share a lifecycle, a pair of digests and an attempt counter,
 * so they share a table rather than duplicating one. The column is what makes
 * a reset code useless against an email change and the reverse — the purpose
 * is part of what is verified, not a label on the row.
 */
export const accountChallengePurposes = ['PASSWORD_RESET', 'EMAIL_CHANGE'] as const
export type AccountChallengePurpose = (typeof accountChallengePurposes)[number]

/**
 * One request to prove control of a mailbox, for an account that already
 * exists.
 *
 * Deliberately the same shape as `core_signup_challenge`: a digest of the token
 * handed to the browser, a digest of the code sent to the mailbox, a bounded
 * attempt counter and a status that closes rather than deletes. Neither raw
 * value is ever stored, and the two are independent — the token alone proves
 * only that this browser asked, the code alone only that somebody read the
 * mailbox.
 *
 * Separate from the signup challenge because that one has no user yet and this
 * one always does. Merging them would mean a nullable `user_id` that is
 * required in one flow and forbidden in the other, which no constraint could
 * then express.
 */
export const coreAccountChallenge = pgTable(
  'core_account_challenge',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose', { enum: accountChallengePurposes }).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    /*
     * Where the code went, which is not always the account's address: an email
     * change sends it to the address being claimed. Recorded so the completing
     * step knows which address was actually proved, rather than trusting an
     * argument sent with it.
     */
    email: text('email').notNull(),
    challengeDigest: text('challenge_digest').notNull().unique(),
    otpDigest: text('otp_digest').notNull(),
    attemptsRemaining: integer('attempts_remaining').notNull(),
    expiresAt: instant('expires_at').notNull(),
    status: text('status', { enum: signupChallengeStatuses }).notNull().default('PENDING'),
    consumedAt: instant('consumed_at'),
    invalidatedAt: instant('invalidated_at'),
    invalidationReason: text('invalidation_reason'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    check(
      'core_account_challenge_attempts_check',
      sql`${table.attemptsRemaining} BETWEEN 0 AND 20`,
    ),
    check(
      'core_account_challenge_purpose_check',
      sql`${table.purpose} IN ('PASSWORD_RESET', 'EMAIL_CHANGE')`,
    ),
    check(
      'core_account_challenge_status_check',
      sql`${table.status} IN ('PENDING', 'CONSUMED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'DELIVERY_FAILED')`,
    ),
    // Superseding an account's outstanding challenges for one purpose, which is
    // what starting a new request does.
    index('core_account_challenge_user_purpose_idx').on(
      table.userId,
      table.purpose,
      table.status,
      table.expiresAt,
    ),
    // The cron sweep, for the reason the signup challenge gives for its own:
    // equality column first, so retained history is not rescanned every hour.
    index('core_account_challenge_status_expiry_idx').on(table.status, table.expiresAt),
  ],
)
