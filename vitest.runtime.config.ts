import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

/**
 * The suite that genuinely needs the runtime.
 *
 * Everything that is really logic against a database moved to
 * `vitest.service.config.ts`, where it runs against PGlite — a real Postgres,
 * hermetic and fast. What is left here is what workerd alone provides, and the
 * list is deliberately short because each entry costs the whole runtime to test:
 *
 * - **R2.** The storage backends verify a stored object's size, type and
 *   checksum, and a mock bucket would be asserting the mock.
 * - **The queue consumer's `ack` and `retry`**, which are the runtime's own
 *   message handles.
 * - **`waitUntil` outliving a response**, which is a property of the request
 *   lifecycle rather than of any function.
 * - **The edge body limit and the connection-level CORS preflight**, which are
 *   refused before Hono ever sees them — so a test outside workerd would be
 *   asserting Hono's behaviour instead of the platform's.
 *
 * **It must keep at least one test that opens a real connection through the
 * Hyperdrive binding.** Nothing else runs in workerd any more, so a missing
 * `nodejs_compat` flag would otherwise be discovered at deploy.
 */
export default defineWorkersConfig({
  test: {
    include: ['test/runtime/**/*.test.ts'],
    setupFiles: ['./test/runtime/setup.ts'],
    poolOptions: {
      workers: {
        main: './src/index.ts',
        isolatedStorage: true,
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          bindings: {
            RATE_LIMIT_DISABLED: 'true',
            AUTH_SECRET: 'test-secret-that-is-at-least-thirty-two-bytes',
            ROLE_INVITE_SECRET: 'test-invite-secret-that-is-at-least-32-bytes',
            PORTAL_BASE_URL: 'https://portal.example.test',
            FRONTEND_ORIGINS: 'https://app.example.test',
            AUTH_COOKIE_SAME_SITE: 'lax',
            APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT: '5',
            FIRST_SUPER_ADMIN_EMAIL: 'applicant@example.com',
            FIRST_SUPER_ADMIN_SECRET: 'test-first-super-admin-secret-at-least-32-bytes',
            R2_ACCOUNT_ID: 'test-account-id',
            R2_BUCKET_NAME: 'seb-backend-test',
            R2_ACCESS_KEY_ID: 'test-access-key',
            R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
          },
        },
      },
    },
  },
})
