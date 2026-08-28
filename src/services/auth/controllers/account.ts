/**
 * What a person may change about their own account.
 *
 * Four flows, two shapes. A forgotten password is proved by the mailbox alone,
 * because by definition the password is unavailable. Everything else is done by
 * somebody already signed in, and is proved by the password as well — the
 * step-up `access.ts` already applies to role changes, for the same reason: a
 * borrowed unlocked browser must not be enough to take an account over.
 *
 * ## The challenge, and why it is the signup one again
 *
 * Two independent secrets. A `challengeToken` goes back to the browser that
 * asked and identifies the attempt; a six-digit code goes to the mailbox and
 * proves it was read. Neither alone is enough, so a forwarded email does not
 * hand over the account and a stolen response does not either. Only digests are
 * stored, keyed by `AUTH_SECRET`, with the challenge id in the OTP's purpose so
 * one challenge's digest can never be replayed against another.
 *
 * ## Two rules that are easy to erode
 *
 * **Answer identically whether or not the account exists.** `startPasswordReset`
 * returns the same envelope, the same message and an unstored decoy token for
 * an address that names nobody. The same rule covers an email change onto an
 * address already taken. Losing this turns either flow into a membership
 * oracle for a grants programme's applicant list.
 *
 * **Never pay scrypt for an unauthorized caller.** Authorization and cheap
 * validation come first, password verification last.
 */
import { z } from 'zod'
import { auditActions } from '../../../db/schema'
import { notificationDelivery, sendNotification } from '../../external-notification'
import { failure, success } from '../../envelope'
import {
  createDigest,
  createChallengeToken,
  createOtp,
  hashPassword,
  verifyPassword,
} from '../crypto'
import {
  applyDisplayNameChange,
  applyEmailChange,
  applyPasswordChange,
  applyPasswordReset,
  consumeWrongAccountOtpAttempt,
  createAccountChallenge,
  emailIsTaken,
  findActiveAccountChallenge,
  markAccountChallengeDeliveryFailed,
  supersedeAccountChallenges,
} from '../queries/account'
import { findActiveUserByEmail } from '../queries/auth'
import { capabilitiesOf } from '../capabilities'
import { getCurrentSession } from './auth'
import { findActorPasswordHash } from '../queries/access'
import { AUTH_REQUIRED_MESSAGE, auditEvent, normalizeEmail } from '../support'
import { bestEffort } from '../../best-effort'
import type {
  AuthOperationContext,
  AuthResult,
  AuthUser,
  AuthenticatedUserRequest,
  StartAccountChallengeResponse,
} from '../types'

const CHALLENGE_TTL_MS = 10 * 60 * 1_000
const CHALLENGE_ATTEMPTS = 5

/** Said for an address that exists and one that does not, alike. */
const START_RESET_MESSAGE =
  'If this email belongs to an account, a reset code has been sent.'
/** Said for a free address and a taken one, alike. */
const START_EMAIL_CHANGE_MESSAGE =
  'If that address can be used, a confirmation code has been sent to it.'
const INVALID_CHALLENGE_MESSAGE = 'The code is invalid or has expired.'
const INVALID_PASSWORD_MESSAGE = 'Your password is incorrect.'

const emailSchema = z.email()
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const otpSchema = z.string().regex(/^\d{6}$/u)
const passwordSchema = z.string().min(8).max(128)
const displayNameSchema = z.string().trim().min(1).max(120)

const requireSecret = (context: AuthOperationContext): string => {
  const secret = context.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is required.')
  if (new TextEncoder().encode(secret).length < 32) {
    throw new Error('AUTH_SECRET must contain at least 32 bytes.')
  }
  return secret
}

const toAuthUser = (
  current: AuthenticatedUserRequest,
  overrides: { email?: string; displayName?: string | null } = {},
): AuthUser => ({
  id: current.user.id,
  email: overrides.email ?? current.user.email,
  emailVerified: current.user.emailVerifiedAt !== null,
  displayName:
    overrides.displayName === undefined ? current.user.displayName : overrides.displayName,
  roles: current.roles,
  capabilities: capabilitiesOf(current.roles),
  createdAt: current.user.createdAt,
})

/**
 * Issues a challenge and sends its code, or convincingly does neither.
 *
 * Shared by both start operations so the decoy path cannot drift from the real
 * one: the same token shape is returned either way, and the only difference is
 * whether a row was written and a message sent.
 */
const issueChallenge = async (
  context: AuthOperationContext,
  input: {
    purpose: 'PASSWORD_RESET' | 'EMAIL_CHANGE'
    userId: string | null
    recipient: string
    subject: string
    body: (otp: string) => string
    requestedAction: (typeof auditActions)[keyof typeof auditActions]
    failedAction: (typeof auditActions)[keyof typeof auditActions]
  },
  /*
   * Always the same shape. There is deliberately no failure arm: every way this
   * can fall short — no such account, the account stopped qualifying, the code
   * could not be delivered — answers identically, because a caller able to tell
   * them apart is a caller able to enumerate who holds an account.
   */
): Promise<{ challengeToken: string; expiresAt: Date; delivered: boolean }> => {
  const secret = requireSecret(context)
  const challengeToken = createChallengeToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS)

  // Nothing to issue against. The token above is returned anyway and is
  // deliberately unstored, so the caller cannot tell this apart from the path
  // below by anything in the response.
  if (!input.userId) return { challengeToken, expiresAt, delivered: false }

  const id = crypto.randomUUID()
  const otp = createOtp()

  // One statement, so no transaction to open: superseding the outstanding
  // challenges is atomic on its own.
  await supersedeAccountChallenges(context.db, input.userId, input.purpose, now)

  const created = await createAccountChallenge(
    context.db,
    {
      id,
      purpose: input.purpose,
      userId: input.userId,
      email: input.recipient,
      challengeDigest: await createDigest(
        secret,
        `${input.purpose.toLowerCase()}-challenge`,
        challengeToken,
      ),
      otpDigest: await createDigest(secret, `${input.purpose.toLowerCase()}-otp:${id}`, otp),
      attemptsRemaining: CHALLENGE_ATTEMPTS,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    },
    auditEvent(context, {
      action: input.requestedAction,
      entityType: 'CORE_ACCOUNT_CHALLENGE',
      entityId: id,
      actorUserId: input.userId,
      // The request headers are dropped for the reason every credential-bearing
      // operation drops them: a hostile header must not be able to copy itself
      // into retained history beside a secret.
      includeRequestMetadata: false,
    }),
  )
  // The account stopped qualifying between the read and the write.
  if (!created) return { challengeToken, expiresAt, delivered: false }

  try {
    await sendNotification(
      { to: input.recipient, subject: input.subject, body: input.body(otp) },
      context.env,
    )
  } catch {
    await markAccountChallengeDeliveryFailed(
      context.db,
      id,
      new Date(),
      auditEvent(context, {
        action: input.failedAction,
        entityType: 'CORE_ACCOUNT_CHALLENGE',
        entityId: id,
        actorUserId: input.userId,
        outcome: 'FAILURE',
        includeRequestMetadata: false,
      }),
    )
    // Never the error: it can carry the code it was trying to deliver.
    console.error('An account challenge notification failed')
    /*
     * The same answer an address with no account gets — **this used to be a
     * different one, and that was the whole oracle**.
     *
     * The early return above exists so that "no account here" is
     * indistinguishable from "a code is on its way". A delivery failure broke
     * exactly that: an unknown address answered with the ordinary message and
     * a known one whose send failed answered with `DELIVERY_FAILED_MESSAGE`,
     * so anyone who could make delivery fail could ask this endpoint which
     * addresses hold accounts, one at a time.
     *
     * **The cost is named rather than hidden.** Somebody whose code genuinely
     * failed to send is told to check their email and nothing arrives. It is
     * the same cost the design already accepts for an address with no account,
     * and the failure is not lost — it is marked on the challenge and audited
     * under its own action, so the office can see it even though the caller
     * cannot.
     */
    return { challengeToken, expiresAt, delivered: false }
  }

  return { challengeToken, expiresAt, delivered: true }
}

/**
 * Reads a live challenge and checks the code, spending an attempt when wrong.
 *
 * Returns the challenge only when the code was right. Every refusal is the same
 * message, so a wrong code, an expired one and one that never existed are
 * indistinguishable.
 */
const proveChallenge = async (
  context: AuthOperationContext,
  purpose: 'PASSWORD_RESET' | 'EMAIL_CHANGE',
  challengeToken: string,
  otp: string,
  failedAction: (typeof auditActions)[keyof typeof auditActions],
) => {
  const secret = requireSecret(context)
  const now = new Date()
  const challenge = await findActiveAccountChallenge(
    context.db,
    purpose,
    await createDigest(secret, `${purpose.toLowerCase()}-challenge`, challengeToken),
    now,
  )
  if (!challenge) return null

  const expected = await createDigest(
    secret,
    `${purpose.toLowerCase()}-otp:${challenge.id}`,
    otp,
  )
  if (expected !== challenge.otpDigest) {
    await consumeWrongAccountOtpAttempt(
      context.db,
      challenge.id,
      now,
      auditEvent(context, {
        action: failedAction,
        entityType: 'CORE_ACCOUNT_CHALLENGE',
        entityId: challenge.id,
        actorUserId: challenge.userId,
        outcome: 'FAILURE',
        includeRequestMetadata: false,
      }),
    )
    return null
  }
  return challenge
}

/** Sends a reset code, or appears to. */
export const startPasswordReset = async (
  input: { email: string },
  context: AuthOperationContext,
): Promise<AuthResult<StartAccountChallengeResponse>> => {
  const email = emailSchema.safeParse(normalizeEmail(input.email))
  // A malformed address cannot belong to anybody, and saying so reveals
  // nothing — the answer is the same one a valid unknown address gets.
  const user = email.success
    ? await findActiveUserByEmail(context.db, email.data)
    : null

  const issued = await issueChallenge(context, {
    purpose: 'PASSWORD_RESET',
    userId: user?.id ?? null,
    recipient: user?.email ?? '',
    subject: 'Your password reset code',
    body: (otp) =>
      `Your password reset code is ${otp}. It expires in 10 minutes.\n\n`
      + 'If you did not ask to reset your password, you can ignore this message '
      + 'and nothing will change.',
    requestedAction: auditActions.passwordResetRequested,
    failedAction: auditActions.passwordResetNotificationFailed,
  })
  return success(
    {
      challengeToken: issued.challengeToken,
      expiresAt: issued.expiresAt,
      delivery: notificationDelivery(context.env),
    },
    START_RESET_MESSAGE,
  )
}

/** Sets a new password against a proved code, and signs every device out. */
export const completePasswordReset = async (
  input: { challengeToken: string; otp: string; newPassword: string },
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  // The password first, so an unusable one never spends an attempt on a
  // challenge the person will still need.
  const password = passwordSchema.safeParse(input.newPassword)
  if (!password.success) {
    return failure('Choose a password of at least 8 characters.')
  }
  if (
    !challengeSchema.safeParse(input.challengeToken).success
    || !otpSchema.safeParse(input.otp).success
  ) {
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  const challenge = await proveChallenge(
    context,
    'PASSWORD_RESET',
    input.challengeToken,
    input.otp,
    auditActions.passwordResetOtpFailed,
  )
  if (!challenge) return failure(INVALID_CHALLENGE_MESSAGE)

  const applied = await applyPasswordReset(context.db, {
    challengeId: challenge.id,
    userId: challenge.userId,
    passwordHash: await hashPassword(password.data),
    now: new Date(),
    auditEvent: auditEvent(context, {
      action: auditActions.passwordResetCompleted,
      entityType: 'CORE_USER',
      entityId: challenge.userId,
      actorUserId: challenge.userId,
      includeRequestMetadata: false,
    }),
  })
  if (!applied) return failure(INVALID_CHALLENGE_MESSAGE)

  // Best effort, and deliberately after the change: somebody who did not ask
  // for this needs to know, but a mail failure must not undo a reset that has
  // already happened.
  await bestEffort(sendNotification(
    {
      to: challenge.email,
      subject: 'Your password was changed',
      body:
        'Your portal password has just been reset, and every signed-in device '
        + 'has been signed out.\n\nIf this was not you, reset it again '
        + 'immediately and contact the programme office.',
    },
    context.env,
  ), 'A password-change notice failed')

  return success({ value: true }, 'Your password has been reset. Please sign in.')
}

/** Changes the password of somebody signed in, who proved the old one. */
export const changePassword = async (
  input: { currentPassword: string; newPassword: string },
  context: AuthOperationContext,
): Promise<AuthResult<{ value: boolean }>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  const password = passwordSchema.safeParse(input.newPassword)
  if (!password.success) {
    return failure('Choose a password of at least 8 characters.')
  }

  // Last, after authorization and cheap validation, so an unauthorized request
  // never costs a memory-hard hash.
  const passwordHash = await findActorPasswordHash(context.db, current.user.id)
  if (!passwordHash || !(await verifyPassword(passwordHash, input.currentPassword))) {
    return failure(INVALID_PASSWORD_MESSAGE)
  }

  const changed = await applyPasswordChange(context.db, {
    userId: current.user.id,
    verifiedPasswordHash: passwordHash,
    passwordHash: await hashPassword(password.data),
    currentSessionId: current.session.id,
    now: new Date(),
    auditEvent: auditEvent(context, {
      action: auditActions.passwordChanged,
      entityType: 'CORE_USER',
      entityId: current.user.id,
      actorUserId: current.user.id,
      includeRequestMetadata: false,
    }),
  })
  // Another writer changed the password while scrypt ran here.
  if (!changed) return failure('Your password could not be changed. Please try again.')

  await bestEffort(sendNotification(
    {
      to: current.user.email,
      subject: 'Your password was changed',
      body:
        'Your portal password has just been changed, and other signed-in '
        + 'devices have been signed out.\n\nIf this was not you, reset your '
        + 'password immediately and contact the programme office.',
    },
    context.env,
  ), 'A password-change notice failed')

  return success({ value: true }, 'Your password has been changed.')
}

/** Sends a confirmation code to an address somebody wants to move to. */
export const startEmailChange = async (
  input: { newEmail: string; currentPassword: string },
  context: AuthOperationContext,
): Promise<AuthResult<StartAccountChallengeResponse>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  const parsed = emailSchema.safeParse(normalizeEmail(input.newEmail))
  if (!parsed.success) return failure('Enter a valid email address.')
  if (parsed.data === current.user.email) {
    return failure('That is already your email address.')
  }

  const passwordHash = await findActorPasswordHash(context.db, current.user.id)
  if (!passwordHash || !(await verifyPassword(passwordHash, input.currentPassword))) {
    return failure(INVALID_PASSWORD_MESSAGE)
  }

  /*
   * A taken address issues nothing and sends nothing, and says exactly what a
   * free one says. The check is not the guarantee — `core_user.email` is unique
   * and covers soft-deleted rows, so the completing write is guarded too. This
   * only avoids mailing a code that could never be redeemed.
   */
  const taken = await emailIsTaken(context.db, parsed.data)

  const issued = await issueChallenge(context, {
    purpose: 'EMAIL_CHANGE',
    userId: taken ? null : current.user.id,
    recipient: parsed.data,
    subject: 'Confirm your new email address',
    body: (otp) =>
      `Your confirmation code is ${otp}. It expires in 10 minutes.\n\n`
      + 'Someone asked to move a Mission SEP portal account to this address. '
      + 'If that was not you, you can ignore this message.',
    requestedAction: auditActions.emailChangeRequested,
    failedAction: auditActions.emailChangeNotificationFailed,
  })
  if (issued.delivered) {
    // The old address hears about it too, so losing control of an account is
    // visible to whoever still reads the mailbox it used to use.
    await bestEffort(sendNotification(
      {
        to: current.user.email,
        subject: 'A change of email address was requested',
        body:
          'Someone asked to move your Mission SEP portal account to a '
          + 'different email address.\n\nIf this was not you, change your '
          + 'password immediately and contact the programme office.',
      },
      context.env,
    ), 'An email-change notice failed')
  }

  return success(
    {
      challengeToken: issued.challengeToken,
      expiresAt: issued.expiresAt,
      delivery: notificationDelivery(context.env),
    },
    START_EMAIL_CHANGE_MESSAGE,
  )
}

/** Moves the account once the new address has been proved. */
export const completeEmailChange = async (
  input: { challengeToken: string; otp: string },
  context: AuthOperationContext,
): Promise<AuthResult<AuthUser>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)
  if (
    !challengeSchema.safeParse(input.challengeToken).success
    || !otpSchema.safeParse(input.otp).success
  ) {
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  const challenge = await proveChallenge(
    context,
    'EMAIL_CHANGE',
    input.challengeToken,
    input.otp,
    auditActions.emailChangeOtpFailed,
  )
  // Somebody else's challenge is not this person's to redeem.
  if (!challenge || challenge.userId !== current.user.id) {
    return failure(INVALID_CHALLENGE_MESSAGE)
  }

  const moved = await applyEmailChange(context.db, {
    challengeId: challenge.id,
    userId: current.user.id,
    newEmail: challenge.email,
    currentSessionId: current.session.id,
    now: new Date(),
    auditEvent: auditEvent(context, {
      action: auditActions.emailChanged,
      entityType: 'CORE_USER',
      entityId: current.user.id,
      actorUserId: current.user.id,
      includeRequestMetadata: false,
    }),
  })
  // The address was taken between the code being sent and redeemed.
  if (!moved) return failure('That address is no longer available.')

  return success(
    toAuthUser(current, { email: challenge.email }),
    'Your email address has been changed.',
  )
}

/** Records what somebody calls themselves. */
export const changeDisplayName = async (
  input: { displayName: string },
  context: AuthOperationContext,
): Promise<AuthResult<AuthUser>> => {
  const current = await getCurrentSession(context)
  if (!current) return failure(AUTH_REQUIRED_MESSAGE)

  const trimmed = input.displayName.trim()
  // Clearing it is a real choice, and is not the same as never having said.
  const displayName = trimmed === '' ? null : displayNameSchema.safeParse(trimmed)
  if (displayName !== null && !displayName.success) {
    return failure('A name can be at most 120 characters.')
  }
  const value = displayName === null ? null : displayName.data

  const changed = await applyDisplayNameChange(context.db, {
    userId: current.user.id,
    displayName: value,
    now: new Date(),
    auditEvent: auditEvent(context, {
      action: auditActions.displayNameChanged,
      entityType: 'CORE_USER',
      entityId: current.user.id,
      actorUserId: current.user.id,
    }),
  })
  if (!changed) return failure('Your name could not be changed. Please try again.')

  return success(toAuthUser(current, { displayName: value }), 'Your name has been saved.')
}
