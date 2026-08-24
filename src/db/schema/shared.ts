import { integer, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

/**
 * Common timestamps and deletion metadata for records that are retained after
 * logical deletion. Versioned entity heads extend this set with a version.
 *
 * A factory is required because Drizzle column builders belong to one table and
 * cannot be safely shared as singleton objects between table definitions.
 */
export const softDeleteColumns = (deletedByUserId: () => AnySQLiteColumn) => ({
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  deletedByUserId: text('deleted_by_user_id').references(deletedByUserId, {
    onDelete: 'restrict',
  }),
  deleteReason: text('delete_reason'),
})

export const versionedSoftDeleteColumns = (deletedByUserId: () => AnySQLiteColumn) => ({
  currentVersion: integer('current_version').notNull(),
  ...softDeleteColumns(deletedByUserId),
})

/**
 * The desk-review vocabulary, kept here rather than beside the review tables.
 *
 * Both the review tables and the programme-cycle rules need these words, and
 * `review.ts` already imports `programme.ts` — so defining them there and
 * importing back would make the two schema modules circular. A leaf both can
 * reach costs nothing and keeps the dependency one way.
 */
export const deskReviewChecks = [
  'IDENTITY_KYC',
  'ST_ELIGIBILITY',
  'MAJORITY_OWNERSHIP',
  'JURISDICTION',
  'FORM_COMPLETENESS',
  'DOCUMENT_COMPLETENESS',
  'ANSWER_DOCUMENT_CONSISTENCY',
  'DPR_FEASIBILITY',
  'EXPANSION_EVIDENCE',
] as const

export const deskReviewIdentifierKinds = [
  'ST_CERTIFICATE',
  'IDENTITY_DOCUMENT',
  'BANK_ACCOUNT',
  'BUSINESS_REGISTRATION',
] as const
