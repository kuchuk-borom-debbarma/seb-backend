/**
 * Authentication use cases. This module owns validation and workflow decisions;
 * cryptographic primitives and SQL details remain in their focused modules.
 */
import { z } from 'zod'
import { sendEmail } from '../../external-notification'
import { clearSessionCookie, readSessionToken, setSessionCookie } from '../cookies'
import {
  createChallengeToken,
  createDigest,
  createOtp,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from '../crypto'
import {
  createApplicantFromSignupPair,
  createApplicantSession,
  createSignupPair,
  deleteAllApplicantSessions,
  deleteApplicantSession,
  deleteApplicantSessionByDigest,
  deleteExpiredAuthenticationState,
  deleteOtherApplicantSessions,
  deleteSignupPair,
  deleteSignupPairsForEmail,
  findApplicantByEmail,
  findApplicantSessionByDigest,
  findSignupPair,
  listApplicantSessions,
  consumeWrongOtpAttempt,
  type ApplicantRecord,
  type PublicApplicantRecord,
  type PublicSessionRecord,
  type SessionRecord,
  type SignupPairRecord,
} from '../queries/auth'
import type {
  Applicant,
  ApplicantAuthResponse,
  ApplicantSession,
  AuthOperationContext,
  AuthResult,
  StartApplicantSignupResponse,
} from '../types'

const CHALLENGE_TTL_MS = 10 * 60 * 1_000
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
// Role is never accepted from a client-controlled GraphQL input.
const APPLICANT_ROLE = 'APPLICANT' as const
// The same message is returned for new and existing email addresses.
const START_SIGNUP_MESSAGE =
  'If this email can be registered, a verification code has been sent.'
const INVALID_CHALLENGE_MESSAGE = 'The verification code is invalid or has expired.'
const AUTH_REQUIRED_MESSAGE = 'Applicant authentication is required.'

const emailSchema = z.email()
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const otpSchema = z.string().regex(/^\d{6}$/u)
const passwordSchema = z.string().min(8).max(128)

const success = <T>(response: T, message: string | null = null): AuthResult<T> => ({
  success: true,
  message,
  response,
})

const failure = <T>(message: string): AuthResult<T> => ({
  success: false,
  message,
  response: null,
})

const requireSecret = (context: AuthOperationContext): string => {
  const secret = context.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is required.')
  if (new TextEncoder().encode(secret).length < 32) {
    throw new Error('AUTH_SECRET must contain at least 32 bytes.')
  }
  return secret
}

const attemptsFromEnvironment = (context: AuthOperationContext): number => {
  const configured = context.env.APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT
  if (configured === undefined || configured.trim() === '') return 5

  const parsed = Number(configured)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT must be an integer from 1 to 20.')
  }
  return parsed
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const toApplicant = (value: PublicApplicantRecord): Applicant => ({
  id: value.id,
  email: value.email,
  emailVerified: value.emailVerified,
  role: APPLICANT_ROLE,
  createdAt: value.createdAt,
})

const toApplicantSession = (
  value: PublicSessionRecord,
  currentSessionId: string,
): ApplicantSession => ({
  id: value.id,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
  expiresAt: value.expiresAt,
  ipAddress: value.ipAddress,
  userAgent: value.userAgent,
  current: value.id === currentSessionId,
})

const getCurrentSession = async (context: AuthOperationContext) => {
  const token = readSessionToken(context.requestHeaders)
  if (!token) return null

  const tokenDigest = await createDigest(requireSecret(context), 'applicant-session', token)
  const now = new Date()
  // One joined query verifies expiry and returns public applicant/session data.
  const current = await findApplicantSessionByDigest(context.db, tokenDigest, now)
  // A stale or forged cookie is actively expired in the browser.
  if (!current) clearSessionCookie(context)
  return current
}

/** Creates one independent challenge without revealing existing accounts. */
export const startApplicantSignup = async (
  input: { email: string },
  context: AuthOperationContext,
): Promise<AuthResult<StartApplicantSignupResponse>> => {
  const email = normalizeEmail(input.email)
  if (!emailSchema.safeParse(email).success) return failure('Enter a valid email address.')

  const secret = requireSecret(context)
  const now = Date.now()
  const expiresAt = now + CHALLENGE_TTL_MS
  const challengeToken = createChallengeToken()
  const response = { challengeToken, expiresAt: new Date(expiresAt) }

  const id = crypto.randomUUID()
  const otp = createOtp()
  const pairCreated = await createSignupPair(context.db, {
    id,
    email,
    challengeDigest: await createDigest(secret, 'applicant-signup-challenge', challengeToken),
    otpDigest: await createDigest(secret, `applicant-signup-otp:${id}`, otp),
    expiresAt,
    attemptsRemaining: attemptsFromEnvironment(context),
    createdAt: now,
  })
  // Existing applicants receive an unstored decoy challenge with the same shape.
  if (!pairCreated) return success(response, START_SIGNUP_MESSAGE)

  try {
    await sendEmail({
      to: email,
      subject: 'Your applicant signup code',
      text: `Your applicant signup code is ${otp}. It expires in 10 minutes.`,
    })
  } catch (error) {
    // Delivery and storage behave as one logical operation: an undelivered OTP
    // must not leave a valid challenge behind.
    await deleteSignupPair(context.db, id)
    console.error('Applicant signup notification failed', error)
    return failure('The verification code could not be sent. Please try again.')
  }

  return success(response, START_SIGNUP_MESSAGE)
}

const findActiveSignupPair = async (
  challengeToken: string,
  context: AuthOperationContext,
  secret: string,
  now: number,
): Promise<SignupPairRecord | null> => {
  const challengeDigest = await createDigest(
    secret,
    'applicant-signup-challenge',
    challengeToken,
  )
  const pair = await findSignupPair(context.db, challengeDigest)
  return pair && pair.expiresAt > now ? pair : null
}

const signupOtpDigest = (
  pair: SignupPairRecord,
  otp: string,
  secret: string,
): Promise<string> => createDigest(secret, `applicant-signup-otp:${pair.id}`, otp)

const unavailableSignup = async (
  context: AuthOperationContext,
  email: string,
): Promise<AuthResult<Applicant>> => {
  await deleteSignupPairsForEmail(context.db, email)
  return failure('This signup can no longer be completed.')
}

/** Verifies one pair and lets D1's unique email constraint choose a race winner. */
export const verifyApplicantSignup = async (
  input: { challengeToken: string; otp: string; password: string },
  context: AuthOperationContext,
): Promise<AuthResult<Applicant>> => {
  // Invalid passwords never read or mutate the supplied challenge.
  if (!passwordSchema.safeParse(input.password).success) {
    return failure('Password must contain between 8 and 128 characters.')
  }
  if (
    !challengeSchema.safeParse(input.challengeToken).success ||
    !otpSchema.safeParse(input.otp).success
  ) {
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  const secret = requireSecret(context)
  const now = Date.now()
  const pair = await findActiveSignupPair(input.challengeToken, context, secret, now)
  if (!pair) return failure(INVALID_CHALLENGE_MESSAGE)

  const submittedOtpDigest = await signupOtpDigest(pair, input.otp, secret)
  if (submittedOtpDigest !== pair.otpDigest) {
    await consumeWrongOtpAttempt(context.db, pair.id, now)
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  const createdAt = new Date()
  // Hash before the authoritative D1 write. If concurrent wrong attempts exhaust
  // the pair during scrypt, the guarded INSERT below sees that and creates nothing.
  const newApplicant: ApplicantRecord = {
    id: crypto.randomUUID(),
    email: pair.email,
    passwordHash: await hashPassword(input.password),
    emailVerified: true,
    role: APPLICANT_ROLE,
    createdAt,
    updatedAt: createdAt,
  }

  const created = await createApplicantFromSignupPair(
    context.db,
    { applicant: newApplicant, pair, submittedOtpDigest, now },
  )
  if (!created) {
    if (await findApplicantByEmail(context.db, pair.email)) {
      return unavailableSignup(context, pair.email)
    }
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  return success(toApplicant(newApplicant))
}

/** Verifies a password and creates a seven-day opaque D1 session. */
export const signInApplicant = async (
  input: { email: string; password: string },
  context: AuthOperationContext,
): Promise<AuthResult<ApplicantAuthResponse>> => {
  const email = normalizeEmail(input.email)
  if (!emailSchema.safeParse(email).success || !passwordSchema.safeParse(input.password).success) {
    return failure('Invalid email or password.')
  }

  const applicant = await findApplicantByEmail(context.db, email)
  // Unknown emails use the same scrypt work factor to reduce timing-based account
  // discovery. The final message is generic for every credential failure.
  const passwordMatches = await verifyPassword(
    applicant?.passwordHash ?? DUMMY_PASSWORD_HASH,
    input.password,
  )
  if (!applicant || !passwordMatches || !applicant.emailVerified) {
    return failure('Invalid email or password.')
  }

  const token = createChallengeToken()
  const now = new Date()
  const session: SessionRecord = {
    id: crypto.randomUUID(),
    applicantId: applicant.id,
    tokenDigest: await createDigest(requireSecret(context), 'applicant-session', token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
    updatedAt: now,
    ipAddress: context.requestHeaders.get('CF-Connecting-IP'),
    userAgent: context.requestHeaders.get('User-Agent'),
  }
  await createApplicantSession(context.db, session)
  setSessionCookie(context, token)

  return success({
    applicant: toApplicant(applicant),
    session: toApplicantSession(session, session.id),
  })
}

/** Signed-out callers receive success with a nullable response. */
export const currentApplicantSession = async (
  context: AuthOperationContext,
): Promise<AuthResult<ApplicantAuthResponse>> => {
  const current = await getCurrentSession(context)
  if (!current) return { success: true, message: null, response: null }

  return success({
    applicant: toApplicant(current.applicant),
    session: toApplicantSession(current.session, current.session.id),
  })
}

/** Lists active sessions without ever selecting or exposing token digests. */
export const applicantSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ sessions: ApplicantSession[] }>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  const sessions = await listApplicantSessions(context.db, current.applicant.id, new Date())
  return success({
    sessions: sessions.map((session) => toApplicantSession(session, current.session.id)),
  })
}

/** Hard-deletes the current row and expires the browser cookie. */
export const signOutApplicant = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const token = readSessionToken(context.requestHeaders)
  if (token) {
    const digest = await createDigest(requireSecret(context), 'applicant-session', token)
    await deleteApplicantSessionByDigest(context.db, digest)
  }
  clearSessionCookie(context)
  return success({ value: true })
}

export const revokeApplicantSession = async (
  sessionId: string,
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  // Ownership is part of the DELETE predicate, so another applicant's public
  // session ID can never be revoked through this operation.
  const deleted = await deleteApplicantSession(context.db, sessionId, current.applicant.id)
  if (!deleted) return failure('The session was not found.')
  if (sessionId === current.session.id) clearSessionCookie(context)
  return success({ value: true })
}

export const revokeOtherApplicantSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  await deleteOtherApplicantSessions(context.db, current.applicant.id, current.session.id)
  return success({ value: true })
}

export const revokeAllApplicantSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  await deleteAllApplicantSessions(context.db, current.applicant.id)
  clearSessionCookie(context)
  return success({ value: true })
}

/** Bulk expiry cleanup runs from the Worker cron, never from public requests. */
export const cleanupExpiredAuthentication = (
  db: AuthOperationContext['db'],
  now = new Date(),
): Promise<void> => deleteExpiredAuthenticationState(db, now)
