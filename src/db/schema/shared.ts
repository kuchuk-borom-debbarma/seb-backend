import { bigint, date, integer, text, timestamp } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

/**
 * An instant, stored with its zone.
 *
 * `timestamptz` rather than `timestamp`: a bare `timestamp` silently drops the
 * offset, so two instants an hour apart compare equal after a clock change, and
 * every deadline in this programme — a cycle's closing time, a 180-day
 * utilization obligation — is a comparison against `now()`.
 *
 * `mode: 'date'` keeps Drizzle returning a `Date`, so service code that already
 * reasons in `Date` is unchanged.
 */
export const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * A calendar day, with no time and no zone.
 *
 * A date of birth, a sanction date and an establishment date are days rather
 * than instants: they do not shift when a reader is in another zone, and storing
 * one as a timestamp invites a midnight-boundary bug the first time somebody
 * compares it against `now()`.
 *
 * `mode: 'string'` keeps these as `YYYY-MM-DD` in TypeScript, which is what the
 * API already sends and what the `Date` scalar already promises. What the real
 * column type adds is refusal: `2025-02-31` is rejected by the database instead
 * of being stored and discovered by whoever reads it next.
 */
export const dateOnly = (name: string) => date(name, { mode: 'string' })

/**
 * The largest amount that survives a round trip, in paise.
 *
 * `bigint` with `mode: 'number'` is read into a JavaScript number, which is
 * exact only to 2^53-1. Every money column carries a CHECK against this so a
 * value that could not be read back is refused at write time rather than read
 * back wrong — a silently truncated award is the worst failure this schema has.
 *
 * **The comment said that before any column did it.** Every money column had a
 * floor and none had a ceiling, and this constant had no reader anywhere: the
 * second layer this schema builds everywhere else was described and not built.
 * The controllers apply `Number.isSafeInteger`, so nothing reachable through
 * the API could breach it — which is exactly the argument for the layer that
 * catches what does not come through the API.
 *
 * Written out rather than interpolated, because a CHECK is stored as the text
 * it was created with: a constant here and a literal there cannot drift, since
 * `db:schema:check` compares the generated SQL and would show it.
 *
 * It is ~₹90,071,992,547 and no Mission SEP figure approaches it.
 */
export const MAX_SAFE_PAISE = 9007199254740991

/**
 * An amount in paise. Never rupees, and never a float.
 *
 * `bigint` rather than `integer` because a 32-bit column tops out at about
 * ₹21,474,836 — reachable by a programme's total disbursement, and it would
 * fail as an overflow long after the schema was set.
 */
export const paise = (name: string) => bigint(name, { mode: 'number' })

/**
 * Common timestamps and deletion metadata for records that are retained after
 * logical deletion. Versioned entity heads extend this set with a version.
 *
 * A factory is required because Drizzle column builders belong to one table and
 * cannot be safely shared as singleton objects between table definitions.
 */
export const softDeleteColumns = (deletedByUserId: () => AnyPgColumn) => ({
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
  deletedAt: instant('deleted_at'),
  deletedByUserId: text('deleted_by_user_id').references(deletedByUserId, {
    onDelete: 'restrict',
  }),
  deleteReason: text('delete_reason'),
})

export const versionedSoftDeleteColumns = (deletedByUserId: () => AnyPgColumn) => ({
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
