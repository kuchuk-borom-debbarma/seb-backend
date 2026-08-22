import type { AuthOperationContext } from './types'

const SESSION_COOKIE_NAME = 'seb_session'
// The applicant-era name is no longer written or read, but a browser that still
// holds one would keep sending it forever. Clearing expires it alongside the
// current cookie; remove this once no deployed environment can still have one.
const SUPERSEDED_SESSION_COOKIE_NAMES = ['seb_applicant_session'] as const

/** Builds attributes shared by cookie creation and deletion. */
const cookieAttributes = (context: AuthOperationContext): string[] => {
  const url = new URL(context.requestUrl)
  const sameSite = (context.env.AUTH_COOKIE_SAME_SITE ?? 'lax').trim().toLowerCase()

  if (sameSite !== 'lax' && sameSite !== 'none') {
    throw new Error('AUTH_COOKIE_SAME_SITE must be either "lax" or "none".')
  }
  if (sameSite === 'none' && url.protocol !== 'https:') {
    throw new Error('AUTH_COOKIE_SAME_SITE=none requires HTTPS.')
  }

  const attributes = ['Path=/', 'HttpOnly', `SameSite=${sameSite === 'none' ? 'None' : 'Lax'}`]
  if (url.protocol === 'https:') attributes.push('Secure')
  return attributes
}

export const readSessionToken = (headers: Headers): string | null => {
  const cookieHeader = headers.get('cookie')
  if (!cookieHeader) return null

  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 0) continue
    if (entry.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      return entry.slice(separator + 1).trim() || null
    }
  }
  return null
}

export const setSessionCookie = (context: AuthOperationContext, token: string): void => {
  // Max-Age and Expires are intentionally omitted, making this a browser-session cookie.
  context.responseHeaders.append(
    'set-cookie',
    [`${SESSION_COOKIE_NAME}=${token}`, ...cookieAttributes(context)].join('; '),
  )
}

export const clearSessionCookie = (context: AuthOperationContext): void => {
  const attributes = cookieAttributes(context)
  // Deletion repeats Path, Secure, and SameSite so the browser targets exactly
  // the cookie created by `setSessionCookie`.
  for (const name of [SESSION_COOKIE_NAME, ...SUPERSEDED_SESSION_COOKIE_NAMES]) {
    context.responseHeaders.append(
      'set-cookie',
      [
        `${name}=`,
        ...attributes,
        'Max-Age=0',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ].join('; '),
    )
  }
}
