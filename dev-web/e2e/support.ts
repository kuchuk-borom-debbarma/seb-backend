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

export const signIn = async (
  page: Page,
  email: string,
  password = PASSWORD,
): Promise<void> => {
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

/**
 * Creates a programme cycle and opens it for applications.
 *
 * A cycle must be open before any application can be started, so nearly every
 * applicant journey begins here. The caller must already be signed in as an
 * administrator; the cycle code is unique per call so runs never collide.
 *
 * Every field filled here is one the API requires to open a cycle — it refuses
 * without a policy reference, guidance and both dates.
 */
export const openProgrammeCycle = async (
  page: Page,
  { prefix = 'SEP', name }: { prefix?: string; name?: string } = {},
): Promise<string> => {
  const code = `${prefix}-${Date.now().toString(36).toUpperCase()}`
  await page.goto('/admin/cycles/new')
  await page.getByLabel('Cycle code').fill(code)
  await page.getByLabel('Name', { exact: true }).fill(name ?? code)
  await page.getByLabel('Policy reference').fill('TTAADC/SEP/2026/07')
  await page
    .getByLabel('Guidance for applicants')
    .fill('Attach a detailed project report.')
  const local = (value: Date) => value.toISOString().slice(0, 16)
  await page.getByLabel('Applications open').fill(local(new Date(Date.now() - 3_600_000)))
  await page
    .getByLabel('Applications close')
    .fill(local(new Date(Date.now() + 2_592_000_000)))
  await page.getByRole('button', { name: 'Create draft cycle' }).click()
  await expect(page).toHaveURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u)
  await page.getByLabel('Reason for this change').fill('Opening for the programme year.')
  await page.getByRole('button', { name: 'Open for applications' }).click()
  await expect(
    page.getByRole('button', { name: 'Close to new applications' }),
  ).toBeVisible()
  return code
}

/**
 * Signs up a fresh applicant, registers an enterprise and starts an initial
 * application in the first open cycle. Returns the application's id.
 *
 * Every step goes through the product's own screens, so a test that uses this
 * is still exercising signup, enterprise registration and application start.
 */
export const startApplication = async (
  page: Page,
  { prefix = 'applicant', businessName = 'Test Works' } = {},
): Promise<string> => {
  const email = uniqueEmail(prefix)
  await signUpApplicant(page, email)
  await signIn(page, email)

  await page.goto('/app/enterprises/new')
  await page.getByLabel('Registered or trading name').fill(businessName)
  await page.getByRole('button', { name: 'Register enterprise' }).click()

  await page.goto('/app/applications/new')
  await page.getByLabel('Enterprise').selectOption({ label: businessName })
  await page.getByLabel('Programme cycle').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Start an initial application' }).click()
  await expect(page).toHaveURL(/\/app\/applications\/[0-9a-f-]{36}$/u)
  return page.url().split('/').pop() as string
}

/**
 * Opens a cycle that requires no documents, and fills one application in it
 * right through to submission.
 *
 * Uploading evidence needs a bucket development does not have, so an
 * application in an ordinary cycle can never be submitted here — and without a
 * submission, nothing the programme office does is reachable. A cycle whose
 * policy names no required documents is a legitimate configuration the API
 * accepts, and it is the only honest way to reach the administrative flow
 * without inventing data.
 *
 * Returns the applicant's email and the submitted application's id.
 */
export const submitApplication = async (
  page: Page,
  { prefix = 'journey', businessName = 'Journey Works' } = {},
): Promise<{ email: string; id: string }> => {
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  const cycleCode = await openCycleWithoutDocuments(page, prefix.toUpperCase())
  await page.context().clearCookies()

  const email = uniqueEmail(prefix)
  await signUpApplicant(page, email)
  await signIn(page, email)

  await page.goto('/app/enterprises/new')
  await page.getByLabel('Registered or trading name').fill(businessName)
  await page.getByRole('button', { name: 'Register enterprise' }).click()

  await page.goto('/app/applications/new')
  await page.getByLabel('Enterprise').selectOption({ label: businessName })
  /*
   * By code, not by position. The suite shares one database, so by the time
   * this runs there are other open cycles — ones that do require documents —
   * and picking the second option in the list would quietly apply the wrong
   * policy.
   */
  const cycleOption = await page
    .getByLabel('Programme cycle')
    .locator('option')
    .filter({ hasText: cycleCode })
    .innerText()
  await page.getByLabel('Programme cycle').selectOption({ label: cycleOption })
  await page.getByRole('button', { name: 'Start an initial application' }).click()
  await expect(page).toHaveURL(/\/app\/applications\/[0-9a-f-]{36}$/u)
  const id = page.url().split('/').pop() as string

  await fillEveryAnswer(page, id, businessName)

  await page.goto(`/app/applications/${id}/review`)
  await expect(page.getByText('Everything needed is present')).toBeVisible()
  await page.getByRole('button', { name: 'Submit application' }).click()
  await expect(page).toHaveURL(new RegExp(`/app/applications/${id}/submitted$`, 'u'))

  return { email, id }
}

/** A cycle whose policy names no required documents. */
const openCycleWithoutDocuments = async (page: Page, prefix: string): Promise<string> => {
  const code = `${prefix}-${Date.now().toString(36).toUpperCase()}`
  await page.goto('/admin/cycles/new')
  await page.getByLabel('Cycle code').fill(code)
  await page.getByLabel('Name', { exact: true }).fill(code)
  await page.getByLabel('Policy reference').fill('TTAADC/SEP/2026/07')
  await page
    .getByLabel('Guidance for applicants')
    .fill('No documents are required in this cycle.')
  const local = (value: Date) => value.toISOString().slice(0, 16)
  await page.getByLabel('Applications open').fill(local(new Date(Date.now() - 3_600_000)))
  await page
    .getByLabel('Applications close')
    .fill(local(new Date(Date.now() + 2_592_000_000)))

  /*
   * Make every document optional. The API insists on exactly one rule for every
   * supported document type, so the rules stay — but a rule whose condition is
   * OPTIONAL asks for nothing, and an application in this cycle can be
   * submitted with no files at all.
   */
  const conditions = page.locator('select[aria-label^="Required when"]')
  for (let index = 0; index < (await conditions.count()); index += 1) {
    await conditions.nth(index).selectOption('OPTIONAL')
  }

  await page.getByRole('button', { name: 'Create draft cycle' }).click()
  await expect(page).toHaveURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u)
  await page.getByLabel('Reason for this change').fill('Opening for the programme year.')
  await page.getByRole('button', { name: 'Open for applications' }).click()
  await expect(
    page.getByRole('button', { name: 'Close to new applications' }),
  ).toBeVisible()
  return code
}

/** Every question the form asks, answered. */
export const fillEveryAnswer = async (
  page: Page,
  id: string,
  businessName: string,
): Promise<void> => {
  await page.goto(`/app/applications/${id}/form`)
  await page.getByLabel('Business name').fill(businessName)
  await page.getByLabel('Date established').fill('2025-03-10')
  await page.getByLabel('Category').selectOption({ index: 1 })
  await page.getByLabel('Sector').selectOption({ label: 'Food processing' })
  await page.getByLabel('Majority ownership is held by Scheduled Tribe members').check()
  await page.getByLabel('Your full name').fill('Bethel Debbarma')
  await page.getByLabel('Your role in the enterprise').selectOption({ index: 1 })
  await page.getByLabel('Date of birth').fill('1996-07-14')
  await page.getByLabel('Gender').selectOption({ index: 2 })
  await page.getByLabel('Block or village').fill('Khumulwng')
  await page.getByLabel('District').fill('West Tripura')
  await page.getByLabel('PIN code').fill('799045')
  await page.getByLabel('Contact number').fill('+919876543210')
  await page.getByLabel('Contact email').fill('bethel@example.test')
  await page.getByLabel('Total project cost (₹)').fill('1000000')
  await page.getByLabel('Seed fund requested (₹)').fill('250000')
  await page.getByLabel('Bank loan proposed (₹)').fill('600000')
  await page.getByLabel('Your own contribution (₹)').fill('150000')
  await page
    .getByRole('group', {
      name: 'Has this enterprise received government funding before?',
    })
    .getByLabel('No')
    .check()
  await page
    .getByRole('group', { name: 'Does this enterprise have existing bank credit?' })
    .getByLabel('No')
    .check()
  await page
    .getByRole('group', {
      name: 'Is a no-objection certificate needed for these premises?',
    })
    .getByLabel('No')
    .check()
  await page.getByLabel('Relationship').selectOption({ index: 1 })
  await page.getByLabel('Of (name)').fill('Sanjoy Debbarma')
  await page.getByLabel('Place').fill('Khumulwng')
  await page
    .getByLabel('I declare that everything in this application is true and complete.')
    .check()

  // The indicator is the honest signal that the server has the last answer.
  await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 20_000 })
}
