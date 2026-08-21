/**
 * Runtime bindings supplied by Cloudflare plus optional text configuration.
 * Secrets are deliberately absent from checked-in env files and are provisioned
 * with `wrangler secret put` in deployed environments.
 */
export type AppBindings = CloudflareBindings & {
  AUTH_SECRET?: string
  FRONTEND_ORIGINS?: string
  AUTH_COOKIE_SAME_SITE?: string
  APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT?: string
}
