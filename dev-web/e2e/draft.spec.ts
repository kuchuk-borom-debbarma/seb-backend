import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  startApplication,
} from './support'

test.describe('the application form', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openProgrammeCycle(page, { prefix: 'SEP-D' })
    await page.context().clearCookies()
  })

  test('saves answers as they are typed and says so', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/app/applications/${id}/form`)

    await page.getByLabel('Business name').fill('Draft Works Foods')
    // Autosave is debounced, so the indicator is the honest signal that the
    // server has the answer — not the keystroke.
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByLabel('Business name')).toHaveValue('Draft Works Foods')
  })

  test('shows every section of the form', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/app/applications/${id}/form`)

    for (const title of [
      'The enterprise',
      'About you',
      'Project cost and funding',
      'Previous support and credit',
      'Evidence',
      'Declaration',
    ]) {
      await expect(page.getByText(title, { exact: true })).toBeVisible()
    }
  })

  test('reveals conditional questions only when they apply', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/app/applications/${id}/form`)

    // The API refuses details for support that was not received, so the fields
    // are not offered until the answer calls for them.
    await expect(page.getByLabel('Scheme')).toBeHidden()
    const government = page.getByRole('group', {
      name: 'Has this enterprise received government funding before?',
    })
    await government.getByLabel('Yes').check()
    await expect(page.getByLabel('Scheme')).toBeVisible()

    await expect(page.getByLabel('Bank', { exact: true })).toBeHidden()
    const credit = page.getByRole('group', {
      name: 'Does this enterprise have existing bank credit?',
    })
    await credit.getByLabel('Yes').check()
    await expect(page.getByLabel('Bank', { exact: true })).toBeVisible()

    // "No" is a complete answer, not the absence of one, and it puts the
    // details away again.
    await government.getByLabel('No').check()
    await expect(page.getByLabel('Scheme')).toBeHidden()
  })

  test('will not submit an incomplete application, and lists what is missing', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/app/applications/${id}/review`)

    await expect(page.getByText('Not ready yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Submit application' })).toBeDisabled()

    // Every issue names its section, its question, and what to do — the API's
    // own message rather than a generic complaint.
    const rows = page.getByRole('row')
    expect(await rows.count()).toBeGreaterThan(1)
  })

  test('money is entered in rupees and survives a reload', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/app/applications/${id}/form`)

    await page.getByLabel('Total project cost (₹)').fill('500000')
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    // Stored as paise, shown as rupees: 500000 rupees must not come back as
    // 50000000 or 5000.
    await expect(page.getByLabel('Total project cost (₹)')).toHaveValue('500000')
  })
})

test.describe('the closing date', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openProgrammeCycle(page, { prefix: 'SEP-D' })
    await page.context().clearCookies()
  })

  test('is repeated where the work happens, with the time left', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })

    // On the form, because a date seen on the cycles screen three weeks ago is
    // no help to somebody halfway through the questions.
    await page.goto(`/app/applications/${id}/form`)
    await expect(page.getByText('When applications close')).toBeVisible()
    await expect(page.getByText(/closes in \d+ (day|month)/u)).toBeVisible()

    // And on the screen where somebody decides whether to send it now.
    await page.goto(`/app/applications/${id}/review`)
    await expect(page.getByText('When applications close')).toBeVisible()
  })
})

test.describe('the validation report', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openProgrammeCycle(page, { prefix: 'SEP-V' })
    await page.context().clearCookies()
  })

  test('takes the applicant to the field, not just the page', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/app/applications/${id}/review`)

    const row = page.getByRole('row').filter({ hasText: 'Your full name' }).first()
    await row.getByRole('link').click()

    await expect(page).toHaveURL(
      new RegExp(`/app/applications/${id}/form#primaryApplicantName$`, 'u'),
    )
    // Focused, not merely scrolled into view — a keyboard or screen reader user
    // has to land on the control too.
    await expect(page.getByLabel('Your full name')).toBeFocused()
  })
})
