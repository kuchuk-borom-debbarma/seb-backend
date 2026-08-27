// fallow-ignore-file unused-file
// A vitest `setupFiles` entry, named in the config rather than imported, so
// nothing reaches it from a module graph.
/**
 * What the runtime suite's `env` carries.
 *
 * The bindings the Workers pool injects, declared so the suite is typed against
 * them. **No D1 and no schema.** There is no D1 binding any more, and nothing in
 * this suite reads a database — anything that does belongs in the service suite,
 * where it runs against a real Postgres rather than a stand-in.
 *
 * The one exception is the connection test named in `vitest.runtime.config.ts`,
 * which exists to prove the Hyperdrive binding and `nodejs_compat` work at all.
 * It needs a real database and is therefore skipped unless one is configured.
 */
declare module 'cloudflare:test' {
  interface ProvidedEnv extends CloudflareBindings {
    /*
     * Declared here rather than inherited: `wrangler types` generates
     * `CloudflareBindings` from the deployment config, and the bucket and queue
     * this suite binds are the test config's.
     */
    STORAGE: R2Bucket
    QUEUE?: Queue
    AUTH_SECRET: string
    ROLE_INVITE_SECRET: string
    PORTAL_BASE_URL: string
    FRONTEND_ORIGINS: string
    AUTH_COOKIE_SAME_SITE: string
    APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT: string
    RATE_LIMIT_DISABLED?: string
    FIRST_SUPER_ADMIN_EMAIL: string
    FIRST_SUPER_ADMIN_SECRET: string
    R2_ACCOUNT_ID: string
    R2_BUCKET_NAME: string
    R2_ACCESS_KEY_ID: string
    R2_SECRET_ACCESS_KEY: string
  }
}

export {}
