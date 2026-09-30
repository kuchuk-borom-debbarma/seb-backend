/**
 * Shared machinery for the end-to-end suite.
 *
 * Everything here drives the product the way a person would, or reads something
 * the running system genuinely produced. Nothing writes to the database
 * directly: if a test needs an account, it signs one up.
 */
import { readFile } from 'node:fs/promises'
import { expect, type Locator, type Page } from '@playwright/test'


/**
 * Publishes a policy PDF on the cycle page the browser is already on.
 *
 * The local scanner is permissive and its verdict lands just after the
 * upload's own response, so the API is polled — cheaper than reloading the
 * page under a parallel run — until the verdict is the ACCEPTED that opening
 * the cycle waits for, and the page then reloads once to show it.
 */
export const uploadPolicyDocument = async (page: Page): Promise<void> => {
  const cycleId = page.url().match(/\/admin\/cycles\/([0-9a-f-]{36})/u)?.[1]
  if (!cycleId) throw new Error(`Not on a cycle page: ${page.url()}`)
  await page.setInputFiles('input[type="file"][accept="application/pdf"]', {
    name: 'policy.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n'),
  })
  // Finalization done: the card names the file. The verdict may still lag.
  await expect(page.getByText('policy.pdf', { exact: false }).first()).toBeVisible()
  await expect
    .poll(async () => {
      const response = await page.request.post(`${WORKER_URL}/graphql`, {
        data: {
          query: `query($id: ID!) { admin { programmeCycle { byId(id: $id) {
            response { policyDocument { scanStatus } }
          } } } }`,
          variables: { id: cycleId },
        },
        headers: { 'content-type': 'application/json' },
      })
      const body = await response.json()
      return body.data?.admin.programmeCycle.byId.response?.policyDocument?.scanStatus
    }, { timeout: 30_000 })
    .toBe('ACCEPTED')
  await page.reload()
}

/**
 * Types into a field until the value holds.
 *
 * A server-rendered page is interactive before React takes it over, and a fill
 * that lands in between is wiped when it does. Under a loaded machine that
 * window is long enough to lose the first field of a form, and the failure
 * then surfaces steps later — a sign-in that never leaves the login page, an
 * enterprise with no name — nowhere near its cause. So the value is typed,
 * and checked to still be there a moment later, until it is.
 */
export const fillSettled = async (field: Locator, value: string): Promise<void> => {
  await expect(async () => {
    await field.fill(value)
    await expect(field).toHaveValue(value, { timeout: 500 })
    await field.page().waitForTimeout(200)
    await expect(field).toHaveValue(value, { timeout: 500 })
  }).toPass({ timeout: 15_000 })
}

export const WORKER_URL =
  `http://localhost:${process.env.SEB_E2E_WORKER_PORT ?? 9899}`
const WORKER_LOG = new URL('../.playwright/worker.log', import.meta.url).pathname

/** The password every seeded account uses. Long enough for the signup policy. */
export const PASSWORD = 'correct horse battery staple'

/**
 * The account the suite bootstraps as the first super administrator.
 *
 * It must match `FIRST_SUPER_ADMIN_EMAIL` in `.env.local`, because the Worker
 * will only ever promote that exact address.
 */
export const SUPER_ADMIN_EMAIL = 'founder@example.com'

/** A fresh address per run, so re-running never collides with a reserved email. */
export const uniqueEmail = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`

/**
 * The six-digit code sent to one address, read from the Worker's console output.
 *
 * Locally the notification transport prints rather than delivers, so this is
 * the only place the code exists. It marks its line `DEV_EMAIL` precisely so
 * this can find it. Polling rather than reading once, because the Worker writes
 * the line asynchronously through `tee`.
 *
 * **Keyed on the recipient, not on position.** This used to take a byte offset
 * and return the *last* `DEV_EMAIL` line after it, which is only correct while
 * one signup happens at a time: run two at once and both readers take whichever
 * the Worker flushed second, so one of them silently fills somebody else's code
 * and fails later as an unexplained navigation timeout.
 *
 * The transport writes the recipient into the same line
 * (`services/external-notification/transports/console.ts`), so the address is
 * the key, and concurrent signups no longer collide.
 *
 * One ordering assumption does remain, and it is this function's own: when an
 * address has been sent more than one code, it takes the newest line. That is
 * right for a resend, but it cannot tell "the new code has not been flushed
 * yet" from "there is no new code", so a caller that resends to an address and
 * reads immediately can be handed the previous one. No caller does — every
 * resend here is followed by a screen assertion first.
 */
export const latestOtp = async (
  recipient: string,
  options: { differentFrom?: string } = {},
): Promise<string> => {
  const wanted = recipient.trim().toLowerCase()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const log = await readFile(WORKER_LOG, 'utf8').catch(() => '')
    // Newest first: an address that signs up twice wants the later code.
    for (const line of [...log.matchAll(/^DEV_EMAIL (.*)$/gmu)].reverse()) {
      const message = readDevEmail(line[1])
      if (message?.to?.trim().toLowerCase() !== wanted) continue
      const code = message.text?.match(/\b(\d{6})\b/u)
      if (!code?.[1]) continue
      /*
       * Keep waiting when the newest code is one the caller already had.
       *
       * This is the ordering caveat above, made answerable. One address can be
       * sent a second code — signing up and then resetting — and the log is a
       * pipe, so for a moment the newest line is still the old code. Without
       * this the caller is handed the stale one and fails much later with "the
       * code is invalid", nowhere near the cause.
       */
      if (options.differentFrom !== undefined && code[1] === options.differentFrom) break
      return code[1]
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`No new code for ${recipient} appeared in the Worker log within 10 seconds.`)
}

/**
 * One `DEV_EMAIL` line, parsed, or `null` when it is not one this cares about.
 *
 * Tolerant on purpose: the log is a pipe, and a line can be read while it is
 * still being written. A half-flushed line is not an error, it is a line to try
 * again on.
 */
const readDevEmail = (
  payload: string | undefined,
): { to?: string; subject?: string; text?: string } | null => {
  if (!payload) return null
  try {
    return JSON.parse(payload) as { to?: string; subject?: string; text?: string }
  } catch {
    return null
  }
}

/** Registers a real applicant through the signup screens and returns the email. */
export const signUpApplicant = async (page: Page, email: string): Promise<void> => {
  await page.goto('/sign-up')
  await fillSettled(page.getByLabel('Email address'), email)
  await page.getByRole('button', { name: 'Send verification code' }).click()

  const code = await latestOtp(email)
  await page.getByLabel(/Six-digit code/u).fill(code)
  await page.getByLabel('Choose a password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  // Signup deliberately does not create a session, so it lands on the
  // sign-in side of the login screen.
  await page.waitForURL('**/login')
}

export const signIn = async (
  page: Page,
  email: string,
  password = PASSWORD,
): Promise<void> => {
  /*
   * One door for everyone: the API decides by the roles the account holds,
   * and the redirect sends a staff account to the office either way. Exact,
   * because "Remembered it? Sign in" also contains the words.
   */
  await page.goto('/login')
  await fillSettled(page.getByLabel('Email address'), email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

export const signOut = async (page: Page): Promise<void> => {
  /*
   * Exact, because `/account/sessions` also offers "Sign out other devices"
   * and "Sign out everywhere". Without it this helper is ambiguous on that one
   * screen and fails there with a strict-mode violation rather than anywhere
   * near what the test was actually checking.
   */
  // The control lives in the account menu now, so open that first.
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  // Signing out lands on the public site, not a sign-in form.
  await page.waitForURL((url) => url.pathname === '/')
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
  const headings = page.locator('nav[aria-label="Portal sections"] p')
  /*
   * Wait for the first heading rather than sampling. `toHaveURL` passes the
   * moment the address changes, which can be before the shell has rendered —
   * reading immediately after it returned an empty list and made a correct page
   * look broken.
   */
  await headings.first().waitFor()
  return (await headings.allInnerTexts()).map((heading) => heading.toLowerCase())
}

/**
 * Creates a programme cycle and opens it for applications.
 *
 * A cycle must be open before any application can be started, so nearly every
 * applicant journey begins here. The caller must already be signed in as an
 * administrator; the cycle code is unique per call so runs never collide.
 *
 * Every field filled here is one the API requires to open a cycle — it refuses
 * without a policy PDF, guidance and an opening date.
 */
export const openProgrammeCycle = async (
  page: Page,
  { prefix = 'SEP', name }: { prefix?: string; name?: string } = {},
): Promise<string> => {
  // Random suffix as well as the clock: two workers opening a cycle in the
  // same millisecond with the same prefix would otherwise collide.
  const code = `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
  await page.goto('/admin/cycles/new')
  // Filled only after hydration settles: a fill that lands before React
  // takes the inputs over is wiped when it does.
  await expect(page.getByLabel('Cycle code')).toHaveValue(/^SEP-\d{4}$/u)
  await page.getByLabel('Cycle code').fill(code)
  await page.getByLabel('Name', { exact: true }).fill(name ?? code)
  await page
    .getByLabel('Guidance for applicants')
    .fill('Attach a detailed project report.')
  const local = (value: Date) => value.toISOString().slice(0, 16)
  await page.getByLabel('Applications open').fill(local(new Date(Date.now() - 3_600_000)))
  await choosePipeline(page)
  await page.getByRole('button', { name: 'Create draft cycle' }).click()
  await expect(page).toHaveURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u)
  await uploadPolicyDocument(page)
  await page.getByRole('button', { name: 'Open for applications' }).click()
  await page.getByLabel('Reason for this action').fill('Opening for the programme year.')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(
    page.getByRole('button', { name: 'Close to new applications' }),
  ).toBeVisible()
  return code
}

/**
 * Chooses the seeded pipeline on the cycle form's "Pipeline & kinds" step.
 *
 * By its key, never by position: the pipeline spec publishes routes of its own
 * into the same database, and a cycle pinned to one of those would be worked
 * by nobody. The kinds are left as the form offers them — one first
 * application per enterprise.
 */
export const choosePipeline = async (page: Page, key: string = SEEDED_PIPELINE.key): Promise<void> => {
  await page.getByRole('button', { name: /Pipeline & kinds/u }).click()
  const select = page.getByLabel('Pipeline', { exact: true })
  const option = select.locator('option').filter({ hasText: `(${key})` })
  await expect(option).toHaveCount(1)
  await select.selectOption(await option.getAttribute('value') as string)
}

/**
 * Registers an enterprise with only its name, through the wizard's own steps.
 *
 * The wizard asks its questions one category at a time, and every question
 * after the name is optional, so the helper advances past each remaining
 * category with the defaults and submits from the last one. It waits for the
 * enterprise's own page so the record exists before the caller moves on.
 */
export const registerEnterprise = async (
  page: Page,
  businessName: string,
): Promise<void> => {
  await page.goto('/enterprises/new')
  await fillSettled(page.getByLabel('Registered or trading name'), businessName)
  /*
   * The date matters even though the wizard lets it stay blank: an open
   * cycle sorts enterprises by trading age at submission, and an enterprise
   * without a date is refused there with ESTABLISHMENT_DATE_MISSING. Two
   * years ago lands in CATEGORY_A under the default 24-month threshold.
   */
  const established = new Date()
  established.setUTCFullYear(established.getUTCFullYear() - 2)
  await page.getByLabel('Date established').fill(established.toISOString().slice(0, 10))
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole('button', { name: 'Next' }).click()
  }
  await page.getByRole('button', { name: 'Register enterprise' }).click()
  await expect(page).toHaveURL(/\/enterprises\/[0-9a-f-]{36}$/u)
}

/**
 * Signs up a fresh applicant, registers an enterprise and starts an initial
 * application in the first open cycle. Returns the application's id.
 *
 * Every step goes through the product's own screens, so a test that uses this
 * is still exercising signup, enterprise registration and application start.
 */
/**
 * Picks the cycle an application is being started in, by code.
 *
 * **By code, never by position.** The suite shares one database, so by the time
 * any of this runs there are other open cycles — some requiring documents —
 * and the options are ordered by `opensAt` while every helper opens its cycle
 * at "an hour ago". Taking the second option quietly applied another cycle's
 * policy, and only worked while the files happened to run in one order.
 *
 * **And it copes with there being only one.** With a single open cycle the
 * screen picks it and disables the control: there is no choice to make, and
 * offering one would be theatre. A disabled `<select>` cannot be acted on, so
 * this asserts the right cycle is already chosen instead. That state is the
 * ordinary one for a fresh deployment, and while this was two copies of the
 * same code with the fix in one of them, every spec that started an
 * application depended on some other spec having opened a second cycle first.
 */
export const chooseProgrammeCycle = async (
  page: Page,
  cycleCode: string,
): Promise<void> => {
  const cycle = page.getByLabel('Programme cycle')
  const label = await cycle.locator('option').filter({ hasText: cycleCode }).innerText()
  if (await cycle.isDisabled()) {
    expect(await cycle.locator('option:checked').innerText()).toBe(label)
    return
  }
  await cycle.selectOption({ label })
}

export const startApplication = async (
  page: Page,
  {
    prefix = 'applicant',
    businessName = 'Test Works',
    cycleCode,
    signedIn = false,
  }: {
    prefix?: string
    businessName?: string
    cycleCode: string
    /** The caller has already signed an applicant in; use them. */
    signedIn?: boolean
  },
): Promise<string> => {
  if (!signedIn) {
    const email = uniqueEmail(prefix)
    await signUpApplicant(page, email)
    await signIn(page, email)
  }

  await registerEnterprise(page, businessName)

  await page.goto('/applications/new')
  // A sole enterprise arrives preselected and locked; selecting would throw.
  const enterpriseSelect = page.getByLabel('Enterprise')
  await expect(enterpriseSelect).toHaveValue(/./u, { timeout: 15_000 }).catch(() => {})
  if (await enterpriseSelect.isEnabled()) {
    await enterpriseSelect.selectOption({ label: businessName })
  }
  // `cycleCode` is required, so there is no way back to picking by position.
  // Why that matters is on `chooseProgrammeCycle`.
  await chooseProgrammeCycle(page, cycleCode)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio', { name: 'First application' }).check()
  await page.getByRole('button', { name: 'Start: First application' }).click()
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/u)
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
  {
    prefix = 'journey',
    businessName = 'Journey Works',
  }: {
    prefix?: string
    businessName?: string
  } = {},
): Promise<{ email: string; id: string }> => {
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  const cycleCode = await openCycleWithoutDocuments(page, prefix.toUpperCase())
  await page.context().clearCookies()

  const email = uniqueEmail(prefix)
  await signUpApplicant(page, email)
  await signIn(page, email)

  await registerEnterprise(page, businessName)

  await page.goto('/applications/new')
  // A sole enterprise arrives preselected and locked; selecting would throw.
  const enterpriseSelect = page.getByLabel('Enterprise')
  await expect(enterpriseSelect).toHaveValue(/./u, { timeout: 15_000 }).catch(() => {})
  if (await enterpriseSelect.isEnabled()) {
    await enterpriseSelect.selectOption({ label: businessName })
  }
  await chooseProgrammeCycle(page, cycleCode)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio', { name: 'First application' }).check()
  await page.getByRole('button', { name: 'Start: First application' }).click()
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/u)
  const id = page.url().split('/').pop() as string

  await fillEveryAnswer(page, id, businessName)

  await page.goto(`/applications/${id}/review`)
  await expect(page.getByText('Ready to submit')).toBeVisible()
  await page.getByRole('button', { name: 'Submit application' }).click()
  await expect(page).toHaveURL(new RegExp(`/applications/${id}/submitted$`, 'u'))

  return { email, id }
}

/**
 * The answers a complete initial application gives, as the API takes them.
 *
 * For the default template the cycle form creates. Two things the API insists
 * on: a save replaces the whole answer set, so every question is present and
 * an unanswered one is an explicit null; and the owners are members of a
 * reusable group, so their keys are qualified by the group (`OWNERS__NAME`).
 * The applicant asks for a grant and a bank loan, so the whole route — TTC,
 * Industries & Commerce and a bank — is reachable; every other conditional
 * question is answered "no".
 */
const COMPLETE_ANSWERS = {
  OWNERS: [
    {
      OWNERS__NAME: 'Rina Debbarma',
      OWNERS__DESIGNATION: 'PROPRIETOR',
      OWNERS__DATE_OF_BIRTH: '1995-02-10',
      OWNERS__GENDER: 'FEMALE',
      OWNERS__RELATIONSHIP_TYPE: 'DAUGHTER_OF',
      OWNERS__RELATED_PERSON_NAME: 'Maya Debbarma',
    },
  ],
  // A grant of ₹1,00,000 and a loan of ₹5,00,000, State Bank of India first.
  WANTS_GRANT: true,
  SEED_FUND_REQUESTED_PAISE: 10_000_000,
  WANTS_BANK_LOAN: true,
  LOAN_BANK_FIRST_CHOICE: 'SBI',
  LOAN_BANK_SECOND_CHOICE: 'TGB',
  LOAN_AMOUNT_REQUESTED_PAISE: 50_000_000,
  RECEIVED_GOVERNMENT_FUNDING: false,
  GOVERNMENT_SCHEME_NAME: null,
  GOVERNMENT_FUNDING_AMOUNT_PAISE: null,
  GOVERNMENT_FUNDING_SANCTION_YEAR: null,
  NOC_REQUIRED: false,
}

/**
 * A submitted application, reached by the applicant's own screens up to the
 * form and by the API the form itself calls from there.
 *
 * For a spec about what happens *after* submission. The form's own specs own
 * filling the form in; a spec about the office's view of a file should not
 * fail because a form label changed, and the answers it saves and the
 * submission it makes are the same mutations the form sends — nothing here
 * writes a row the product could not.
 */
export const submittedThroughApi = async (
  page: Page,
  {
    prefix = 'submitted',
    businessName = 'Submitted Works',
    answers = {},
  }: {
    prefix?: string
    businessName?: string
    /** Answers to change from the complete set, such as asking for no loan. */
    answers?: Record<string, unknown>
  } = {},
): Promise<{ email: string; id: string }> => {
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  const cycleCode = await openCycleWithoutDocuments(page, prefix.toUpperCase())
  await page.context().clearCookies()

  const email = uniqueEmail(prefix)
  await signUpApplicant(page, email)
  await signIn(page, email)
  const id = await startApplication(page, { cycleCode, businessName, signedIn: true })

  // The browser's own session, so the API sees the applicant exactly as the
  // form would.
  const call = async (query: string, variables: Record<string, unknown>) => {
    const response = await page.request.post(`${WORKER_URL}/graphql`, {
      data: { query, variables },
      headers: { 'content-type': 'application/json' },
    })
    const body = await response.json()
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    return body.data
  }
  const saved = (await call(
    `mutation($input: SaveApplicationDraftInput!) { seb { application { saveDraft(input: $input) {
      success message response { currentVersion statusVersion } } } } }`,
    { input: { applicationId: id, expectedVersion: 1, expectedStatusVersion: 1, answers: { ...COMPLETE_ANSWERS, ...answers } } },
  )).seb.application.saveDraft
  expect(saved.success, saved.message).toBe(true)
  const submitted = (await call(
    `mutation($input: ApplicationVersionInput!) { seb { application { submit(input: $input) {
      success message } } } }`,
    {
      input: {
        applicationId: id,
        expectedVersion: saved.response.currentVersion,
        expectedStatusVersion: saved.response.statusVersion,
      },
    },
  )).seb.application.submit
  expect(submitted.success, submitted.message).toBe(true)
  return { email, id }
}

/** A cycle whose policy names no required documents. */
export const openCycleWithoutDocuments = async (
  page: Page,
  prefix: string,
): Promise<string> => {
  // Random suffix as well as the clock: two workers opening a cycle in the
  // same millisecond with the same prefix would otherwise collide.
  const code = `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
  await page.goto('/admin/cycles/new')
  // Filled only after hydration settles: a fill that lands before React
  // takes the inputs over is wiped when it does.
  await expect(page.getByLabel('Cycle code')).toHaveValue(/^SEP-\d{4}$/u)
  await page.getByLabel('Cycle code').fill(code)
  await page.getByLabel('Name', { exact: true }).fill(code)
  await page
    .getByLabel('Guidance for applicants')
    .fill('No documents are required in this cycle.')
  const local = (value: Date) => value.toISOString().slice(0, 16)
  await page.getByLabel('Applications open').fill(local(new Date(Date.now() - 3_600_000)))

  await choosePipeline(page)

  await page.getByRole('button', { name: 'Create draft cycle' }).click()
  await expect(page).toHaveURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u)
  const cycleId = page.url().split('/').pop() as string

  /*
   * Make every document optional.
   *
   * This used to drive `select[aria-label^="Required when"]` — one control per
   * document rule, on the cycle form. Documents are `FILE` questions of the
   * cycle's own template now, and there is no screen for editing a template
   * yet, so this goes through `admin.formTemplate` instead. Arranging state,
   * not asserting through it: what the test is about is an application that can
   * be submitted with no files.
   */
  await makeDocumentsOptional(page, cycleId)
  // Each of those was a cycle revision, so the page is holding a version that
  // has moved on — and opening quotes the version it was rendered with.
  await page.reload()
  await uploadPolicyDocument(page)

  await page.getByRole('button', { name: 'Open for applications' }).click()
  await page.getByLabel('Reason for this action').fill('Opening for the programme year.')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(
    page.getByRole('button', { name: 'Close to new applications' }),
  ).toBeVisible()
  return code
}

/** Only what this helper reads back and hands straight to the write. */
type FormQuestionRow = {
  key: string
  stageKey: string
  type: string
  label: string
  helpText: string | null
  requirement: string
  source: string
  position: number
  validation: { maxFileBytes: number | null }
}

/**
 * Turns every document a cycle asks for into one it merely accepts.
 *
 * Reads the cycle's own questions back and rewrites each `FILE` one as
 * `OPTIONAL`, one mutation apiece — each is a cycle revision, so each quotes
 * the version the last one produced.
 */
/**
 * Sets a closing time on an open cycle through the API.
 *
 * The wizard no longer offers one — cycles stay open until the office closes
 * them — but the server mutation remains for cycles that carry a deadline,
 * and the applicant-facing closing notice is what a spec arranges this for.
 */
export const setClosingTime = async (
  page: Page,
  cycleId: string,
  closesAt: Date,
): Promise<void> => {
  const call = async (query: string, variables: Record<string, unknown>) => {
    const response = await page.request.post(`${WORKER_URL}/graphql`, {
      data: { query, variables },
      headers: { 'content-type': 'application/json' },
    })
    const body = await response.json()
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    return body.data
  }
  const read = await call(
    `query($id: ID!) { admin { programmeCycle { byId(id: $id) { response {
      head { currentVersion }
    } } } } }`,
    { id: cycleId },
  )
  const changed = await call(
    `mutation($input: CycleClosingInput!) {
      admin { programmeCycle { changeClosingTime(input: $input) { success message } } }
    }`,
    { input: {
      id: cycleId,
      expectedVersion: read.admin.programmeCycle.byId.response.head.currentVersion,
      closesAt: closesAt.toISOString(),
      reason: 'The spec needs a published deadline.',
    } },
  )
  expect(
    changed.admin.programmeCycle.changeClosingTime.success,
    changed.admin.programmeCycle.changeClosingTime.message ?? '',
  ).toBe(true)
}

const makeDocumentsOptional = async (page: Page, cycleId: string): Promise<void> => {
  const call = async (query: string, variables: Record<string, unknown>) => {
    const response = await page.request.post(`${WORKER_URL}/graphql`, {
      data: { query, variables },
      headers: { 'content-type': 'application/json' },
    })
    const body = await response.json()
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    return body.data
  }

  const read = await call(
    `query($id: ID!) { admin { programmeCycle { byId(id: $id) { response {
      head { currentVersion }
      formTemplate { fields {
        key stageKey type role label helpText requirement source position
        validation { maxFileBytes }
      } }
    } } } } }`,
    { id: cycleId },
  )
  const cycle = read.admin.programmeCycle.byId.response
  let version = cycle.head.currentVersion as number

  for (const field of cycle.formTemplate.fields as FormQuestionRow[]) {
    if (field.type !== 'FILE' || field.requirement === 'OPTIONAL') continue
    const done = await call(
      `mutation($input: FormQuestionMutationInput!) {
        admin { formTemplate { updateQuestion(input: $input) {
          success message response { head { currentVersion } }
        } } }
      }`,
      {
        input: {
          scope: {
            programmeCycleId: cycleId,
            expectedVersion: version,
            reason: 'This cycle asks for no documents.',
          },
          field: {
            stageKey: field.stageKey,
            fieldKey: field.key,
            fieldType: 'FILE',
            label: field.label,
            helpText: field.helpText,
            requirement: 'OPTIONAL',
            source: field.source,
            sortOrder: field.position,
            maxFileBytes: field.validation.maxFileBytes,
          },
        },
      },
    )
    const result = done.admin.formTemplate.updateQuestion
    expect(result.success, result.message ?? '').toBe(true)
    version = result.response.head.currentVersion
  }
}

/**
 * The first stage — one owner, every member answered — ending on "Save &
 * next" so the journey stands on stage two. On its own for the specs that
 * only need to get past the first screen of a staged form.
 */
export const fillOwnersStage = async (page: Page): Promise<void> => {
  // One entry, added explicitly — a fresh group starts empty.
  await page.getByRole('button', { name: 'Add another owner', exact: true }).click()
  await page.getByLabel('Full name').fill('Bethel Debbarma')
  await page.getByLabel('Role in the enterprise').selectOption({ index: 1 })
  await page.getByLabel('Date of birth').fill('1996-07-14')
  await page.getByLabel('Gender').selectOption({ index: 2 })
  await page.getByLabel('Relationship').selectOption({ index: 1 })
  await page.getByLabel('Of (name)').fill('Sanjoy Debbarma')
  await page.getByRole('button', { name: 'Save & next' }).click()
}

/**
 * The funding stage: a grant and a bank loan, State Bank of India first.
 *
 * The amounts and banks appear only once their yes/no is answered, so each is
 * filled after the question that reveals it. Matched by the start of the label:
 * the renderer adds the unit and any "(optional)" after the cycle's words.
 */
export const fillFundingStage = async (
  page: Page,
  { grant = true, loan = true }: { grant?: boolean; loan?: boolean } = {},
): Promise<void> => {
  await page.getByRole('group', { name: 'Do you want a grant?' }).getByLabel(grant ? 'Yes' : 'No').check()
  if (grant) await page.getByLabel(/^Desired grant amount/u).fill('250000')
  await page.getByRole('group', { name: 'Do you want a bank loan?' }).getByLabel(loan ? 'Yes' : 'No').check()
  if (loan) {
    await page.getByLabel(/^First choice of bank/u).selectOption('SBI')
    await page.getByLabel(/^Second choice of bank/u).selectOption('TGB')
    await page.getByLabel(/^Loan amount requested/u).fill('500000')
  }
}

/** Every question the form asks, answered. */
export const fillEveryAnswer = async (
  page: Page,
  id: string,
  _businessName: string,
): Promise<void> => {
  /*
   * The form is one stage per screen now, and "Save & next" force-saves the
   * debounced draft before moving — so filling a stage and advancing is also
   * the proof its answers persisted enough to move on.
   *
   * The enterprise's own facts are no longer questions: the name this helper
   * used to type into the form now lives on the enterprise entity alone,
   * which is why the parameter goes unused.
   */
  const saveAndNext = async () => {
    await page.getByRole('button', { name: 'Save & next' }).click()
  }

  await page.goto(`/applications/${id}/form`)

  await fillOwnersStage(page)

  await fillFundingStage(page)
  await saveAndNext()

  // Previous support: "no", so nothing else appears.
  await page
    .getByRole('group', {
      name: 'Has this enterprise received government funding before?',
    })
    .getByLabel('No')
    .check()
  await saveAndNext()

  // Evidence stage: the one non-file question.
  await page
    .getByRole('group', {
      name: 'Is a no-objection certificate needed for these premises?',
    })
    .getByLabel('No')
    .check()

  /*
   * The indicator is the signal that the server holds the last answer, and the
   * reload is what makes a silent save failure land *here* rather than on a
   * review screen listing two dozen questions and saying nothing about why.
   */
  await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 20_000 })
  await page.reload()
  await expect(
    page
      .getByRole('group', {
        name: 'Is a no-objection certificate needed for these premises?',
      })
      .getByLabel('No'),
  ).toBeChecked({ timeout: 20_000 })
}

/**
 * Reads the invitation link out of the Worker's console output.
 *
 * Locally the notification transport prints rather than delivers, so — exactly
 * as with the signup code — this is the only place the link exists. Anchored on
 * the same `DEV_EMAIL` marker, and matching the `/invite#…` shape rather than
 * "a URL somewhere", so another notification in the log cannot be mistaken for
 * this one.
 */
export const latestInviteLink = async (recipient: string): Promise<string> => {
  const wanted = recipient.trim().toLowerCase()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const log = await readFile(WORKER_LOG, 'utf8').catch(() => '')
    // Keyed on the invitee, for the reason `latestOtp` is: two invitations in
    // flight at once would otherwise cross, and accepting somebody else's token
    // grants the wrong role to the wrong account rather than failing loudly.
    for (const line of [...log.matchAll(/^DEV_EMAIL (.*)$/gmu)].reverse()) {
      const message = readDevEmail(line[1])
      if (message?.to?.trim().toLowerCase() !== wanted) continue
      const found = message.text?.match(/\/invite#([A-Za-z0-9_-]+)/u)
      if (found?.[1]) return `/invite#${found[1]}`
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`No invitation link for ${recipient} appeared in the Worker log within 10 seconds.`)
}

/**
 * Signs somebody up, invites them to a role, and accepts on their behalf.
 *
 * The whole flow, because it is the only way to become staff: there is no
 * seeded reviewer to borrow, which is the point of the invitation existing.
 */
/**
 * The roles the office composes for itself before any spec runs.
 *
 * Authority is data, so a deployment starts with none of these — the six fixed
 * roles they replace no longer exist. Composed by `seed.setup.ts` through the
 * product's own screens, then granted or offered by the specs.
 */
export const OFFICE_ROLES = [
  {
    key: 'CASEWORK_READER',
    name: 'Casework reader',
    description: 'Reads every submitted file and changes nothing.',
    /*
     * Reads only. Reading a file and working it are different jobs, and
     * somebody preparing a case needs the first without the second — so this
     * role holds no `note` and no stage act, and the screens draw no control
     * it cannot use.
     *
     * Deliberately nothing that draws the Administration section of the
     * navigation either: the cycle rules they judge against arrive inside the
     * workspace, so they need no separate way in.
     */
    permissions: [['application', 'read'], ['policy_document', 'read']],
  },
  {
    key: 'PROGRAMME_OFFICER',
    name: 'Programme officer',
    description: 'Reads and annotates every file, and runs the office, short of shaping the programme.',
    /*
     * Office-wide reading and notes, but no stage acts: which files somebody
     * may move is decided by the stages their roles own, and this role owns
     * none. The stage roles below are how a file is worked.
     */
    permissions: [
      ['application', 'read'], ['application', 'note'],
      ['programme_cycle', 'read'], ['policy_document', 'read'], ['pipeline', 'read'],
      ['analytics', 'read'], ['user', 'read'], ['role', 'read'], ['role', 'invite'],
    ],
  },
  {
    key: 'BANNER_EDITOR',
    name: 'Announcer',
    description: 'Writes the public announcement banner, and nothing else.',
    permissions: [
      ['announcement', 'read'], ['announcement', 'create'], ['announcement', 'update'],
      ['announcement', 'publish'], ['announcement', 'remove'], ['announcement', 'reorder'],
    ],
  },
] as const

/**
 * Every act a stage can ask for, and the note a send-back or a rejection
 * keeps. The four stage roles hold the same permissions and differ only in the
 * stage each owns — which is exactly what stage ownership exists to express.
 */
const STAGE_WORK = [
  ['stage', 'read'], ['stage', 'advance'], ['stage', 'return'],
  ['stage', 'request_revision'], ['stage', 'decide'], ['stage', 'close'],
  ['application', 'note'],
] as const

/**
 * The roles that work the Mission SEP route, one per stage of the example
 * pipeline, keyed like the stages they own.
 */
export const STAGE_ROLES = [
  { key: 'TTC', name: 'TTC', description: 'Works the TTC stage.', permissions: STAGE_WORK },
  {
    key: 'INDUSTRIES_COMMERCE',
    name: 'Industries & Commerce',
    description: 'Works the Industries & Commerce stage.',
    permissions: STAGE_WORK,
  },
  { key: 'SBI_BANK', name: 'SBI Bank', description: 'Works the State Bank of India stage.', permissions: STAGE_WORK },
  { key: 'TGB_BANK', name: 'TGB Bank', description: 'Works the Tripura Gramin Bank stage.', permissions: STAGE_WORK },
] as const

/** The pipeline every spec's cycle is worked in: the example, published. */
export const SEEDED_PIPELINE = { key: 'MISSION_SEP', name: 'Mission SEP' } as const

/**
 * Publishes the worked example as the pipeline every cycle chooses, and hands
 * each of its stages to the stage role of the same key.
 *
 * Through the API rather than the editor: the editor has its own spec, and
 * every other spec only needs a published route to exist. It is the same set
 * of mutations the editor sends.
 */
export const seedPipeline = async (page: Page): Promise<void> => {
  const call = graphqlAs(page)
  const detail = `success message response { id draft { revision } stages { stageKey ownersVersion } }`
  const created = (await call(
    `mutation($input: CreatePipelineInput!) { admin { pipeline { create(input: $input) { ${detail} } } } }`,
    { input: { ...SEEDED_PIPELINE, description: 'The TTC, Industries & Commerce and bank route.', startFromExample: true } },
  )).admin.pipeline.create
  expect(created.success, created.message).toBe(true)
  const published = (await call(
    `mutation($input: PublishPipelineInput!) { admin { pipeline { publish(input: $input) { ${detail} } } } }`,
    { input: { pipelineId: created.response.id, expectedRevision: created.response.draft.revision, changeNote: 'The first route.' } },
  )).admin.pipeline.publish
  expect(published.success, published.message).toBe(true)
  for (const stage of published.response.stages as { stageKey: string; ownersVersion: number }[]) {
    const owned = (await call(
      `mutation($input: SetPipelineStageOwnersInput!) { admin { pipeline { setStageOwners(input: $input) { success message } } } }`,
      { input: {
        pipelineId: created.response.id,
        stageKey: stage.stageKey,
        expectedOwnersVersion: stage.ownersVersion,
        roleKeys: [stage.stageKey],
        reason: 'The office that works this stage.',
      } },
    )).admin.pipeline.setStageOwners
    expect(owned.success, owned.message).toBe(true)
  }
}

/**
 * A GraphQL call in the browser's own session, failing the test on a
 * transport-level error. Business refusals come back in the envelope for the
 * caller to assert on.
 */
export const graphqlAs = (page: Page) =>
  async (query: string, variables: Record<string, unknown> = {}) => {
    const response = await page.request.post(`${WORKER_URL}/graphql`, {
      data: { query, variables },
      headers: { 'content-type': 'application/json' },
    })
    const body = await response.json()
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    return body.data
  }

/**
 * Composes one role through the screens that compose one.
 *
 * Two acts, as the product has them: naming it, then choosing what it may do.
 * The second takes the operator's password, because it moves what every holder
 * may do the moment it lands.
 */
export type ComposableRole = {
  key: string
  name: string
  description: string
  permissions: readonly (readonly [resource: string, action: string])[]
}

export const composeRole = async (
  page: Page,
  role: ComposableRole,
): Promise<void> => {
  await page.goto('/admin/roles/new')
  await page.getByLabel('What the office calls it').fill(role.name)
  await page.getByLabel('Key').fill(role.key)
  await page.getByLabel('What it is for').fill(role.description)
  await page.getByRole('button', { name: 'Compose the role' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/roles/${role.key}$`, 'u'))

  for (const [resource, action] of role.permissions) {
    await page
      .getByRole('group', { name: humanReadable(resource) })
      .getByRole('checkbox', { name: new RegExp(`^${humanReadable(action)}`, 'u') })
      .check()
  }
  await page.getByLabel('Your password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Save what it may do' }).click()
  await expect(page.getByRole('button', { name: 'Save what it may do' })).toBeDisabled()
}

/** `programme_cycle` → "Programme cycle", as the editor renders it. */
const humanReadable = (key: string): string =>
  key.replace(/_/gu, ' ').replace(/^./u, (first) => first.toUpperCase())

/**
 * Invites somebody to a role and has them accept it.
 *
 * Accepting *exchanges* their applicant access for the role, so this is the way
 * to produce a staff-only account — one that signs in to the office rather than
 * to the applicant portal. A direct grant adds instead, leaving them both.
 *
 * Takes any composed role's key, not only the seeded ones, so a test can
 * compose the narrowest role it wants to exercise.
 */
export const inviteSomebodyTo = async (page: Page, role: string) => {
  const email = uniqueEmail('invited')
  // Signup deliberately creates no session, so there is nobody to sign out.
  await signUpApplicant(page, email)

  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  await page.goto('/admin/invite')
  await fillSettled(page.getByLabel('Their email address'), email)
  await page.getByRole('button', { name: 'Look them up' }).click()
  await expect(page.getByRole('heading', { name: email })).toBeVisible()
  // Selected by value rather than label, because the labels carry a
  // description after the role name.
  await page.getByLabel('Invite them to be').selectOption(role)
  await page.getByLabel('Why').fill('Joining the intake team')
  await page.getByRole('button', { name: 'Send the invitation' }).click()
  await expect(page.getByText(`Invitation sent to ${email}`)).toBeVisible()

  // The link is never shown to the issuer; it only exists in what was sent.
  await expect(page.getByText('/invite#')).toHaveCount(0)
  const link = await latestInviteLink(email)
  await signOut(page)

  await signIn(page, email, PASSWORD)
  await page.goto(link)
  await page.getByRole('button', { name: 'Accept the invitation' }).click()
  await expect(page.getByRole('heading', { name: /You are now/u })).toBeVisible()
  return email
}
