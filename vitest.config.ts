import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    // The Worker's own suite only. `dev-web` is a separate package whose
    // end-to-end specs are run by Playwright against a real browser, and which
    // would otherwise be collected here by the default `**/*.spec.ts` glob.
    include: ['test/**/*.test.ts'],
    // Istanbul instrumentation makes the intentionally end-to-end
    // administration journey slower than Vitest's five-second default.
    testTimeout: 30_000,
    coverage: {
      provider: 'istanbul',
      all: true,
      include: [
        'src/services/application/controllers/**/*.ts',
        'src/services/application/queries/**/*.ts',
        'src/services/application/ledger.ts',
        'src/services/application/pagination.ts',
        'src/services/application/uploads.ts',
        'src/services/application/validation.ts',
        // Authentication controllers stay outside the gate for the same reason
        // `controllers/auth.ts` does: their lost-race refusals are only
        // reachable from a genuinely concurrent writer, and password
        // confirmation is synchronous CPU work that blocks the test isolate, so
        // no disturbance can be timed into that window. The guarded SQL those
        // branches depend on is gated below, which is where the invariants live.
        'src/services/auth/queries/access.ts',
        'src/services/auth/support.ts',
        'src/graphql/resolvers/access/**/*.ts',
        'src/graphql/resolvers/seb/**/*.ts',
        'src/services/admin/controllers/**/*.ts',
        'src/services/admin/queries/**/*.ts',
        'src/services/admin/pagination.ts',
        'src/services/admin/support.ts',
        'src/services/admin/document-scanner.ts',
        'src/services/audit/controllers/**/*.ts',
        'src/services/audit/queries/**/*.ts',
        'src/services/audit/support.ts',
        'src/graphql/resolvers/admin/**/*.ts',
        'src/graphql/validation.ts',
      ],
      reporter: ['text', 'json'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
    poolOptions: {
      workers: {
        main: './src/index.ts',
        isolatedStorage: true,
        singleWorker: true,
        wrangler: {
          configPath: './wrangler.test.jsonc',
        },
        miniflare: {
          bindings: {
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
    setupFiles: ['./test/setup.ts'],
  },
})
