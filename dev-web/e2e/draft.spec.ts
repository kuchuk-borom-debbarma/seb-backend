import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  fillEveryAnswer,
  openProgrammeCycle,
  signIn,
  startApplication,
  submitApplication,
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
    await page.goto(`/applications/${id}/form`)

    await page.getByLabel('Business name').fill('Draft Works Foods')
    // Autosave is debounced, so the indicator is the honest signal that the
    // server has the answer — not the keystroke.
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByLabel('Business name')).toHaveValue('Draft Works Foods')
  })

  test('requires each category before moving to the next one', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Guided Draft Works',
    })
    await page.goto(`/applications/${id}/form?section=FINANCIAL`)

    await expect(page.getByRole('heading', { name: 'Enterprise details' })).toBeVisible()
    await expect(page).toHaveURL(
      new RegExp(`/applications/${id}/form\\?section=ENTERPRISE$`, 'u'),
    )
    await expect(page.getByLabel('Your full name')).toBeHidden()

    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByLabel('Sector')).toBeFocused()
    await expect(page.getByLabel('Your full name')).toBeHidden()

    await page.getByLabel('Date established').fill('2025-03-10')
    await page.getByLabel('Category', { exact: true }).selectOption({ index: 1 })
    await page.getByLabel('Sector').selectOption({ label: 'Food processing' })
    await page.getByLabel('Majority ownership is held by Scheduled Tribe members').check()
    await page.getByRole('button', { name: 'Next' }).click()

    await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible()
    await expect(page).toHaveURL(/section=APPLICANT_PROFILE/u)
    await expect(page.getByLabel('Business name')).toBeHidden()
  })

  test('shows every section of the form', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form`)

    const categories = page.getByRole('navigation', { name: 'Form categories' })
    for (const title of [
      'Enterprise details',
      'About you',
      'Project cost and funding',
      'Previous support and credit',
      'Evidence requirements',
      'Declaration',
      'Attach evidence',
      'Review and submit',
    ]) {
      await expect(categories.getByRole('button', { name: title })).toBeAttached()
    }
  })

  test('moves from the declaration to evidence and resumes there while files are missing', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'evidence-resume',
      businessName: 'Evidence Resume Works',
    })

    // The final form-category Next must reach the upload screen even though
    // the cycle's required files have not been attached yet.
    await fillEveryAnswer(page, id, 'Evidence Resume Works')

    // A continuation link or a browser reload through the plain form address
    // must preserve that reachable next step, rather than returning to the
    // first form category just because the upload screen has no `section`.
    await page.goto(`/applications/${id}/form`)
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/documents$`, 'u'))
    await expect(page.getByRole('heading', { name: 'Attach evidence' })).toBeVisible()
  })

  test('keeps completed categories clickable while evidence is still outstanding', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'evidence-navigation',
      businessName: 'Evidence Navigation Works',
    })
    await fillEveryAnswer(page, id, 'Evidence Navigation Works')

    const categories = page.getByRole('navigation', { name: 'Form categories' })
    await categories.getByRole('button', { name: 'About you' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/applications/${id}/form\\?section=APPLICANT_PROFILE$`, 'u'),
    )
    await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible()

    await categories.getByRole('button', { name: 'Evidence requirements' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/applications/${id}/form\\?section=DOCUMENTS$`, 'u'),
    )
    await expect(
      page.getByRole('heading', { name: 'Evidence requirements' }),
    ).toBeVisible()

    // Evidence itself remains reachable so the missing required files can be
    // attached; only Review stays blocked until that work is done.
    await categories.getByRole('button', { name: 'Attach evidence' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/documents$`, 'u'))
  })

  test('reveals conditional questions only when they apply', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(
      `/applications/${id}/form?section=PRIOR_FUNDING#receivedGovernmentFunding`,
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
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form?section=FINANCIAL#totalProjectCostPaise`)

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
    await openProgrammeCycle(page, { prefix: 'SEP-V' })
    await page.context().clearCookies()
  })

  test('takes the applicant to the field, not just the page', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/review`)

    const row = page.getByRole('row').filter({ hasText: 'Your full name' }).first()
    await row.getByRole('link').click()

    await expect(page).toHaveURL(
      new RegExp(
        `/applications/${id}/form\\?section=APPLICANT_PROFILE#primaryApplicantName$`,
        'u',
      ),
    )
    // Focused, not merely scrolled into view — a keyboard or screen reader user
    // has to land on the control too.
    await expect(page.getByLabel('Your full name')).toBeFocused()
  })
})

test.describe('locked application categories', () => {
  test('opens a requested revision at the editable category and keeps others locked', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const { email, id } = await submitApplication(page, {
      prefix: 'revision-journey',
      businessName: 'Revision Journey Works',
    })

    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/applications/${id}`)
    await page.getByRole('button', { name: 'Start desk review' }).click()

    for (const check of [
      'IDENTITY_KYC',
      'ST_ELIGIBILITY',
      'MAJORITY_OWNERSHIP',
      'JURISDICTION',
      'FORM_COMPLETENESS',
      'DOCUMENT_COMPLETENESS',
      'ANSWER_DOCUMENT_CONSISTENCY',
      'DPR_FEASIBILITY',
    ]) {
      await page.locator(`input[name="${check}"]`).nth(1).check()
    }
    await page.locator('input[name="EXPANSION_EVIDENCE"]').last().check()
    await page.getByRole('radio', { name: 'Ask the applicant to correct it' }).check()
    await page.getByLabel('About you').check()
    await page.getByLabel('Reason', { exact: true }).selectOption({ index: 1 })
    await page
      .getByLabel('What the applicant must do')
      .fill('Confirm the applicant contact details.')
    await page
      .getByLabel('Message to the applicant')
      .fill('Please confirm the contact details and send the application again.')
    await page.getByRole('button', { name: 'Complete the review' }).click()
    await expect(
      page.locator('.badge').filter({ hasText: 'Revision required' }).first(),
    ).toBeVisible()

    await page.context().clearCookies()
    await signIn(page, email)
    await page.goto(`/applications/${id}/form`)
    await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible()
    await expect(page.getByLabel('Your full name')).toBeEnabled()

    await page.getByRole('button').filter({ hasText: 'Enterprise details' }).click()
    await expect(page.getByLabel('Business name')).toBeDisabled()
    await expect(page.getByText('must stay exactly as it was submitted')).toBeVisible()
  })

  test('allows every category of a submitted application to be browsed read only', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const { id } = await submitApplication(page, {
      prefix: 'read-only-journey',
      businessName: 'Read Only Journey Works',
    })

    await page.goto(`/applications/${id}/form`)
    await expect(page.getByLabel('Business name')).toBeDisabled()
    await page.getByRole('button').filter({ hasText: 'About you' }).click()
    await expect(page.getByLabel('Your full name')).toBeDisabled()
    await page.getByRole('button').filter({ hasText: 'Attach evidence' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/documents$`, 'u'))
    await expect(page.getByRole('heading', { name: 'Attach evidence' })).toBeVisible()
    await page.getByRole('button').filter({ hasText: 'Review and submit' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/review$`, 'u'))
  })
})
