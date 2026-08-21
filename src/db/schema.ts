import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Applicant identity and password credentials share one row. Keeping them
// together lets the unique email constraint be the final signup race arbiter.
export const applicant = sqliteTable('applicant', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(true),
  role: text('role', { enum: ['APPLICANT'] }).notNull().default('APPLICANT'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const applicantSession = sqliteTable(
  'applicant_session',
  {
    id: text('id').primaryKey(),
    applicantId: text('applicant_id')
      .notNull()
      .references(() => applicant.id, { onDelete: 'cascade' }),
    // Raw bearer tokens never enter D1; only a keyed HMAC digest is searchable.
    tokenDigest: text('token_digest').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('applicant_session_applicant_idx').on(table.applicantId),
    index('applicant_session_expiry_idx').on(table.expiresAt),
  ],
)

// Repeated signup starts create independent rows. A successful redemption
// deletes every sibling row for the email in the same D1 transaction.
export const applicantSignupPair = sqliteTable(
  'applicant_signup_pair',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    // The random challenge selects a pair; the six-digit OTP proves email access.
    // Both values are represented by purpose-separated HMAC digests.
    challengeDigest: text('challenge_digest').notNull().unique(),
    otpDigest: text('otp_digest').notNull(),
    expiresAt: integer('expires_at').notNull(),
    attemptsRemaining: integer('attempts_remaining').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('applicant_signup_pair_email_idx').on(table.email),
    index('applicant_signup_pair_expiry_idx').on(table.expiresAt),
    check(
      'applicant_signup_pair_attempts_check',
      sql`${table.attemptsRemaining} BETWEEN 1 AND 20`,
    ),
  ],
)

export const schema = {
  applicant,
  applicantSession,
  applicantSignupPair,
}
