/**
 * Runtime bindings supplied by Cloudflare plus optional text configuration.
 * Secrets are deliberately absent from checked-in env files and are provisioned
 * with `wrangler secret put` in deployed environments.
 */
export type AppBindings = CloudflareBindings & {
  AUTH_SECRET?: string
  /**
   * Keys the digest of the identity numbers a reviewer transcribes. Separate
   * from AUTH_SECRET on purpose: rotating session signing must not silently
   * stop the duplicate check from matching anything already recorded.
   */
  IDENTIFIER_SECRET?: string
  FRONTEND_ORIGINS?: string
  AUTH_COOKIE_SAME_SITE?: string
  APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT?: string
  FIRST_SUPER_ADMIN_EMAIL?: string
  FIRST_SUPER_ADMIN_SECRET?: string
  R2_ACCOUNT_ID?: string
  R2_BUCKET_NAME?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
}
