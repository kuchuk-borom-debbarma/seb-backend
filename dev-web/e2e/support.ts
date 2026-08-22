/**
 * Shared machinery for the end-to-end suite.
 *
 * Everything here drives the product the way a person would, or reads something
 * the running system genuinely produced. Nothing writes to the database
 * directly: if a test needs an account, it signs one up.
 */
import { readFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'

export const WORKER_URL = 'http://localhost:9899'
const WORKER_LOG = new URL('../.playwright/worker.log', import.meta.url).pathname

/** The password every seeded account uses. Long enough for the signup policy. */
export const PASSWORD = 'correct horse battery staple'

/**
 * The account the suite bootstraps as the first super administrator.
 *
 * It must match `FIRST_SUPER_ADMIN_EMAIL` in `.dev.vars`, because the Worker
 * will only ever promote that exact address.
 */
export const SUPER_ADMIN_EMAIL = 'founder@example.com'

/** A fresh address per run, so re-running never collides with a reserved email. */
export const uniqueEmail = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`

/**
 * Reads the six-digit signup code out of the Worker's console output.
 *
 * Notification delivery is a `console.log` transport in development (roadmap
 * §18), so this is the only place the code exists. Polling rather than reading
 * once, because the Worker writes the line asynchronously through `tee`.
 */
export const latestOtp = async (afterByteOffset = 0): Promise<string> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const log = await readFile(WORKER_LOG, 'utf8').catch(() => '')
    const codes = [...log.slice(afterByteOffset).matchAll(/\b(\d{6})\b/gu)]
    const last = codes.at(-1)
    if (last?.[1]) return last[1]
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('No signup code appeared in the Worker log within 10 seconds.')
}

/** Where the Worker log currently ends, so a later read ignores earlier codes. */
export const workerLogLength = async (): Promise<number> =>
  (await readFile(WORKER_LOG, 'utf8').catch(() => '')).length

/** Registers a real applicant through the signup screens and returns the email. */
export const signUpApplicant = async (page: Page, email: string): Promise<void> => {
  const offset = await workerLogLength()

  await page.goto('/sign-up')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Send verification code' }).click()

  const code = await latestOtp(offset)
  await page.getByLabel(/Six-digit code/u).fill(code)
  await page.getByLabel('Choose a password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  // Signup deliberately does not create a session, so it lands on sign-in.
  await page.waitForURL('**/sign-in')
}

export const signIn = async (page: Page, email: string, password = PASSWORD): Promise<void> => {
  await page.goto('/sign-in')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'))
}

export const signOut = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL('**/sign-in')
}

/**
 * Promotes the configured applicant to the first super administrator.
 *
 * Uses the same curl-only endpoint an operator would, because it is absent from
 * GraphQL by design and this is the only way an administrator can ever exist.
 */
export const bootstrapSuperAdmin = async (): Promise<void> => {
  const response = await fetch(`${WORKER_URL}/internal/bootstrap/first-super-admin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer local-dev-first-super-admin-secret-32b',
    },
    body: JSON.stringify({ currentPassword: PASSWORD }),
  })
  const body = (await response.json()) as { success: boolean; message: string | null }
  expect(body.success, `Bootstrap failed: ${body.message}`).toBe(true)
}

/**
 * The sidebar section headings currently on screen, which mirror capability.
 *
 * Lower-cased because the headings are upper-cased by CSS, and a test should
 * assert which sections exist rather than how they are styled.
 */
export const navigationSections = async (page: Page): Promise<string[]> => {
  const headings = await page
    .locator('nav[aria-label="Portal sections"] p')
    .allInnerTexts()
  return headings.map((heading) => heading.toLowerCase())
}
