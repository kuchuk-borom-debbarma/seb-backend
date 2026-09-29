import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { instant, softDeleteColumns } from '../shared'

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
