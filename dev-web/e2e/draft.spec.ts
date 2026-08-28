import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  startApplication,
} from './support'

/** The cycle this file opened, so its applications start in that one. */
let cycleCode = ''

test.describe('the application form', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    cycleCode = await openProgrammeCycle(page, { prefix: 'SEP-D' })
    await page.context().clearCookies()
  })

  test('saves answers as they are typed and says so', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form`)

    await page.getByRole('button', { name: 'Add owners' }).click()
    await page.getByLabel('Full name').fill('Bethel Debbarma')
    // Autosave is debounced, so the indicator is the honest signal that the
    // server has the answer — not the keystroke.
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByLabel('Full name')).toHaveValue('Bethel Debbarma')
  })

  test('shows every section of the form', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form`)

    // One stage renders at a time now; the journey rail names them all.
    const rail = page.getByRole('navigation', { name: 'Form categories' })
    for (const title of [
      'Owners',
      'Project cost and funding',
      'Previous support and credit',
      'Evidence',
    ]) {
      await expect(rail.getByText(title, { exact: true })).toBeVisible()
    }
  })

  test('reveals conditional questions only when they apply', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    // The field hash is the issue-link form — the one address allowed to
    // open a stage whose predecessors are incomplete.
    await page.goto(
      `/applications/${id}/form?stage=PRIOR_FUNDING#RECEIVED_GOVERNMENT_FUNDING`,
    )

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
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/review`)

    await expect(page.getByText('Not ready yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Submit application' })).toBeDisabled()

    // Every issue names its section, its question, and what to do — the API's
    // own message rather than a generic complaint.
    const rows = page.getByRole('row')
    expect(await rows.count()).toBeGreaterThan(1)
  })

  test('money is entered in rupees and survives a reload', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(
      `/applications/${id}/form?stage=FINANCIAL#TOTAL_PROJECT_COST_PAISE`,
    )

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
    cycleCode = await openProgrammeCycle(page, { prefix: 'SEP-D' })
    await page.context().clearCookies()
  })

  test('is repeated where the work happens, with the time left', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })

    // On the form, because a date seen on the cycles screen three weeks ago is
    // no help to somebody halfway through the questions.
    await page.goto(`/applications/${id}/form`)
    await expect(page.getByText('When applications close')).toBeVisible()
    await expect(page.getByText(/closes in \d+ (day|month)/u)).toBeVisible()

    // And on the screen where somebody decides whether to send it now.
    await page.goto(`/applications/${id}/review`)
    await expect(page.getByText('When applications close')).toBeVisible()
  })
})

test.describe('the validation report', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    cycleCode = await openProgrammeCycle(page, { prefix: 'SEP-V' })
    await page.context().clearCookies()
  })

  test('takes the applicant to the field, not just the page', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/review`)

    // The group itself is the addressable control when no entries exist.
    const row = page.getByRole('row').filter({ hasText: 'Owners' }).first()
    await row.getByRole('link').click()

    await expect(page).toHaveURL(
      // The template's own key, which is now the question's name everywhere.
      new RegExp(`/applications/${id}/form(\\?stage=OWNERS)?#OWNERS$`, 'u'),
    )
  })
})
