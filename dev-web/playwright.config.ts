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
  /*
   * Serial, and measured rather than assumed.
   *
   * Four workers was tried and is **slower**: 5.4 minutes against 3.5, at 78%
   * CPU on an eight-core machine. The browser was never the bottleneck. Every
   * worker queues behind one API Worker process, where signing in is scrypt at
   * `N=16384, r=16` and the database is a single-writer SQLite file — so
   * concurrency adds contention and no throughput.
   *
   * Making the suite genuinely parallel means giving each worker its own Worker
   * and its own database, not raising this number. Until then the number stays
   * at one, because a slower suite that also flakes is the worst of both.
   *
   * The work done to make parallelism *safe* is kept regardless — it fixed real
   * defects: the one-time code and the invitation link were found by position in
   * a shared log rather than by recipient, and `startApplication` took the
   * oldest open cycle in the database rather than its own.
   */
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
       *
       * Built only when it is stale, rather than on every run — see
       * `scripts/build-if-stale.mjs` for what counts as an input. The artifact
       * under test is unchanged; what goes is rebuilding it to discover it was
       * identical.
       */
      command: `node scripts/build-if-stale.mjs && SEB_API_URL=http://localhost:${WORKER_PORT} PORT=${WEB_PORT} node .output/server/index.mjs`,
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})

export { WORKER_PORT, WEB_PORT }
