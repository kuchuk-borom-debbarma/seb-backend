import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against a real Worker and a real database.
 *
 * The suite owns its whole environment rather than borrowing a running one:
 * it starts its own Worker on port 9899 with an isolated D1 directory
 * (`--persist-to`), and its own web server on 9880 pointed at that Worker.
 * That means it never collides with `npm run local` on 9999/9990, never reads
 * or writes the data you are looking at, and can reset the database between
 * runs.
 *
 * The Worker's output is captured to a log file because signup is the one flow
 * that genuinely needs it: notification delivery is a console transport in
 * development, so the six-digit code is only observable there. Testing the real
 * signup path is worth that small amount of plumbing.
 */
const WORKER_PORT = 9899
const WEB_PORT = 9880

export default defineConfig({
  testDir: './e2e',
  // Serial by default: these tests share one database, and the funding and
  // review journeys deliberately build on each other's state.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    // Seeding runs as an ordinary project so it happens after the web servers
    // are listening, which a `globalSetup` hook is not guaranteed to do.
    { name: 'setup', testMatch: /seed\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: `cd .. && npm run test:worker`,
      port: WORKER_PORT,
      // Always a fresh Worker: reusing one would leave the previous run's
      // database in place and make the suite order-dependent.
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      /*
       * The built artifact, not the dev server.
       *
       * Vite's dependency optimizer pre-bundles on first request, and a cold
       * server raced with the first navigation leaves the client entry
       * unfetchable and the page unhydrated. Testing the build removes that
       * class of flake entirely and exercises what would actually be deployed.
       */
      command: `npm run build && SEB_API_URL=http://localhost:${WORKER_PORT} PORT=${WEB_PORT} node .output/server/index.mjs`,
      url: `http://localhost:${WEB_PORT}/sign-in`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})

export { WORKER_PORT, WEB_PORT }
