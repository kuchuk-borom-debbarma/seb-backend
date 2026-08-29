/**
 * Shared machinery for the end-to-end suite.
 *
 * Everything here drives the product the way a person would, or reads something
 * the running system genuinely produced. Nothing writes to the database
 * directly: if a test needs an account, it signs one up.
 */
import { readFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'


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

export const WORKER_URL = 'http://localhost:9899'
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
  await page.getByLabel('Email address').fill(email)
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
  await page.getByLabel('Email address').fill(email)
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
  await page.getByLabel('Registered or trading name').fill(businessName)
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
export const startApplication = async (
  page: Page,
  {
    prefix = 'applicant',
    businessName = 'Test Works',
    cycleCode,
  }: { prefix?: string; businessName?: string; cycleCode: string },
): Promise<string> => {
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
  /*
   * By code, never by position, and `cycleCode` is required so there is no way
   * back to position.
   *
   * The options are ordered by `opensAt`, and every helper opens its cycle at
   * "an hour ago" — so index 1 is the oldest still-open cycle in the whole
   * database, never the one the caller just made. Selecting it worked only
   * because the files needing a document-requiring cycle happened to run before
   * the ones that open cycles without documents, and under parallel files not
   * even that. `submitApplication` selects by code for the same reason.
   */
  const cycle = page.getByLabel('Programme cycle')
  const label = await cycle.locator('option').filter({ hasText: cycleCode }).innerText()
  await cycle.selectOption({ label })
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio', { name: 'Initial application' }).check()
  await page.getByRole('button', { name: 'Start an initial application' }).click()
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
    configureIdentifiers,
  }: {
    prefix?: string
    businessName?: string
    /**
     * Runs on the cycle form before it is created, so a test can set the
     * identifier rules this application will be judged by. The rules freeze
     * with the submission, which is the only way to reach a desk review that
     * demands something other than the default.
     */
    configureIdentifiers?: (page: Page) => Promise<void>
  } = {},
): Promise<{ email: string; id: string }> => {
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  const cycleCode = await openCycleWithoutDocuments(
    page, prefix.toUpperCase(), configureIdentifiers,
  )
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
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio', { name: 'Initial application' }).check()
  await page.getByRole('button', { name: 'Start an initial application' }).click()
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/u)
  const id = page.url().split('/').pop() as string

  await fillEveryAnswer(page, id, businessName)

  await page.goto(`/applications/${id}/review`)
  await expect(page.getByText('Everything needed is present')).toBeVisible()
  await page.getByRole('button', { name: 'Submit application' }).click()
  await expect(page).toHaveURL(new RegExp(`/applications/${id}/submitted$`, 'u'))

  return { email, id }
}

/** A cycle whose policy names no required documents. */
const openCycleWithoutDocuments = async (
  page: Page,
  prefix: string,
  configureIdentifiers?: (page: Page) => Promise<void>,
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

  if (configureIdentifiers) {
    // The identifier rules live on the wizard's last step.
    await page.getByRole('button', { name: /Desk review & Reasons/u }).click()
    await configureIdentifiers(page)
  }

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
  await page.getByRole('button', { name: 'Add owners' }).click()
  await page.getByLabel('Full name').fill('Bethel Debbarma')
  await page.getByLabel('Role in the enterprise').selectOption({ index: 1 })
  await page.getByLabel('Date of birth').fill('1996-07-14')
  await page.getByLabel('Gender').selectOption({ index: 2 })
  await page.getByLabel('Relationship').selectOption({ index: 1 })
  await page.getByLabel('Of (name)').fill('Sanjoy Debbarma')
  await page.getByRole('button', { name: 'Save & next' }).click()
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

  // Project cost and funding. Exact, because the "Why … is asked" opener
  // beside a label contains the label's own words.
  await page.getByLabel('Total project cost (₹)', { exact: true }).fill('1000000')
  await page.getByLabel('Seed fund requested (₹)', { exact: true }).fill('250000')
  // Both are `OPTIONAL` in the cycle's own template, so the renderer marks
  // them — the label is the cycle's words plus what the software adds.
  await page.getByLabel('Bank loan proposed (₹) (optional)').fill('600000')
  await page.getByLabel('Your own contribution (₹) (optional)').fill('150000')
  await saveAndNext()

  // Previous support and credit: both "no", so nothing else appears.
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
