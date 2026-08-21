import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
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
          },
        },
      },
    },
    setupFiles: ['./test/setup.ts'],
  },
})
