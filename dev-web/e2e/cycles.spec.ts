import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  registerEnterprise,
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

  await page.getByLabel('Reason for this change').fill('Opening for the programme year.')
  await page.getByRole('button', { name: 'Open for applications' }).click()
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
    await page
      .getByLabel('Reason for this change')
      .fill('The application window has ended.')
    await page.getByRole('button', { name: 'Close to new applications' }).click()
    await expect(page.getByRole('button', { name: 'Archive' })).toBeVisible()
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

    // Every transition retains a reason, so the action is not offered until
    // one is written rather than failing after the click.
    await expect(
      page.getByRole('button', { name: 'Open for applications' }),
    ).toBeDisabled()
    await page.getByLabel('Reason for this change').fill('Ready.')
    await expect(
      page.getByRole('button', { name: 'Open for applications' }),
    ).toBeEnabled()
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

    await registerEnterprise(applicantPage, 'Journey Works')

    await applicantPage.goto('/applications/new')
    await applicantPage.getByLabel('Enterprise').selectOption({ label: 'Journey Works' })
    await applicantPage.getByLabel('Programme cycle').selectOption({ index: 1 })
    const selectedCycle = await applicantPage.getByLabel('Programme cycle').inputValue()

    // Registration opened from setup returns to the same cycle, selects the
    // new enterprise, and advances because both setup choices are now present.
    await applicantPage.getByRole('link', { name: 'Register another enterprise' }).click()
    await applicantPage
      .getByLabel('Registered or trading name')
      .fill('Contextual Journey Works')
    for (const category of [
      'Registration and tax',
      'Business location',
      'Contact details',
    ]) {
      await applicantPage.getByRole('button', { name: 'Next' }).click()
      await expect(applicantPage.getByRole('heading', { name: category })).toBeVisible()
    }
    await applicantPage.getByRole('button', { name: 'Register enterprise' }).click()
    await expect(applicantPage).toHaveURL(/\/applications\/new\?.*step=TYPE/u)
    const resumedSearch = new URL(applicantPage.url()).searchParams
    expect(resumedSearch.get('enterpriseId')).toBeTruthy()
    expect(resumedSearch.get('cycleId')).toBe(selectedCycle)
    await expect(
      applicantPage.getByRole('heading', { name: 'Application type' }),
    ).toBeVisible()

    await applicantPage.getByLabel('Initial application').check()
    await applicantPage
      .getByRole('button', { name: 'Start an initial application' })
      .click()

    // The application exists and opens directly at its first form category.
    await expect(applicantPage).toHaveURL(
      /\/applications\/[0-9a-f-]{36}\/form\?section=ENTERPRISE/u,
    )
    await expect(
      applicantPage.getByRole('heading', { name: 'Enterprise details' }),
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

    await registerEnterprise(applicantPage, 'Unfunded Works')

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
    await expect(applicantPage.getByLabel('Expansion application')).toBeDisabled()

    await applicant.close()
  })
})
