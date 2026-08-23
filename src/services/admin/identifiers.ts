/**
 * The identifiers a reviewer reads off the documents in front of them.
 *
 * A desk review used to record only `PASS`, `FAIL` or `NOT_APPLICABLE` against
 * each check. That is an attestation with nothing behind it: "I saw a valid
 * Scheduled Tribe certificate" cannot afterwards be asked *which* certificate,
 * and so cannot be asked whether the same one was used on another application.
 * Nothing in this programme captured a single identity number, so the only
 * duplicate guard that existed was a unique index on an enterprise's GSTIN —
 * which an unregistered enterprise does not have.
 *
 * Transcribing turns the attestation into evidence. The number the reviewer
 * types is the number on the document, and it becomes a key the database can
 * answer questions about.
 *
 * ## Why some of these are hashed and some are not
 *
 * A certificate number and a company registration number are references to
 * public instruments. An Aadhaar number and a bank account are not: they are
 * the most sensitive things this system would ever hold, and holding them in
 * the clear would make the database worth stealing for its own sake. Those two
 * are stored as a keyed digest and never rendered back — the reviewer confirms
 * against the last four digits, which is what a person can check by eye.
 *
 * The digest is keyed rather than plain because the input space is small enough
 * to exhaust: twelve digits is 10^12, which is an afternoon. A plain SHA-256
 * column would be a lookup table, not a protection.
 */
import type { AppBindings } from '../../bindings'
import type { deskReviewIdentifierKinds } from '../../db/schema'

/** What a transcribed value is. Named once, by the schema that stores it. */
export type IdentifierKind = (typeof deskReviewIdentifierKinds)[number]

/**
 * Which kinds are stored as a keyed digest rather than as typed.
 *
 * Held as data rather than as a branch so that adding a kind forces a decision
 * about it here, in the one place the decision is visible.
 */
const HASHED = new Set<IdentifierKind>(['IDENTITY_DOCUMENT', 'BANK_ACCOUNT'])

/**
 * The check each identifier is the evidence for.
 *
 * A reviewer who passes a check has read the document; the number is what they
 * read. A check that is failed or does not apply asks for nothing, because
 * there is nothing they are attesting to have seen.
 */
export const IDENTIFIER_FOR_CHECK = {
  ST_ELIGIBILITY: 'ST_CERTIFICATE',
  IDENTITY_KYC: 'IDENTITY_DOCUMENT',
  DOCUMENT_COMPLETENESS: 'BANK_ACCOUNT',
} as const satisfies Record<string, IdentifierKind>

/**
 * Reduces a typed value to what two people reading the same document would
 * both produce.
 *
 * Case and separators are how a document is laid out, not what it says: an ST
 * certificate written `tr/st/2019-004471` and `TR-ST-2019-004471` is one
 * certificate, and a duplicate check that missed that would be worse than
 * useless — it would report a clean file and be believed.
 *
 * Returns `null` for anything that is not a plausible identifier, so a reviewer
 * cannot satisfy the requirement with a space or a dash.
 */
export const normalizeIdentifier = (value: string): string | null => {
  const stripped = value.toUpperCase().replace(/[^A-Z0-9]/gu, '')
  return stripped.length >= 4 && stripped.length <= 64 ? stripped : null
}

/** The digits a reviewer can check by eye against the document. */
export const lastFourOf = (normalized: string): string => normalized.slice(-4)

/**
 * The comparable form of a bank destination.
 *
 * Account number and branch code identify a destination only together — the
 * same account number at two banks is two accounts — so they are folded into
 * one value rather than compared separately.
 */
export const bankDestination = (account: string, ifsc: string): string | null => {
  const left = normalizeIdentifier(account)
  const right = normalizeIdentifier(ifsc)
  return left && right ? `${right}:${left}` : null
}

const requireIdentifierSecret = (env: AppBindings): string => {
  const secret = env.IDENTIFIER_SECRET
  if (!secret) throw new Error('IDENTIFIER_SECRET is required.')
  if (new TextEncoder().encode(secret).length < 32) {
    throw new Error('IDENTIFIER_SECRET must contain at least 32 bytes.')
  }
  return secret
}

/**
 * The stored form of a normalized value.
 *
 * Kinds that are not hashed are stored as they compare, so a reviewer can be
 * shown the certificate number they entered. Hashed kinds return a digest that
 * nothing can reverse.
 *
 * **The key cannot be rotated on its own.** Every stored digest was made with
 * it, so a new key silently stops matching everything already recorded and the
 * duplicate check would quietly pass everything. Rotating means re-transcribing,
 * which means asking people to read every document again — so treat this as a
 * value that is set once.
 */
export const storedValue = async (
  kind: IdentifierKind,
  normalized: string,
  env: AppBindings,
): Promise<string> => {
  if (!HASHED.has(kind)) return normalized
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(requireIdentifierSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${kind}:${normalized}`),
  )
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
