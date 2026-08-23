/**
 * Role invitations that exist only in the link.
 *
 * An administrator picks somebody and a role; that person gets an email with a
 * link; opening it exchanges their applicant grant for the staff role. Nothing
 * about the invitation is written down — the whole thing travels sealed inside
 * the URL and is opened again here.
 *
 * ## Why AES-GCM and not a cipher on its own
 *
 * The payload has to be *tamper-evident*, not merely unreadable. An
 * unauthenticated ciphertext is malleable: somebody holding a link to
 * `REVIEWER` could flip bits and watch what came out, and a stream cipher would
 * let them change the role without ever decrypting it. GCM authenticates as it
 * decrypts, so any modified byte fails instead of producing a different
 * invitation.
 *
 * Encryption rather than a signature because the payload also should not be
 * readable: a signed-but-plain token would put the invitee's email address and
 * the issuer's user id into a URL that ends up in mail archives.
 *
 * ## Why nothing is stored, and how that stays safe
 *
 * A stateless token cannot be marked as used. Instead the *precondition* is
 * what expires it: acceptance requires that the person still holds `APPLICANT`
 * and does not yet hold the target role. Once accepted, neither is true, so a
 * replayed link is refused by the same check that authorized the first one. See
 * `controllers/access.ts` for the acceptance sequence and the concurrency guard
 * behind it.
 */
import type { UserRole } from '../../db/schema'

/** Long enough to survive a weekend, short enough to be worth reissuing. */
export const INVITE_TTL_MS = 48 * 60 * 60 * 1_000

/**
 * The sealed contents.
 *
 * `email` is carried so acceptance can check the address has not changed since
 * the invitation was sent. If it has, the invitation is void — the mailbox that
 * received it is no longer the account's.
 */
export type RoleInvite = {
  version: 1
  userId: string
  email: string
  role: UserRole
  issuerId: string
  issuedAt: number
  expiresAt: number
  /** Makes two invitations with identical contents seal differently. */
  nonce: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** GCM's standard nonce length. Never reused, because it is random per seal. */
const IV_BYTES = 12

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/**
 * Derives the sealing key from the configured secret.
 *
 * SHA-256 of the secret rather than the secret's raw bytes, so any configured
 * length produces the 256 bits AES-GCM needs instead of failing for a secret
 * that is merely the wrong size.
 */
const sealingKey = async (secret: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Reads the configured secret, refusing one too short to be worth sealing with. */
export const requireInviteSecret = (secret: string | undefined): string => {
  if (!secret || encoder.encode(secret).length < 32) {
    throw new Error('ROLE_INVITE_SECRET must contain at least 32 bytes.')
  }
  return secret
}

/** Seals an invitation into the opaque string that travels in the link. */
export const sealInvite = async (
  secret: string,
  invite: RoleInvite,
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await sealingKey(secret),
    encoder.encode(JSON.stringify(invite)),
  )
  // The nonce is not a secret and has to travel with what it sealed.
  const payload = new Uint8Array(iv.length + sealed.byteLength)
  payload.set(iv)
  payload.set(new Uint8Array(sealed), iv.length)
  return toBase64Url(payload)
}

/**
 * Opens an invitation, or returns `null` for anything that is not one.
 *
 * Every failure returns the same `null`: wrong key, altered bytes, truncated
 * payload, unparseable contents, wrong shape. A caller that distinguished them
 * would let somebody probe which tokens are structurally valid, and there is
 * nothing a legitimate holder does with that answer.
 *
 * Expiry is checked here too, so no caller can forget to.
 */
export const openInvite = async (
  secret: string,
  token: string,
  now: Date,
): Promise<RoleInvite | null> => {
  try {
    const payload = fromBase64Url(token)
    if (payload.length <= IV_BYTES) return null
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.slice(0, IV_BYTES) },
      await sealingKey(secret),
      payload.slice(IV_BYTES),
    )
    const parsed: unknown = JSON.parse(decoder.decode(opened))
    return isRoleInvite(parsed) && parsed.expiresAt > now.getTime() ? parsed : null
  } catch {
    return null
  }
}

const isRoleInvite = (value: unknown): value is RoleInvite => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RoleInvite>
  return (
    candidate.version === 1 &&
    typeof candidate.userId === 'string' &&
    typeof candidate.email === 'string' &&
    typeof candidate.role === 'string' &&
    typeof candidate.issuerId === 'string' &&
    Number.isSafeInteger(candidate.issuedAt) &&
    Number.isSafeInteger(candidate.expiresAt) &&
    typeof candidate.nonce === 'string'
  )
}
