/**
 * The building blocks every action's payload is made of.
 *
 * Shared rather than restated per action for two reasons. The rules are policy
 * — a reason is bounded at one length, an email is only ever stored after it
 * parsed — and a rule written eighty times is eighty chances for one copy to
 * drift. And the payload schemas would otherwise be the largest body of
 * near-identical code in the repository, which is exactly what `fallow`'s
 * duplication gate exists to refuse.
 */
import { z } from 'zod'
import type { AuditFieldSpec } from './types'

/** The longest reason an audit row keeps. The source record keeps the whole. */
const AUDIT_REASON_LIMIT = 500

/** The longest address RFC 5321 allows; anything longer never parsed. */
const EMAIL_LIMIT = 254

/** An identifier of another row. Not constrained to a UUID: `'BOARD'` is one. */
export const auditId = z.string().min(1).max(128)

/** Money, as the ledger holds it: a non-negative whole number of paise. */
export const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const count = z.number().int().nonnegative()

export const version = z.number().int().positive()

/** An ISO calendar date, `YYYY-MM-DD`. */
export const isoDate = z.iso.date()

/** An ISO instant, as `Date.prototype.toISOString` writes it. */
export const isoInstant = z.iso.datetime()

/** A short enumerated or coded value the source row already constrained. */
export const code = z.string().min(1).max(64)

/** A short human label copied from the record: a bank's name, a sanction order. */
export const label = z.string().min(1).max(200)

/** An operator's reason, already bounded by {@link auditReason}. */
export const reasonText = z.string().min(1).max(AUDIT_REASON_LIMIT)

/** An address, stored only once it has parsed as one. */
export const email = z.email().max(EMAIL_LIMIT)

/**
 * Bounds an operator's reason for the history.
 *
 * Whitespace is collapsed and the text trimmed, then cut at the limit with an
 * ellipsis so a reader can see it was cut. The full reason stays on the record
 * it explains — a grant, a decision, an announcement — which is where a person
 * who needs every word goes.
 */
export const auditReason = (text: string): string => {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length <= AUDIT_REASON_LIMIT
    ? normalized
    : `${normalized.slice(0, AUDIT_REASON_LIMIT - 1)}…`
}

/**
 * An address fit to store, or nothing.
 *
 * The credential paths record no request labels because their caller is not
 * yet anybody, and an address typed into a sign-in form is exactly such a
 * caller's text. So it is stored only when it parses as an address: a string
 * that does not is recorded as nothing at all rather than as whatever was sent.
 */
export const auditEmail = (value: string): string | undefined => {
  const normalized = value.trim().toLowerCase()
  return email.safeParse(normalized).success ? normalized : undefined
}

/** The label every reason field shares, so the screen reads one word for it. */
export const REASON_FIELD: AuditFieldSpec = { label: 'Reason', kind: 'REASON' }
export const VERSION_FIELD: AuditFieldSpec = { label: 'Version', kind: 'COUNT' }
export const REASON_CATEGORY_FIELD: AuditFieldSpec = { label: 'Reason category', kind: 'ID' }

/** The payload of an action that has nothing to add beyond its row. */
export const empty = z.strictObject({})
