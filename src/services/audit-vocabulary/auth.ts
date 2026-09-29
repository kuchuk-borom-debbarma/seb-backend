/**
 * Signing up, signing in, and looking after an account.
 *
 * Two kinds of act live here. Signing in and out is `SIGN_IN`: who got in,
 * who was refused and why, which devices were ended. Everything that changes
 * the account itself — its creation, its password, its address, its name — is
 * `ACCOUNT`.
 *
 * Most of the account paths are the credential-bearing maintenance paths that
 * record no request labels, so their specs are `callerTextFree`: they carry
 * counts, instants and enums, and addresses only once they have parsed as
 * addresses. No one-time code, digest, token or password is ever a field here.
 */
import { z } from 'zod'
import { auditId, count, email, empty, isoInstant } from './fields'
import { defineAudit } from './types'

/*
 * Every address below is optional and written through `auditEmail`: the schema
 * bounds an address at 254 characters, and an account whose address is longer
 * than that must still be able to act — its row then records no address rather
 * than refusing the write it belongs to.
 *
 * The account-challenge helper writes either of two actions from one call site
 * — a reset or an address change — so each pair shares one schema, and the
 * payload a call site builds is checked against both.
 */
const challengeIssued = z.strictObject({ recipient: email.optional(), expiresAt: isoInstant })
const challengeIssuedFields = {
  recipient: { label: 'Sent to', kind: 'EMAIL' },
  expiresAt: { label: 'Code expires', kind: 'DATETIME' },
} as const

const wrongCode = z.strictObject({ attemptsRemaining: count })
const wrongCodeFields = { attemptsRemaining: { label: 'Attempts left', kind: 'COUNT' } } as const

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export const authVocabulary = {
  'AUTH.SIGNUP_CHALLENGE_CREATED': defineAudit({
    label: 'Asked for an applicant signup code',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_SIGNUP_CHALLENGE'],
    // Nobody yet: the account exists only once the code is redeemed.
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({ email: email.optional(), expiresAt: isoInstant }),
    fields: {
      email: { label: 'Address', kind: 'EMAIL' },
      expiresAt: { label: 'Code expires', kind: 'DATETIME' },
    },
    summary: (p) => `Sent a signup code to ${p.email ?? 'an address'}`,
    example: { email: 'applicant@example.in', expiresAt: '2026-09-29T10:10:00.000Z' },
  }),
  'AUTH.SIGNUP_NOTIFICATION_FAILED': defineAudit({
    label: 'Could not deliver a signup code',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_SIGNUP_CHALLENGE'],
    subject: 'NONE',
    application: 'NONE',
    payload: empty,
    fields: {},
    summary: () => 'Could not deliver a signup code; the challenge was closed',
    example: {},
  }),
  'AUTH.OTP_FAILED': defineAudit({
    label: 'Entered a wrong signup code',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_SIGNUP_CHALLENGE'],
    subject: 'NONE',
    application: 'NONE',
    payload: wrongCode,
    fields: wrongCodeFields,
    summary: (p) => `Entered a wrong signup code, ${plural(p.attemptsRemaining, 'attempt', 'attempts')} left`,
    example: { attemptsRemaining: 2 },
  }),
  'USER.CREATED': defineAudit({
    label: 'Created an account',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    payload: z.strictObject({
      // One route in today; named so a second one could never be confused
      // with it in the history.
      via: z.enum(['VERIFIED_SIGNUP']),
      email: email.optional(),
      signupChallengeId: auditId,
    }),
    fields: {
      via: { label: 'How', kind: 'ENUM' },
      email: { label: 'Address', kind: 'EMAIL' },
      signupChallengeId: { label: 'Signup challenge', kind: 'ID' },
    },
    summary: (p) =>
      p.email ? `Created the account ${p.email} by verified signup` : 'Created an account by verified signup',
    example: { via: 'VERIFIED_SIGNUP', email: 'applicant@example.in', signupChallengeId: '00000000-0000-4000-8000-000000000010' },
  }),
  'AUTH.SIGN_IN_SUCCEEDED': defineAudit({
    label: 'Signed in',
    category: 'SIGN_IN',
    writer: 'auth',
    entityTypes: ['CORE_SESSION'],
    subject: 'ACTOR',
    application: 'NONE',
    payload: z.strictObject({ sessionExpiresAt: isoInstant }),
    fields: { sessionExpiresAt: { label: 'Session expires', kind: 'DATETIME' } },
    summary: () => 'Signed in',
    example: { sessionExpiresAt: '2026-10-06T09:00:00.000Z' },
  }),
  'AUTH.SIGN_IN_FAILED': defineAudit({
    label: 'Failed to sign in',
    category: 'SIGN_IN',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    // The caller is always told the same thing; the history says which of these
    // it was, which is what somebody investigating a lockout needs.
    payload: z.strictObject({
      reason: z.enum(['INVALID_INPUT', 'NO_ACTIVE_ACCOUNT', 'WRONG_PASSWORD', 'EMAIL_UNVERIFIED', 'ACCESS_CHANGED']),
      // Only when what was typed parsed as an address.
      email: email.optional(),
    }),
    fields: {
      reason: { label: 'Refused because', kind: 'ENUM' },
      email: { label: 'Address tried', kind: 'EMAIL' },
    },
    summary: (p) => (p.email ? `Failed to sign in as ${p.email}` : 'Failed to sign in'),
    example: { reason: 'WRONG_PASSWORD', email: 'applicant@example.in' },
  }),
  'AUTH.SIGNED_OUT': defineAudit({
    label: 'Signed out',
    category: 'SIGN_IN',
    writer: 'auth',
    entityTypes: ['CORE_SESSION'],
    subject: 'ACTOR',
    application: 'NONE',
    payload: empty,
    fields: {},
    summary: () => 'Signed out',
    example: {},
  }),
  'AUTH.SESSION_REVOKED': defineAudit({
    label: 'Signed out a device',
    category: 'SIGN_IN',
    writer: 'auth',
    entityTypes: ['CORE_SESSION'],
    subject: 'ACTOR',
    application: 'NONE',
    payload: z.strictObject({ currentDevice: z.boolean() }),
    fields: { currentDevice: { label: 'This device', kind: 'BOOLEAN' } },
    summary: (p) => (p.currentDevice ? 'Signed out this device' : 'Signed out another device'),
    example: { currentDevice: false },
  }),
  'AUTH.SESSIONS_REVOKED': defineAudit({
    label: 'Signed out devices',
    category: 'SIGN_IN',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    payload: z.strictObject({
      scope: z.enum(['OTHER', 'ALL']),
      // Whether the person asked, or the system ended every session because
      // they no longer held any role that authorized anything.
      cause: z.enum(['SELF_SERVICE', 'NO_ACTIVE_ROLE']),
    }),
    fields: {
      scope: { label: 'Which devices', kind: 'ENUM' },
      cause: { label: 'Why', kind: 'ENUM' },
    },
    summary: (p) =>
      p.cause === 'NO_ACTIVE_ROLE'
        ? 'Ended every session: no role left that authorizes anything'
        : p.scope === 'ALL'
          ? 'Signed out every device'
          : 'Signed out every other device',
    example: { scope: 'OTHER', cause: 'SELF_SERVICE' },
  }),
  'AUTH.PASSWORD_RESET_REQUESTED': defineAudit({
    label: 'Asked to reset a password',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_ACCOUNT_CHALLENGE'],
    subject: 'ACTOR',
    application: 'NONE',
    callerTextFree: true,
    payload: challengeIssued,
    fields: challengeIssuedFields,
    summary: (p) => `Sent a password reset code to ${p.recipient ?? 'the account address'}`,
    example: { recipient: 'applicant@example.in', expiresAt: '2026-09-29T10:10:00.000Z' },
  }),
  'AUTH.PASSWORD_RESET_NOTIFICATION_FAILED': defineAudit({
    label: 'Could not deliver a password reset code',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_ACCOUNT_CHALLENGE'],
    subject: 'ACTOR',
    application: 'NONE',
    callerTextFree: true,
    payload: empty,
    fields: {},
    summary: () => 'Could not deliver a password reset code',
    example: {},
  }),
  'AUTH.PASSWORD_RESET_OTP_FAILED': defineAudit({
    label: 'Entered a wrong password reset code',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_ACCOUNT_CHALLENGE'],
    subject: 'ACTOR',
    application: 'NONE',
    callerTextFree: true,
    payload: wrongCode,
    fields: wrongCodeFields,
    summary: (p) => `Entered a wrong password reset code, ${plural(p.attemptsRemaining, 'attempt', 'attempts')} left`,
    example: { attemptsRemaining: 2 },
  }),
  'AUTH.PASSWORD_RESET_COMPLETED': defineAudit({
    label: 'Reset a password',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    callerTextFree: true,
    payload: empty,
    fields: {},
    summary: () => 'Reset the password with an emailed code',
    example: {},
  }),
  'USER.PASSWORD_CHANGED': defineAudit({
    label: 'Changed a password',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    callerTextFree: true,
    payload: empty,
    fields: {},
    summary: () => 'Changed the password',
    example: {},
  }),
  'USER.EMAIL_CHANGE_REQUESTED': defineAudit({
    label: 'Asked to change an email address',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_ACCOUNT_CHALLENGE'],
    subject: 'ACTOR',
    application: 'NONE',
    callerTextFree: true,
    payload: challengeIssued,
    fields: challengeIssuedFields,
    summary: (p) =>
      p.recipient ? `Sent a confirmation code to the new address ${p.recipient}` : 'Sent a confirmation code to a new address',
    example: { recipient: 'new@example.in', expiresAt: '2026-09-29T10:10:00.000Z' },
  }),
  'USER.EMAIL_CHANGE_NOTIFICATION_FAILED': defineAudit({
    label: 'Could not deliver an email change code',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_ACCOUNT_CHALLENGE'],
    subject: 'ACTOR',
    application: 'NONE',
    callerTextFree: true,
    payload: empty,
    fields: {},
    summary: () => 'Could not deliver an email change code',
    example: {},
  }),
  'USER.EMAIL_CHANGE_OTP_FAILED': defineAudit({
    label: 'Entered a wrong email change code',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_ACCOUNT_CHALLENGE'],
    subject: 'ACTOR',
    application: 'NONE',
    callerTextFree: true,
    payload: wrongCode,
    fields: wrongCodeFields,
    summary: (p) => `Entered a wrong email change code, ${plural(p.attemptsRemaining, 'attempt', 'attempts')} left`,
    example: { attemptsRemaining: 2 },
  }),
  'USER.EMAIL_CHANGED': defineAudit({
    label: 'Changed an email address',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    callerTextFree: true,
    payload: z.strictObject({ previousEmail: email.optional(), newEmail: email.optional() }),
    fields: {
      previousEmail: { label: 'From', kind: 'EMAIL' },
      newEmail: { label: 'To', kind: 'EMAIL' },
    },
    summary: (p) => `Moved the account from ${p.previousEmail ?? 'its old address'} to ${p.newEmail ?? 'a new address'}`,
    example: { previousEmail: 'old@example.in', newEmail: 'new@example.in' },
  }),
  'USER.DISPLAY_NAME_CHANGED': defineAudit({
    label: 'Changed a display name',
    category: 'ACCOUNT',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    // The signed-in person's own name for themselves; null when cleared.
    payload: z.strictObject({ displayName: z.string().min(1).max(200).nullable() }),
    fields: { displayName: { label: 'Name', kind: 'TEXT' } },
    summary: (p) => (p.displayName ? `Set the display name to ${p.displayName}` : 'Cleared the display name'),
    example: { displayName: 'Kuchuk' },
  }),
} as const
