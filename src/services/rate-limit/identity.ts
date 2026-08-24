/**
 * Turning a request into the values an allowance is counted against.
 *
 * Each dimension resolves to a string, or to null when this request cannot
 * offer one — an unauthenticated caller has no session, and only some
 * operations name a subject. A bucket whose dimension resolves to null is
 * **skipped**, not refused: there is nothing to count, and refusing would stop
 * signup from working at all.
 *
 * ## Two bypasses this file exists to close
 *
 * Both leave a limiter looking present while doing nothing.
 *
 * **Case in a subject key.** `A@B.com` and `a@b.com` are different strings, so
 * keying on raw input means changing case resets the allowance. The subject is
 * normalized with the same `normalizeEmail` the authentication service uses, so
 * the bucket matches the account rather than the spelling.
 *
 * **A session token used as a key.** The token is a credential. A limiter
 * stores its keys, so keying on the token would put credentials somewhere that
 * exists only to count. It is reduced to the same digest the session table
 * holds — stable per session, and useless to whoever reads it.
 */
import { readSessionToken } from '../auth/cookies'
import { sessionTokenDigest } from '../auth/crypto'
import { normalizeEmail } from '../auth/support'
import type { RateLimitDimension } from './types'

/**
 * The address a request came from.
 *
 * `CF-Connecting-IP` is the platform's own header and the only one worth
 * trusting: `X-Forwarded-For` arrives from the caller and can say anything,
 * so keying on it would let one attacker occupy as many buckets as they liked.
 *
 * Null when absent, which locally it always is.
 */
export const callerAddress = (headers: Headers): string | null =>
  headers.get('CF-Connecting-IP')?.trim() || null

/**
 * A stable, non-credential name for the caller's session.
 *
 * Null when nobody is signed in. Deliberately not the session's row id, which
 * would cost a database read on every request to learn something the cookie
 * already determines.
 */
const callerSession = async (
  headers: Headers,
  secret: string,
): Promise<string | null> => {
  const token = readSessionToken(headers)
  /*
   * No secret means no digest, and a raw token must never become a key. A
   * Worker without `AUTH_SECRET` cannot serve a session anyway, so this only
   * ever fires where nothing was going to be counted regardless.
   */
  if (!token || !secret) return null
  return sessionTokenDigest(secret, token)
}

/**
 * The account an operation is acting on, where it names one.
 *
 * Only sign-in and signup do, and both name it the same way: an `email` in the
 * operation's input. Returning null for everything else is what makes a
 * `SUBJECT` bucket on any other operation simply not apply.
 */
export const operationSubject = (argumentValues: unknown): string | null => {
  if (typeof argumentValues !== 'object' || argumentValues === null) return null
  const input = (argumentValues as { input?: unknown }).input
  const holder = typeof input === 'object' && input !== null ? input : argumentValues
  const email = (holder as { email?: unknown }).email
  return typeof email === 'string' && email.trim() ? normalizeEmail(email) : null
}

/**
 * Resolves every dimension for one request.
 *
 * `subject` is passed in rather than read here, because only the enforcement
 * point knows which operation is running and what it was given.
 */
export const requestIdentity = async (
  headers: Headers,
  secret: string,
  subject: string | null,
): Promise<Readonly<Record<RateLimitDimension, string | null>>> => ({
  IP: callerAddress(headers),
  SESSION: await callerSession(headers, secret),
  SUBJECT: subject,
})
