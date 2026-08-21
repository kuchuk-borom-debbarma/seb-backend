import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import { softDeleteColumns } from '../shared'

export const userRoles = ['APPLICANT'] as const
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
 */
export const coreUser = sqliteTable(
  'core_user',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp_ms' }),
    role: text('role', { enum: userRoles }).notNull().default('APPLICANT'),
    rowVersion: integer('row_version').notNull().default(1),
    ...softDeleteColumns((): AnySQLiteColumn => coreUser.id),
  },
  (table) => [
    check('core_user_role_check', sql`${table.role} = 'APPLICANT'`),
    check('core_user_row_version_check', sql`${table.rowVersion} >= 1`),
  ],
)

/**
 * Browser sessions are the sole hard-delete exception in the data model.
 * D1 stores only the keyed digest of the opaque cookie token.
 */
export const coreSession = sqliteTable(
  'core_session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    tokenDigest: text('token_digest').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
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
export const coreSignupChallenge = sqliteTable(
  'core_signup_challenge',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    challengeDigest: text('challenge_digest').notNull().unique(),
    otpDigest: text('otp_digest').notNull(),
    attemptsRemaining: integer('attempts_remaining').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status', { enum: signupChallengeStatuses }).notNull().default('PENDING'),
    consumedByUserId: text('consumed_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    invalidatedAt: integer('invalidated_at', { mode: 'timestamp_ms' }),
    invalidationReason: text('invalidation_reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
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
