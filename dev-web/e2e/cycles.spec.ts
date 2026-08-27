import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  signIn,
  signUpApplicant,
  uniqueEmail,
} from './support'

/**
 * Creates a cycle and opens it, which is what makes the applicant journey
 * possible at all: an application cannot be started until a cycle is open.
 */
const createOpenCycle = async (page: Page, name: string) => {
  await page.goto('/admin/cycles/new')
  // Filled only after hydration settles: a fill that lands before React
  // takes the inputs over is wiped when it does.
  await expect(page.getByLabel('Cycle code')).toHaveValue(/^SEP-\d{4}$/u)
  await page.getByLabel('Cycle code').fill(name)
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Policy reference').fill('TTAADC/SEP/2026/01')
  await page
    .getByLabel('Guidance for applicants')
    .fill('Apply with your enterprise registration and a detailed project report.')

  // An open window is what `availableProgrammeCycles` filters on, so a cycle
  // with no dates is open in status but not accepting applications.
  const opens = new Date(Date.now() - 60 * 60 * 1000)
  const closes = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const local = (value: Date) => value.toISOString().slice(0, 16)
  await page.getByLabel('Applications open').fill(local(opens))
  await page.getByLabel('Applications close').fill(local(closes))

  await page.getByRole('button', { name: 'Create draft cycle' }).click()
  await expect(page).toHaveURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u)

  await page.getByRole('button', { name: 'Open for applications' }).click()
  await page.getByLabel('Reason for this action').fill('Opening for the programme year.')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(
    page.getByRole('button', { name: 'Close to new applications' }),
  ).toBeVisible()
}

test.describe('cycle administration', () => {
  test('creates a draft cycle and moves it through its lifecycle', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const code = `SEP-${Date.now().toString(36).toUpperCase()}`
    await createOpenCycle(page, code)

    // Closing needs a reason too, and the offered actions follow the state.
    await expect(page.getByRole('button', { name: 'Open for applications' })).toBeHidden()
    await page.getByRole('button', { name: 'Close to new applications' }).click()
    await page
      .getByLabel('Reason for this action')
      .fill('The application window has ended.')
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByRole('button', { name: 'Archive' })).toBeVisible()
  })

  /**
   * What a cycle asks and what it enforces, shown back on its own page.
   *
   * Both were write-only: the questions could only be seen by starting an
   * application against the cycle, and the eligibility rules could be sent and
   * never read at all — so the editor had nothing to populate from and resent
   * its own defaults, which is how a settled age limit gets reset by somebody
   * changing something else.
   *
   * Addressed by heading and by text rather than by a role name that a
   * navigation might also match, per the three-spec scar this suite carries.
   */
  test('shows an officer the questions and the rules of a cycle', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const code = `SEP-${Date.now().toString(36).toUpperCase()}`
    await createOpenCycle(page, code)

    const questions = page.locator('[data-guide="cycle-questions"]')
    await expect(questions.getByRole('heading', { name: 'Owners' })).toBeVisible()
    // A role-bound question says so: the programme reads it across cycles, and
    // an officer renaming one needs to know it is not theirs alone to move.
    await expect(
      questions.getByText('read by the programme as Seed fund requested paise'),
    ).toBeVisible()

    const frozen = page.locator('[data-guide="cycle-frozen"]')
    await expect(frozen.getByText('18 to 60')).toBeVisible()
    /*
     * `UNRESOLVED` is a real state — no amount is checked against a ceiling
     * nobody has approved — so it reads as a sentence rather than a blank.
     */
    await expect(
      frozen.getByText('Not settled, so no amount is checked against one'),
    ).toBeVisible()
  })

  test('refuses a lifecycle change without a reason', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/cycles/new')
    await page
      .getByLabel('Cycle code')
      .fill(`SEP-NR-${Date.now().toString(36).toUpperCase()}`)
    await page.getByLabel('Policy reference').fill('TTAADC/SEP/2026/02')
    await page.getByLabel('Guidance for applicants').fill('Guidance.')
    const now = new Date()
    await page.getByLabel('Applications open').fill(now.toISOString().slice(0, 16))
    await page
      .getByLabel('Applications close')
      .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16))
    await page.getByRole('button', { name: 'Create draft cycle' }).click()
    await expect(page).toHaveURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u)

    // Every transition retains a reason, so the modal's confirmation is not
    // offered until one is written rather than failing after the click.
    await page.getByRole('button', { name: 'Open for applications' }).click()
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await page.getByLabel('Reason for this action').fill('Ready.')
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  })

  test('an open cycle unblocks the applicant journey', async ({ page, browser }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const code = `SEP-APP-${Date.now().toString(36).toUpperCase()}`
    await createOpenCycle(page, code)

    // A separate applicant, to prove the cycle is genuinely published rather
    // than merely visible to the person who created it.
    const applicant = await browser.newContext()
    const applicantPage = await applicant.newPage()
    const email = uniqueEmail('applicant')
    await signUpApplicant(applicantPage, email)
    await signIn(applicantPage, email)

    await applicantPage.goto('/cycles')
    await expect(applicantPage.getByText(code).first()).toBeVisible()

    await applicantPage.goto('/enterprises/new')
    await applicantPage.getByLabel('Registered or trading name').fill('Journey Works')
    for (let step = 0; step < 3; step += 1) {
      await applicantPage.getByRole('button', { name: 'Next' }).click()
    }
    await applicantPage.getByRole('button', { name: 'Register enterprise' }).click()

    await applicantPage.goto('/applications/new')
    await applicantPage.getByLabel('Enterprise').selectOption({ label: 'Journey Works' })
    await applicantPage.getByLabel('Programme cycle').selectOption({ index: 1 })
    await applicantPage.getByRole('button', { name: 'Next' }).click()
    await applicantPage.getByRole('radio', { name: 'Initial application' }).check()
    await applicantPage
      .getByRole('button', { name: 'Start an initial application' })
      .click()

    // The application exists, and the status rail says whose turn it is.
    await expect(applicantPage).toHaveURL(/\/applications\/[0-9a-f-]{36}$/u)
    await expect(applicantPage.getByText('Your turn')).toBeVisible()
    await expect(
      applicantPage.getByRole('heading', { name: 'Unsubmitted draft' }),
    ).toBeVisible()

    await applicant.close()
  })

  test('expansion is refused with the real reasons for a first-time enterprise', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const code = `SEP-EXP-${Date.now().toString(36).toUpperCase()}`
    await createOpenCycle(page, code)

    const email = uniqueEmail('applicant')
    const applicant = await page.context().browser()!.newContext()
    const applicantPage = await applicant.newPage()
    await signUpApplicant(applicantPage, email)
    await signIn(applicantPage, email)

    await applicantPage.goto('/enterprises/new')
    await applicantPage.getByLabel('Registered or trading name').fill('Unfunded Works')
    for (let step = 0; step < 3; step += 1) {
      await applicantPage.getByRole('button', { name: 'Next' }).click()
    }
    await applicantPage.getByRole('button', { name: 'Register enterprise' }).click()

    await applicantPage.goto('/applications/new')
    await applicantPage.getByLabel('Enterprise').selectOption({ label: 'Unfunded Works' })
    await applicantPage.getByLabel('Programme cycle').selectOption({ index: 1 })
    await applicantPage.getByRole('button', { name: 'Next' }).click()

    // The API's own wording, not a message invented by the client.
    await expect(
      applicantPage.getByText(
        'This enterprise has no sanctioned funding award to expand from.',
      ),
    ).toBeVisible()
    // The expansion choice itself is withheld, not merely the submission.
    await expect(
      applicantPage.getByRole('radio', { name: 'Expansion application' }),
    ).toBeDisabled()

    await applicant.close()
  })
})
