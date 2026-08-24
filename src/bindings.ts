/**
 * Runtime bindings supplied by Cloudflare plus optional text configuration.
 * Secrets are deliberately absent from checked-in env files and are provisioned
 * with `wrangler secret put` in deployed environments.
 */
export type AppBindings = CloudflareBindings & {
  /**
   * Which environment this is: `develop`, `production`, or unset for local.
   *
   * A deployed environment is always told what it is; an unconfigured machine
   * is a developer's. This is what selects a real notification transport over
   * the one that only prints.
   */
  ENVIRONMENT?: string
  /**
   * Turns rate limiting off, for the test suites and nothing else.
   *
   * `"true"` selects a limiter that counts nothing. The factory refuses it
   * outright in production, at construction, so a Worker configured this way
   * there fails to start rather than serving unprotected. See
   * `services/rate-limit/README.md` for why the suites need it.
   */
  RATE_LIMIT_DISABLED?: string
  AUTH_SECRET?: string
  /**
   * Keys the digest of the identity numbers a reviewer transcribes. Separate
   * from AUTH_SECRET on purpose: rotating session signing must not silently
   * stop the duplicate check from matching anything already recorded.
   */
  IDENTIFIER_SECRET?: string
  /**
   * Seals role invitations. Separate again, and for a sharper reason: an
   * invitation is a bearer credential that lives only in a link, so rotating
   * this must invalidate outstanding invitations without touching sessions.
   */
  ROLE_INVITE_SECRET?: string
  /**
   * Where the client is, used to build the link an invitation travels in.
   * Falls back to the Worker's own origin, which is right for local work and
   * wrong the moment the client is deployed somewhere else.
   */
  PORTAL_BASE_URL?: string
  FRONTEND_ORIGINS?: string
  AUTH_COOKIE_SAME_SITE?: string
  APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT?: string
  FIRST_SUPER_ADMIN_EMAIL?: string
  FIRST_SUPER_ADMIN_SECRET?: string
  /** Credentials for the notification provider. Required once ENVIRONMENT
      names a deployed environment; see services/external-notification. */
  PINGRAM_API_KEY?: string
  PINGRAM_NOTIFICATION_TYPE?: string
  R2_ACCOUNT_ID?: string
  R2_BUCKET_NAME?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
}
