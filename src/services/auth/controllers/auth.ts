/**
 * Authentication use cases. This module owns validation and workflow decisions;
 * cryptographic primitives and SQL details remain in their focused modules.
 */
import { z } from 'zod'
import { auditActions } from '../../../db/schema'
import { notificationDelivery, sendNotification } from '../../external-notification'
import {
  holdsPermission,
  permissionsOf,
  type ActionOf,
  type Permission,
  type Resource,
} from '../permissions'
import { clearSessionCookie, readSessionToken, setSessionCookie } from '../cookies'
import {
  createChallengeToken,
  createDigest,
  createOtp,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  isValidBootstrapSecret,
  sessionTokenDigest,
  verifyConfiguredSecret,
  verifyPassword,
} from '../crypto'
import {
  cancelSignupChallengesForEmail,
  cleanupExpiredAuthenticationState,
  consumeWrongOtpAttempt,
  createAuditEvent,
  createSignupChallenge,
  createUserFromSignupChallenge,
  createUserSession,
  deleteAllUserSessions,
  deleteOtherUserSessions,
  deleteUserSession,
  deleteUserSessionByDigest,
  findActiveUserByEmail,
  findActiveUserRoles,
  findUserAuthority,
  findFirstSuperAdminCandidateByEmail,
  findSignupChallenge,
  findUserByEmail,
  findUserSessionByDigest,
  grantFirstSuperAdmin,
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
import {
  auditEvent,
  AUTH_REQUIRED_MESSAGE,
  normalizeEmail,
} from '../support'
import { failure, success } from '../../envelope'
import type {
  AuthenticatedAdministratorRequest,
  AuthenticatedApplicantRequest,
  AuthenticatedUserRequest,
  AuthOperationContext,
  AuthResponse,
  AuthResult,
  AuthSession,
  AuthUser,
  FirstSuperAdminBootstrapResponse,
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
const FIRST_SUPER_ADMIN_BOOTSTRAP_FAILURE =
  'First administrator bootstrap is unavailable or the supplied credentials are invalid.'
const FIRST_SUPER_ADMIN_ROLE = 'SUPER_ADMIN' as const
// Names both sides of the swap: the SUPER_ADMIN grant reason and the paired
// APPLICANT revocation reason.
const FIRST_SUPER_ADMIN_BOOTSTRAP_REASON = 'FIRST_SUPER_ADMIN_BOOTSTRAP'

const emailSchema = z.email()
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const otpSchema = z.string().regex(/^\d{6}$/u)
const passwordSchema = z.string().min(8).max(128)

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

/**
 * Bootstrap configuration is optional because it should be removed immediately
 * after use. Missing or malformed values simply close the curl-only endpoint;
 * callers never learn which configuration check failed.
 */
const firstSuperAdminConfiguration = (
  context: AuthOperationContext,
): { email: string; secret: string } | null => {
  const email = normalizeEmail(context.env.FIRST_SUPER_ADMIN_EMAIL ?? '')
  const secret = context.env.FIRST_SUPER_ADMIN_SECRET ?? ''
  if (!emailSchema.safeParse(email).success) return null
  if (!isValidBootstrapSecret(secret)) return null
  return { email, secret }
}

/**
 * Authority is supplied by the caller rather than read here so each response
 * uses the grants it already resolved. Reporting a fixed role would misdescribe
 * an administrator who holds no APPLICANT grant.
 */
const toAuthUser = (
  value: PublicUserRecord,
  authority: { roles: string[]; permissions: Permission[] },
): AuthUser => ({
  id: value.id,
  email: value.email,
  emailVerified: value.emailVerifiedAt !== null,
  displayName: value.displayName,
  roles: authority.roles,
  /*
   * Published so a client never has to reimplement the policy to decide which
   * navigation to draw. It still authorizes nothing: every operation re-checks
   * server-side, which is what actually refuses.
   *
   * Already expanded by whoever resolved the authority, so a super
   * administrator's list is the whole catalogue rather than an empty one.
   */
  permissions: authority.permissions,
  createdAt: value.createdAt,
})

const toAuthSession = (
  value: PublicSessionRecord,
  currentSessionId: string,
): AuthSession => ({
  id: value.id,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
  expiresAt: value.expiresAt,
  ipAddress: value.ipAddress,
  userAgent: value.userAgent,
  current: value.id === currentSessionId,
})

export const getCurrentSession = async (
  context: AuthOperationContext,
): Promise<AuthenticatedUserRequest | null> => {
  const token = readSessionToken(context.requestHeaders)
  if (!token) return null

  const tokenDigest = await sessionTokenDigest(requireSecret(context), token)
  const now = new Date()
  // One joined query verifies expiry and returns public user/session data.
  const current = await findUserSessionByDigest(context.db, tokenDigest, now)
  // A stale or forged cookie is actively expired in the browser.
  if (!current) {
    clearSessionCookie(context)
    return null
  }
  /*
   * Holding no *effective* grant is the same condition that refuses sign-in, so
   * an existing cookie must not outlive it either. Authority is joined live,
   * making this authoritative on the request after the final revocation.
   *
   * **Deliberately not "resolved no permissions".** A role with nothing on it
   * is a legitimate thing for an operator to create, and a half-finished one is
   * the ordinary state of a role being composed — so keying this on an empty
   * permission set would turn an editing slip into a mass sign-out of everybody
   * holding it. The question here is whether any grant still authorizes
   * anything at all, which is what `hasActiveRoleGrant` answers.
   */
  if (!current.hasEffectiveGrant) {
    // Refusing the request is not enough: the rows would survive until expiry
    // and start authenticating again the moment any role is granted back. The
    // scheduled cleanup sweeps accounts that never present a cookie at all.
    await deleteAllUserSessions(
      context.db,
      current.user.id,
      auditEvent(context, {
        action: auditActions.sessionsRevoked,
        entityType: 'CORE_USER',
        entityId: current.user.id,
        // The holder is deactivated, so they are the subject of this deletion
        // rather than its authority.
        actorUserId: null,
        metadata: { scope: 'ALL', reason: 'NO_ACTIVE_ROLE' },
      }),
    )
    clearSessionCookie(context)
    return null
  }
  /*
   * The wildcard is expanded once, here, where the set is built — rather than
   * as a branch inside the guard, which every future guard would have to
   * remember and the direction that mistake fails in is "too permissive".
   */
  return { ...current, permissions: permissionsOf(current) }
}

/**
 * Applicant primitive requiring a current, active APPLICANT role grant.
 *
 * Sign-in itself accepts any active role, so this narrower check is what keeps
 * applicant enterprise and application operations closed to an administrator
 * who holds no applicant grant.
 */
export const authenticatedApplicant = async (
  context: AuthOperationContext,
): Promise<AuthenticatedApplicantRequest | null> => {
  const current = await getCurrentSession(context)
  return current?.applicant ? current : null
}

/**
 * The guard every staff operation goes through.
 *
 * It asks what the caller needs to *do* rather than who they are. Authority is
 * data now — a super administrator composes roles out of the catalogue — so an
 * operation naming a role would be asserting something no file decides any
 * more, and would go on compiling after that role was retired.
 *
 * **The two arguments check against each other.** `ActionOf<'audit'>` is
 * `'read'`, so asking to award something on the audit history does not compile.
 * A guard that took one free-form string would let a typo through to run time,
 * where it reads as a permission nobody holds — a refusal with no cause anybody
 * can find.
 *
 * Somebody holding several roles gets the union of their permissions.
 */
export const authenticatedWithPermission = async <R extends Resource>(
  context: AuthOperationContext,
  resource: R,
  action: ActionOf<R>,
): Promise<AuthenticatedAdministratorRequest | null> => {
  const current = await getCurrentSession(context)
  return current && holdsPermission(current, resource, action) ? current : null
}

/**
 * The narrowest guard in the service: composing roles, and handing them out.
 *
 * Deliberately not a catalogue permission. A role able to grant roles could
 * grant `SUPER_ADMIN` to its own holder, and a role able to edit roles could
 * write that authority onto itself — either way an administrator who can create
 * administrators is a super administrator by another name. Leaving these out of
 * the catalogue entirely means the authority cannot be written down, so it
 * cannot be handed out by mistake.
 */
export const authenticatedSuperAdministrator = async (
  context: AuthOperationContext,
): Promise<AuthenticatedUserRequest | null> => {
  const current = await getCurrentSession(context)
  return current?.superAdministrator ? current : null
}

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
  const response = { challengeToken, expiresAt, delivery: notificationDelivery(context.env) }

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
    await sendNotification({
      to: email,
      subject: 'Your applicant signup code',
      body: `Your applicant signup code is ${otp}. It expires in 10 minutes.`,
    }, context.env)
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
    /*
     * Deliberately not logging the error object. A transport failure can carry
     * the request it was making — recipient, subject, and the code itself — and
     * these logs are readable in CI on a public repository. The audit row above
     * is the durable record; this line only says it happened.
     */
    console.error('Applicant signup notification failed')
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
): Promise<AuthResult<AuthUser>> => {
  await cancelSignupChallengesForEmail(context.db, email, new Date())
  return failure('This signup can no longer be completed.')
}

/** Verifies one pair and lets D1's unique email constraint choose a race winner. */
export const verifyApplicantSignup = async (
  input: { challengeToken: string; otp: string; password: string },
  context: AuthOperationContext,
): Promise<AuthResult<AuthUser>> => {
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
    // Nobody has said what they are called yet; signup asks for an address and
    // a password and nothing else.
    displayName: null,
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
    roleId: null,
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

  /*
   * APPLICANT is the only grant this transition creates, so the authority is
   * known without querying it back — and it carries no catalogue permission,
   * because applying for funding is not a staff act.
   */
  return success(toAuthUser(newUser, { roles: [APPLICANT_ROLE], permissions: [] }))
}

/** Records a credential or guarded-write failure without copying its cause. */
const recordFirstSuperAdminFailure = (
  context: AuthOperationContext,
  userId: string,
  authenticated: boolean,
): Promise<void> => createAuditEvent(
  context.db,
  auditEvent(context, {
    action: auditActions.firstSuperAdminBootstrap,
    entityType: 'CORE_USER',
    entityId: userId,
    actorUserId: authenticated ? userId : null,
    outcome: 'FAILURE',
    // This endpoint carries two credentials. Its audit rows intentionally omit
    // caller-controlled request labels so a malicious User-Agent/request ID
    // cannot copy either credential into retained history.
    includeRequestMetadata: false,
  }),
)

/** Builds the role swap and its three success audits for the guarded D1 batch. */
const attemptFirstSuperAdminGrant = (
  candidate: UserRecord,
  configuredEmail: string,
  context: AuthOperationContext,
): Promise<boolean> => {
  const now = new Date()
  const roleGrant: UserRoleGrantRecord = {
    id: crypto.randomUUID(),
    userId: candidate.id,
    role: FIRST_SUPER_ADMIN_ROLE,
    roleId: null,
    // Authority comes from trusted bootstrap configuration rather than another
    // portal user; the audit event still identifies the authenticated candidate.
    grantedByUserId: null,
    grantReason: FIRST_SUPER_ADMIN_BOOTSTRAP_REASON,
    grantedAt: now,
    revokedByUserId: null,
    revokedAt: null,
    revocationReason: null,
  }
  return grantFirstSuperAdmin(context.db, {
    userId: candidate.id,
    email: configuredEmail,
    verifiedPasswordHash: candidate.passwordHash,
    roleGrant,
    roleGrantAuditEvent: auditEvent(context, {
      action: auditActions.roleGranted,
      entityType: 'CORE_USER_ROLE_GRANT',
      entityId: roleGrant.id,
      actorUserId: candidate.id,
      metadata: { userId: candidate.id, role: FIRST_SUPER_ADMIN_ROLE },
      createdAt: now,
      includeRequestMetadata: false,
    }),
    roleRevocationAuditEvent: auditEvent(context, {
      action: auditActions.roleRevoked,
      // The write matches the grant by user and role, so no grant ID exists to
      // name here. Recording the user keeps the row reachable through the
      // (entity_type, entity_id) audit index; a null entity ID would make this
      // revocation invisible to every entity lookup.
      entityType: 'CORE_USER',
      entityId: candidate.id,
      actorUserId: candidate.id,
      metadata: {
        userId: candidate.id,
        role: APPLICANT_ROLE,
        reason: FIRST_SUPER_ADMIN_BOOTSTRAP_REASON,
      },
      createdAt: now,
      includeRequestMetadata: false,
    }),
    bootstrapAuditEvent: auditEvent(context, {
      action: auditActions.firstSuperAdminBootstrap,
      entityType: 'CORE_USER',
      entityId: candidate.id,
      actorUserId: candidate.id,
      metadata: {
        grantId: roleGrant.id,
        role: FIRST_SUPER_ADMIN_ROLE,
        revokedRole: APPLICANT_ROLE,
        reason: FIRST_SUPER_ADMIN_BOOTSTRAP_REASON,
      },
      createdAt: now,
      includeRequestMetadata: false,
    }),
  })
}

/**
 * Promotes the configured, already-verified applicant exactly once, exchanging
 * their APPLICANT grant for SUPER_ADMIN so the result is an administrator-only
 * account. Both role events stay in retained grant history.
 *
 * This function is intentionally exposed only through the curl-oriented Hono
 * route. It is not part of the GraphQL schema. The high-entropy configuration
 * secret is checked before D1 lookup or scrypt work, limiting unauthenticated
 * requests to cheap constant-time HMAC operations.
 */
export const bootstrapFirstSuperAdmin = async (
  input: { currentPassword: string; bootstrapSecret: string },
  context: AuthOperationContext,
): Promise<AuthResult<FirstSuperAdminBootstrapResponse>> => {
  const configuration = firstSuperAdminConfiguration(context)
  if (
    !configuration ||
    !passwordSchema.safeParse(input.currentPassword).success ||
    !isValidBootstrapSecret(input.bootstrapSecret)
  ) {
    return failure(FIRST_SUPER_ADMIN_BOOTSTRAP_FAILURE)
  }

  const secretMatches = await verifyConfiguredSecret(
    requireSecret(context),
    'first-super-admin-bootstrap',
    configuration.secret,
    input.bootstrapSecret,
  )
  if (!secretMatches) return failure(FIRST_SUPER_ADMIN_BOOTSTRAP_FAILURE)

  // The read-side eligibility check avoids expensive scrypt work after the
  // permanent bootstrap lock already exists. The guarded insert repeats this
  // condition later because another request may win after this read.
  const candidate = await findFirstSuperAdminCandidateByEmail(
    context.db,
    configuration.email,
  )
  if (!candidate) {
    return failure(FIRST_SUPER_ADMIN_BOOTSTRAP_FAILURE)
  }

  const passwordMatches = await verifyPassword(candidate.passwordHash, input.currentPassword)
  if (!passwordMatches) {
    await recordFirstSuperAdminFailure(context, candidate.id, false)
    return failure(FIRST_SUPER_ADMIN_BOOTSTRAP_FAILURE)
  }

  const granted = await attemptFirstSuperAdminGrant(
    candidate,
    configuration.email,
    context,
  )
  if (!granted) {
    await recordFirstSuperAdminFailure(context, candidate.id, true)
    return failure(FIRST_SUPER_ADMIN_BOOTSTRAP_FAILURE)
  }

  return success({
    userId: candidate.id,
    roles: await findActiveUserRoles(context.db, candidate.id),
  })
}

/** Verifies a password and creates a seven-day opaque D1 session. */
export const signIn = async (
  input: { email: string; password: string },
  context: AuthOperationContext,
): Promise<AuthResult<AuthResponse>> => {
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

  const user = await findActiveUserByEmail(context.db, email)
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
    tokenDigest: await sessionTokenDigest(requireSecret(context), token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
    updatedAt: now,
    ipAddress: context.requestHeaders.get('CF-Connecting-IP'),
    userAgent: context.requestHeaders.get('User-Agent'),
  }
  const sessionCreated = await createUserSession(
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

  // One authority read serves both the identity payload and the caller's view
  // of what this session may now do.
  const authority = await findUserAuthority(context.db, user.id)
  return success({
    user: toAuthUser(user, { ...authority, permissions: permissionsOf(authority) }),
    session: toAuthSession(session, session.id),
  })
}

/** Signed-out callers receive success with a nullable response. */
export const currentSession = async (
  context: AuthOperationContext,
): Promise<AuthResult<AuthResponse>> => {
  const current = await getCurrentSession(context)
  if (!current) return { success: true, message: null, response: null }

  // Authority already arrived live from the session lookup; re-reading it here
  // would cost a second round trip for the same answer.
  return success({
    user: toAuthUser(current.user, current),
    session: toAuthSession(current.session, current.session.id),
  })
}

/** Lists active sessions without ever selecting or exposing token digests. */
export const sessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ sessions: AuthSession[] }>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  const records = await listUserSessions(context.db, current.user.id, new Date())
  return success({
    sessions: records.map((record) => toAuthSession(record, current.session.id)),
  })
}

/** Hard-deletes the current row and expires the browser cookie. */
export const signOut = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const token = readSessionToken(context.requestHeaders)
  if (token) {
    const digest = await sessionTokenDigest(requireSecret(context), token)
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

export const revokeSession = async (
  sessionId: string,
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  // Ownership is part of the DELETE predicate, so another person's public
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

export const revokeOtherSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentSession(context)
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

export const revokeAllSessions = async (
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentSession(context)
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
