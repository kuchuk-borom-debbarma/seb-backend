/**
 * Runtime bindings supplied by Cloudflare plus optional text configuration.
 * Secrets are deliberately absent from checked-in env files and are provisioned
 * with `wrangler secret put` in deployed environments.
 */
export type AppBindings = CloudflareBindings & {
  /**
   * The bucket documents are written to, when this Worker writes them itself.
   *
   * **Optional, and truthfully so.** A developer's machine and the end-to-end
   * suite declare it; the deployed configuration does not, because R2 is not
   * enabled on that account and deployed storage goes to Cloudinary. The
   * generated bindings used to type it as always present, which was a claim the
   * deployed environment did not honour — every reader is behind
   * `relaysThroughWorker`, which is the check that decides whether it is there.
   */
  STORAGE?: R2Bucket
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
  /**
   * How many enterprises one applicant may hold at once.
   *
   * A programme rule rather than a technical limit: one promoter genuinely may
   * run several businesses, but an account registering dozens is either a
   * mistake or an attempt to hold open several applications in one cycle.
   *
   * Read on demand and validated at the point of use, so a deployment that sets
   * it to nonsense refuses the operation with a clear message rather than
   * silently admitting everybody. Unset takes the documented default in
   * `services/application/enterprise-policy.ts`; counting excludes deleted
   * enterprises, which is why deleting one frees a slot.
   */
  SEB_MAX_ENTERPRISE_PER_USER?: string
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
  /** Regional API host, e.g. https://api.eu.pingram.io. Unset means default. */
  PINGRAM_BASE_URL?: string
  /** Who a message appears to come from. Unset leaves it to the account. */
  PINGRAM_FROM_NAME?: string
  PINGRAM_FROM_ADDRESS?: string
  /** Which provider keeps documents: `r2` or `cloudinary`. Unset means `r2`,
      so an environment already configured for it does not change store by
      upgrading. Read only where ENVIRONMENT names a deployed environment. */
  STORAGE_TRANSPORT?: string
  R2_ACCOUNT_ID?: string
  R2_BUCKET_NAME?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  /** Required once STORAGE_TRANSPORT is `cloudinary`; see
      services/storage/transports/cloudinary.ts. */
  CLOUDINARY_CLOUD_NAME?: string
  CLOUDINARY_API_KEY?: string
  CLOUDINARY_API_SECRET?: string
  /** What examines uploaded documents: `cloudmersive`, or `none` to accept
      them unexamined. Unset means `none`, which `production` refuses — see
      services/document-scanner. */
  SCANNER_TRANSPORT?: string
  /** Required once SCANNER_TRANSPORT is `cloudmersive`; see
      services/document-scanner/transports/cloudmersive.ts. */
  CLOUDMERSIVE_API_KEY?: string
}
