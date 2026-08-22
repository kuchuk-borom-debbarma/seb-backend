import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      all: true,
      include: [
        'src/services/application/controllers/**/*.ts',
        'src/services/application/queries/**/*.ts',
        'src/services/application/pagination.ts',
        'src/services/application/uploads.ts',
        'src/services/application/validation.ts',
        'src/graphql/resolvers/seb/**/*.ts',
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
