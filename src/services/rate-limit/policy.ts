/**
 * Which operations are limited, and by how much.
 *
 * **This file is the whole of the policy.** Adding a limit is a row here, never
 * a line in a controller — nothing in `services/auth`, `services/admin` or
 * `services/application` knows that rate limiting exists. Two enforcement
 * points read this table and there is never a third.
 *
 * ## Why the numbers are here and also in the Worker's configuration
 *
 * The deployed limiter declares its limit and period per binding, because that
 * is how the platform's rate-limiting binding works — they are configuration,
 * not arguments. Restating them buys two things: the in-process transport can
 * enforce the same thing locally, and somebody reading the policy can see what
 * it actually permits.
 *
 * That is a real duplication, so it is checked rather than trusted.
 * `npm run check:rate-limits` fails when a binding named here is missing from
 * `wrangler.jsonc` or declares different numbers. Left unchecked it would be
 * the worst kind of drift: the limiter fails closed, so a policy naming a
 * binding that does not exist takes down signup.
 *
 * ## Choosing a number
 *
 * An `IP` allowance has to fit a whole office behind one address, so it is
 * generous by design and is a guard against volume rather than a precise
 * control. A `SUBJECT` allowance can be tight, because it counts attempts
 * against one account and no legitimate person needs many.
 *
 * ## Every window is a minute, and that is the platform's constraint
 *
 * The rate-limiting binding accepts a period of ten seconds or sixty, and
 * nothing else. So an allowance that should be measured in hours cannot be:
 * "three signups an hour for one address" — seventy-two messages a day — is
 * expressible only as "two a minute", which is nearly three thousand.
 *
 * That is a real weakness and it is written down rather than hidden. What these
 * limits stop is bulk abuse: a script hammering an address, a flood from one
 * source. What they do not stop is a patient attacker trickling requests. A
 * Durable Object counts any window and is the way out; it is on the roadmap,
 * and the seam means swapping to it changes one file and this table's numbers.
 *
 * The numbers themselves are a first estimate of a programme office's traffic,
 * not a measurement. The suites deliberately do not exercise them — see the
 * README — so the first real deployment is what will correct them.
 */
import type { RateLimitBucket } from './types'

/**
 * The operations worth naming, keyed by the field a caller actually writes.
 *
 * `auth.signIn`, not a resolver's name, because that is what the enforcement
 * point can see in the document and what somebody reading this can match
 * against their own query.
 */
const RATE_LIMIT_POLICY = {
  /**
   * Signing in.
   *
   * Two dimensions doing different jobs. The address stops one account being
   * guessed at from anywhere; the source address stops one machine working
   * through a list of accounts.
   *
   * Five a minute for the account, because every attempt spends one and a real
   * person signs in from a handful of devices at once.
   */
  'auth.signIn': [
    {
      binding: 'RL_SIGN_IN_SUBJECT',
      dimension: 'SUBJECT',
      limit: 5,
      periodSeconds: 60,
    },
    {
      binding: 'RL_SIGN_IN_IP',
      dimension: 'IP',
      limit: 20,
      periodSeconds: 60,
    },
  ],

  /**
   * Starting signup, which sends a one-time code to an address.
   *
   * Limited by address as well as source because the cost of abuse is not the
   * request — it is the mail. Somebody who can trigger unlimited signups is
   * using this programme to deliver mail to a stranger's inbox.
   */
  'auth.startApplicantSignup': [
    {
      binding: 'RL_SIGNUP_SUBJECT',
      dimension: 'SUBJECT',
      limit: 2,
      periodSeconds: 60,
    },
    {
      binding: 'RL_SIGNUP_IP',
      dimension: 'IP',
      limit: 5,
      periodSeconds: 60,
    },
  ],

  /**
   * Verifying a one-time code.
   *
   * The code is short, so here the limit *is* the security control rather than
   * a guard on load. The challenge already expires; this stops it being
   * exhausted before it does. One person verifies once, so this is tight.
   */
  'auth.verifyApplicantSignup': [
    {
      binding: 'RL_VERIFY_IP',
      dimension: 'IP',
      limit: 10,
      periodSeconds: 60,
    },
  ],

  /**
   * Asking for a password reset, which sends a code to an address.
   *
   * The same shape as starting signup and for the same reason: the cost of
   * abuse is the mail, not the request. Somebody who can trigger unlimited
   * resets is using this programme to deliver mail to a stranger's inbox — and
   * to bury the notice that would have warned them.
   */
  'auth.startPasswordReset': [
    {
      binding: 'RL_RESET_SUBJECT',
      dimension: 'SUBJECT',
      limit: 2,
      periodSeconds: 60,
    },
    {
      binding: 'RL_RESET_IP',
      dimension: 'IP',
      limit: 5,
      periodSeconds: 60,
    },
  ],

  /**
   * Completing a password reset.
   *
   * Guessing a six-digit code, where the limit is the security control rather
   * than a guard on load. The challenge counts its own attempts; this stops one
   * source working through many challenges at once.
   */
  'auth.completePasswordReset': [
    {
      binding: 'RL_RESET_VERIFY_IP',
      dimension: 'IP',
      limit: 10,
      periodSeconds: 60,
    },
  ],

  /**
   * Changing a known password.
   *
   * Counted by session because the caller is signed in, and each attempt costs
   * a scrypt verification. Five a minute is far above any real use.
   */
  'auth.changePassword': [
    {
      binding: 'RL_PASSWORD_SESSION',
      dimension: 'SESSION',
      limit: 5,
      periodSeconds: 60,
    },
  ],

  /**
   * Asking to move an account to another address.
   *
   * **By session, not by subject.** `operationSubject` reads `input.email` and
   * nothing else, so a SUBJECT bucket on an input naming `newEmail` would
   * resolve to null and be skipped silently — an allowance that looks declared
   * and counts nothing. The session is the right dimension anyway: this sends
   * mail to an address the caller chose, and the cost belongs to their account.
   */
  'auth.startEmailChange': [
    {
      binding: 'RL_EMAIL_CHANGE_SESSION',
      dimension: 'SESSION',
      limit: 2,
      periodSeconds: 60,
    },
  ],

  /**
   * Completing a change of address, which is guessing a six-digit code.
   */
  'auth.completeEmailChange': [
    {
      binding: 'RL_EMAIL_VERIFY_SESSION',
      dimension: 'SESSION',
      limit: 10,
      periodSeconds: 60,
    },
  ],

  /**
   * Accepting a role invitation.
   *
   * Takes no session — possession of the sealed token is the whole credential —
   * so the source address is the only dimension available. A run of refusals is
   * somebody trying tokens, and this is what makes trying them slow.
   */
  'access.acceptRoleInvite': [
    {
      binding: 'RL_INVITE_IP',
      dimension: 'IP',
      limit: 10,
      periodSeconds: 60,
    },
  ],

  /**
   * Asking for permission to upload a document.
   *
   * Each authorization reserves storage and a scan, so this is counted by
   * session rather than by address: the caller is signed in, and the cost falls
   * on their own account rather than on whoever shares their office.
   */
  'seb.application.issueDocumentUpload': [
    {
      binding: 'RL_UPLOAD_SESSION',
      dimension: 'SESSION',
      limit: 20,
      periodSeconds: 60,
    },
  ],
} as const satisfies Record<string, readonly RateLimitBucket[]>

/**
 * The allowance every request spends, whatever it asks for.
 *
 * Applied by the HTTP layer before anything is parsed, so a flood costs one
 * atomic increment rather than a GraphQL parse. Deliberately wide: this guards
 * volume, and the operation limits above are what make the sensitive paths
 * actually hard.
 */
export const REQUEST_BUDGET: RateLimitBucket = {
  binding: 'RL_REQUEST_IP',
  dimension: 'IP',
  limit: 600,
  periodSeconds: 60,
}

/*
 * The emailed application copy.
 *
 * Unauthenticated by design — it is opened from an inbox — and the valid
 * path rebuilds a PDF, which is real CPU. The signature already keeps
 * strangers at the cheap 403; this bounds what one holder of a valid link
 * (or one address probing signatures) can spend. Ten a minute is far above
 * any person re-opening their own copy.
 */
export const CONFIRMATION_PDF: RateLimitBucket = {
  binding: 'RL_CONFIRMATION_PDF_IP',
  dimension: 'IP',
  limit: 10,
  periodSeconds: 60,
}

/** Every bucket the policy declares, including the request budget. */
export const allBuckets = (): readonly RateLimitBucket[] => [
  REQUEST_BUDGET,
  CONFIRMATION_PDF,
  ...Object.values(RATE_LIMIT_POLICY).flat(),
]

/** The allowances one operation needs room in. Empty when it is unlimited. */
export const bucketsFor = (operation: string): readonly RateLimitBucket[] =>
  RATE_LIMIT_POLICY[operation as keyof typeof RATE_LIMIT_POLICY] ?? []
