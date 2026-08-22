/**
 * Authentication use cases. This module owns validation and workflow decisions;
 * cryptographic primitives and SQL details remain in their focused modules.
 */
import { z } from 'zod'
import { auditActions } from '../../../db/schema'
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
  cancelSignupChallengesForEmail,
  cleanupExpiredAuthenticationState,
  consumeWrongOtpAttempt,
  createAuditEvent,
  createSignupChallenge,
  createUserFromSignupChallenge,
  createApplicantSession,
  deleteAllUserSessions,
  deleteOtherUserSessions,
  deleteUserSession,
  deleteUserSessionByDigest,
  findActiveApplicantByEmail,
  findSignupChallenge,
  findUserByEmail,
  findUserSessionByDigest,
  listUserSessions,
  markSignupChallengeDeliveryFailed,
  type AuditEventRecord,
  type PublicUserRecord,
  type PublicSessionRecord,
  type SessionRecord,
  type SignupChallengeRecord,
  type UserRecord,
  type UserRoleGrantRecord,
} from '../queries/auth'
import type {
  Applicant,
  ApplicantAuthResponse,
  ApplicantSession,
  AuthenticatedApplicantRequest,
  AuthenticatedUserRequest,
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

const toApplicant = (value: PublicUserRecord): Applicant => ({
  id: value.id,
  email: value.email,
  emailVerified: value.emailVerifiedAt !== null,
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

const getCurrentSession = async (
  context: AuthOperationContext,
): Promise<AuthenticatedUserRequest | null> => {
  const token = readSessionToken(context.requestHeaders)
  if (!token) return null

  const tokenDigest = await createDigest(requireSecret(context), 'applicant-session', token)
  const now = new Date()
  // One joined query verifies expiry and returns public applicant/session data.
  const current = await findUserSessionByDigest(context.db, tokenDigest, now)
  // A stale or forged cookie is actively expired in the browser.
  if (!current) clearSessionCookie(context)
  return current
}

const getCurrentApplicantSession = async (
  context: AuthOperationContext,
): Promise<AuthenticatedApplicantRequest | null> => {
  const current = await getCurrentSession(context)
  return current?.roles.includes(APPLICANT_ROLE) ? current : null
}

/** Applicant primitive requiring a current, active APPLICANT role grant. */
export const authenticatedApplicant = (
  context: AuthOperationContext,
): Promise<AuthenticatedApplicantRequest | null> => getCurrentApplicantSession(context)

/**
 * Builds one allow-listed audit record from request metadata. Callers provide
 * only public IDs and small, explicitly safe metadata objects.
 */
const auditEvent = (
  context: AuthOperationContext,
  input: {
    action: (typeof auditActions)[keyof typeof auditActions]
    entityType:
      | 'CORE_USER'
      | 'CORE_USER_ROLE_GRANT'
      | 'CORE_SESSION'
      | 'CORE_SIGNUP_CHALLENGE'
    entityId?: string | null
    actorUserId?: string | null
    outcome?: 'SUCCESS' | 'FAILURE'
    metadata?: Record<string, string | number | boolean | null>
    createdAt?: Date
  },
): AuditEventRecord => ({
  id: crypto.randomUUID(),
  actorUserId: input.actorUserId ?? null,
  action: input.action,
  entityType: input.entityType,
  entityId: input.entityId ?? null,
  outcome: input.outcome ?? 'SUCCESS',
  requestId:
    context.requestHeaders.get('CF-Ray') ?? context.requestHeaders.get('X-Request-ID'),
  ipAddress: context.requestHeaders.get('CF-Connecting-IP'),
  userAgent: context.requestHeaders.get('User-Agent'),
  changesJson: null,
  metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  createdAt: input.createdAt ?? new Date(),
})

/** Creates one independent challenge without revealing existing accounts. */
export const startApplicantSignup = async (
  input: { email: string },
  context: AuthOperationContext,
): Promise<AuthResult<StartApplicantSignupResponse>> => {
  const email = normalizeEmail(input.email)
  if (!emailSchema.safeParse(email).success) return failure('Enter a valid email address.')

  const secret = requireSecret(context)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS)
  const challengeToken = createChallengeToken()
  const response = { challengeToken, expiresAt }

  const id = crypto.randomUUID()
  const otp = createOtp()
  const challenge: SignupChallengeRecord = {
    id,
    email,
    challengeDigest: await createDigest(secret, 'applicant-signup-challenge', challengeToken),
    otpDigest: await createDigest(secret, `applicant-signup-otp:${id}`, otp),
    expiresAt,
    attemptsRemaining: attemptsFromEnvironment(context),
    status: 'PENDING',
    consumedByUserId: null,
    invalidatedAt: null,
    invalidationReason: null,
    createdAt: now,
    updatedAt: now,
  }
  const challengeCreated = await createSignupChallenge(
    context.db,
    challenge,
    auditEvent(context, {
      action: auditActions.signupChallengeCreated,
      entityType: 'CORE_SIGNUP_CHALLENGE',
      entityId: id,
      createdAt: now,
    }),
  )
  // Existing applicants receive an unstored decoy challenge with the same shape.
  if (!challengeCreated) return success(response, START_SIGNUP_MESSAGE)

  try {
    await sendEmail({
      to: email,
      subject: 'Your applicant signup code',
      text: `Your applicant signup code is ${otp}. It expires in 10 minutes.`,
    })
  } catch (error) {
    // An undelivered OTP remains auditable but is immediately made unusable.
    const failedAt = new Date()
    await markSignupChallengeDeliveryFailed(
      context.db,
      id,
      failedAt,
      auditEvent(context, {
        action: auditActions.signupNotificationFailed,
        entityType: 'CORE_SIGNUP_CHALLENGE',
        entityId: id,
        outcome: 'FAILURE',
        createdAt: failedAt,
      }),
    )
    console.error('Applicant signup notification failed', error)
    return failure('The verification code could not be sent. Please try again.')
  }

  return success(response, START_SIGNUP_MESSAGE)
}

const findActiveSignupChallenge = async (
  challengeToken: string,
  context: AuthOperationContext,
  secret: string,
  now: Date,
): Promise<SignupChallengeRecord | null> => {
  const challengeDigest = await createDigest(
    secret,
    'applicant-signup-challenge',
    challengeToken,
  )
  const challenge = await findSignupChallenge(context.db, challengeDigest)
  return challenge &&
    challenge.status === 'PENDING' &&
    challenge.attemptsRemaining > 0 &&
    challenge.expiresAt.getTime() > now.getTime()
    ? challenge
    : null
}

const signupOtpDigest = (
  challenge: SignupChallengeRecord,
  otp: string,
  secret: string,
): Promise<string> => createDigest(secret, `applicant-signup-otp:${challenge.id}`, otp)

const unavailableSignup = async (
  context: AuthOperationContext,
  email: string,
): Promise<AuthResult<Applicant>> => {
  await cancelSignupChallengesForEmail(context.db, email, new Date())
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
  const now = new Date()
  const challenge = await findActiveSignupChallenge(input.challengeToken, context, secret, now)
  if (!challenge) return failure(INVALID_CHALLENGE_MESSAGE)

  const submittedOtpDigest = await signupOtpDigest(challenge, input.otp, secret)
  if (submittedOtpDigest !== challenge.otpDigest) {
    await consumeWrongOtpAttempt(
      context.db,
      challenge.id,
      now,
      auditEvent(context, {
        action: auditActions.otpFailed,
        entityType: 'CORE_SIGNUP_CHALLENGE',
        entityId: challenge.id,
        outcome: 'FAILURE',
        createdAt: now,
      }),
    )
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  const createdAt = new Date()
  // Hash before the authoritative D1 write. If concurrent wrong attempts exhaust
  // the pair during scrypt, the guarded INSERT below sees that and creates nothing.
  const newUser: UserRecord = {
    id: crypto.randomUUID(),
    email: challenge.email,
    passwordHash: await hashPassword(input.password),
    emailVerifiedAt: createdAt,
    rowVersion: 1,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedByUserId: null,
    deleteReason: null,
  }
  const applicantRoleGrant: UserRoleGrantRecord = {
    id: crypto.randomUUID(),
    userId: newUser.id,
    role: APPLICANT_ROLE,
    grantedByUserId: null,
    grantReason: 'VERIFIED_APPLICANT_SIGNUP',
    grantedAt: createdAt,
    revokedByUserId: null,
    revokedAt: null,
    revocationReason: null,
  }

  const created = await createUserFromSignupChallenge(context.db, {
    user: newUser,
    roleGrant: applicantRoleGrant,
    challenge,
    submittedOtpDigest,
    now,
    auditEvent: auditEvent(context, {
      action: auditActions.userCreated,
      entityType: 'CORE_USER',
      entityId: newUser.id,
      createdAt,
    }),
    roleAuditEvent: auditEvent(context, {
      action: auditActions.roleGranted,
      entityType: 'CORE_USER_ROLE_GRANT',
      entityId: applicantRoleGrant.id,
      metadata: { userId: newUser.id, role: APPLICANT_ROLE },
      createdAt,
    }),
  })
  if (!created) {
    if (await findUserByEmail(context.db, challenge.email)) {
      return unavailableSignup(context, challenge.email)
    }
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  return success(toApplicant(newUser))
}

/** Verifies a password and creates a seven-day opaque D1 session. */
export const signInApplicant = async (
  input: { email: string; password: string },
  context: AuthOperationContext,
): Promise<AuthResult<ApplicantAuthResponse>> => {
  const email = normalizeEmail(input.email)
  if (!emailSchema.safeParse(email).success || !passwordSchema.safeParse(input.password).success) {
    // Validation failures are still authentication failures worth auditing. No
    // user is authenticated at this point, and credentials never enter the log.
    await createAuditEvent(
      context.db,
      auditEvent(context, {
        action: auditActions.signInFailed,
        entityType: 'CORE_USER',
        outcome: 'FAILURE',
      }),
    )
    return failure('Invalid email or password.')
  }

  const user = await findActiveApplicantByEmail(context.db, email)
  // Unknown emails use the same scrypt work factor to reduce timing-based account
  // discovery. The final message is generic for every credential failure.
  const passwordMatches = await verifyPassword(
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    input.password,
  )
  if (!user || !passwordMatches || user.emailVerifiedAt === null) {
    await createAuditEvent(
      context.db,
      auditEvent(context, {
        action: auditActions.signInFailed,
        entityType: 'CORE_USER',
        entityId: user?.id,
        // Supplying a user's email does not authenticate the caller as that
        // user. The target may be recorded as the entity, but actor stays null.
        outcome: 'FAILURE',
      }),
    )
    return failure('Invalid email or password.')
  }

  const token = createChallengeToken()
  const now = new Date()
  const session: SessionRecord = {
    id: crypto.randomUUID(),
    userId: user.id,
    tokenDigest: await createDigest(requireSecret(context), 'applicant-session', token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
    updatedAt: now,
    ipAddress: context.requestHeaders.get('CF-Connecting-IP'),
    userAgent: context.requestHeaders.get('User-Agent'),
  }
  const sessionCreated = await createApplicantSession(
    context.db,
    session,
    auditEvent(context, {
      action: auditActions.signInSucceeded,
      entityType: 'CORE_SESSION',
      entityId: session.id,
      actorUserId: user.id,
      createdAt: now,
    }),
  )
  if (!sessionCreated) {
    // A role revocation or user deletion that wins during password hashing must
    // also win sign-in. Do not set a cookie or report a successful session from
    // the stale credential read.
    await createAuditEvent(
      context.db,
      auditEvent(context, {
        action: auditActions.signInFailed,
        entityType: 'CORE_USER',
        entityId: user.id,
        outcome: 'FAILURE',
      }),
    )
    return failure('Invalid email or password.')
  }
  setSessionCookie(context, token)

  return success({
    applicant: toApplicant(user),
    session: toApplicantSession(session, session.id),
  })
}

/** Signed-out callers receive success with a nullable response. */
export const currentApplicantSession = async (
  context: AuthOperationContext,
): Promise<AuthResult<ApplicantAuthResponse>> => {
  const current = await getCurrentApplicantSession(context)
  if (!current) return { success: true, message: null, response: null }

  return success({
    applicant: toApplicant(current.user),
    session: toApplicantSession(current.session, current.session.id),
  })
}

/** Lists active sessions without ever selecting or exposing token digests. */
export const applicantSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ sessions: ApplicantSession[] }>> => {
  const current = await getCurrentApplicantSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  const sessions = await listUserSessions(context.db, current.user.id, new Date())
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
    const current = await findUserSessionByDigest(context.db, digest, new Date())
    if (current) {
      await deleteUserSessionByDigest(
        context.db,
        digest,
        auditEvent(context, {
          action: auditActions.signedOut,
          entityType: 'CORE_SESSION',
          entityId: current.session.id,
          actorUserId: current.user.id,
        }),
      )
    }
  }
  clearSessionCookie(context)
  return success({ value: true })
}

export const revokeApplicantSession = async (
  sessionId: string,
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentApplicantSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  // Ownership is part of the DELETE predicate, so another applicant's public
  // session ID can never be revoked through this operation.
  const deleted = await deleteUserSession(
    context.db,
    sessionId,
    current.user.id,
    auditEvent(context, {
      action: auditActions.sessionRevoked,
      entityType: 'CORE_SESSION',
      entityId: sessionId,
      actorUserId: current.user.id,
    }),
  )
  if (!deleted) return failure('The session was not found.')
  if (sessionId === current.session.id) clearSessionCookie(context)
  return success({ value: true })
}

export const revokeOtherApplicantSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentApplicantSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  await deleteOtherUserSessions(
    context.db,
    current.user.id,
    current.session.id,
    auditEvent(context, {
      action: auditActions.sessionsRevoked,
      entityType: 'CORE_USER',
      entityId: current.user.id,
      actorUserId: current.user.id,
      metadata: { scope: 'OTHER' },
    }),
  )
  return success({ value: true })
}

export const revokeAllApplicantSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentApplicantSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  await deleteAllUserSessions(
    context.db,
    current.user.id,
    auditEvent(context, {
      action: auditActions.sessionsRevoked,
      entityType: 'CORE_USER',
      entityId: current.user.id,
      actorUserId: current.user.id,
      metadata: { scope: 'ALL' },
    }),
  )
  clearSessionCookie(context)
  return success({ value: true })
}

/** Bulk expiry cleanup runs from the Worker cron, never from public requests. */
export const cleanupExpiredAuthentication = (
  db: AuthOperationContext['db'],
  now = new Date(),
): Promise<void> => cleanupExpiredAuthenticationState(db, now)
