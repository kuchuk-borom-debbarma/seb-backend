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

    await page.getByLabel('Majority ownership is held by Scheduled Tribe members').check()
    // Autosave is debounced, so the indicator is the honest signal that the
    // server has the answer — not the keystroke.
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(
      page.getByLabel('Majority ownership is held by Scheduled Tribe members'),
    ).toBeChecked()
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

    await page.getByRole('button', { name: 'Save & Next' }).click()
    await expect(page.getByLabel('Your full name')).toBeHidden()

    await page.getByLabel('Category A').check()
    await page.getByLabel('Majority ownership is held by Scheduled Tribe members').check()
    await page.getByRole('button', { name: 'Save & Next' }).click()

    await expect(page.getByRole('heading', { name: 'Owners' })).toBeVisible()
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
      'Owners',
      'Project cost and funding',
      'Previous support and credit',
      'Evidence requirements',
      'Attach evidence',
      'Review',
    ]) {
      await expect(categories.getByRole('button', { name: title })).toBeAttached()
    }
    await expect(categories.getByRole('button')).toHaveCount(7)
    await expect(categories.getByText('Declaration')).toHaveCount(0)
  })

  test('locks copied identity data and offers only the approved address values', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'locked-details',
      businessName: 'Locked Details Works',
    })
    await page.goto(`/applications/${id}/form`)

    for (const label of [
      'Business name',
      'Date established',
      'Registration',
      'GSTIN',
      'Sector',
    ]) {
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled()
    }
    await expect(page.getByLabel('Category A')).toBeEnabled()
    await expect(
      page.getByLabel('Majority ownership is held by Scheduled Tribe members'),
    ).toBeEnabled()

    await page.getByLabel('Category A').check()
    await page.getByLabel('Majority ownership is held by Scheduled Tribe members').check()
    await page.getByRole('button', { name: 'Save & Next' }).click()

    await expect(page.getByLabel('Registered email address')).toBeDisabled()
    await expect(page.getByText(/not a personal or residential address/u)).toBeVisible()
    expect(await page.getByLabel('District').locator('option').allTextContents()).toEqual(
      [
        'Select district',
        'Dhalai',
        'Gomati',
        'Khowai',
        'North Tripura',
        'Sepahijala',
        'South Tripura',
        'Unakoti',
        'West Tripura',
      ],
    )
  })

  test('blocks invalid contact numbers and government-support years', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'field-bounds',
      businessName: 'Field Bounds Works',
    })
    await page.goto(`/applications/${id}/form`)
    await page.getByLabel('Category A').check()
    await page.getByLabel('Majority ownership is held by Scheduled Tribe members').check()
    await page.getByRole('button', { name: 'Save & Next' }).click()

    await page.getByLabel('Your full name').fill('Bethel Debbarma')
    await page.getByLabel('Your role in the enterprise').selectOption('PROPRIETOR')
    await page.getByLabel('Date of birth').fill('1996-07-14')
    await page.getByLabel('Gender').selectOption('FEMALE')
    await page
      .getByLabel('Office address (as per your business documents)')
      .fill('Khumulwng')
    await page.getByLabel('District').selectOption('West Tripura')
    await page.getByLabel('PIN code').fill('799045')
    await page.getByLabel('Contact number').fill('123456789')
    await page.getByRole('button', { name: 'Save & Next' }).click()
    await expect(page.getByText('Enter a 10-digit contact number.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Owners' })).toBeVisible()

    await page.getByLabel('Contact number').fill('9876543210')
    await page.getByRole('button', { name: 'Save & Next' }).click()
    await page.getByLabel('Total project cost (₹)').fill('1000000')
    await page.getByLabel('Seed fund requested (₹)').fill('250000')
    await page.getByLabel('Bank loan proposed (₹)').fill('0')
    await page.getByLabel('Your own contribution (₹)').fill('0')
    await page.getByRole('button', { name: 'Save & Next' }).click()

    await page
      .getByRole('group', {
        name: 'Has this enterprise received government funding before?',
      })
      .getByLabel('Yes')
      .check()
    await page.getByLabel('Scheme').fill('Earlier scheme')
    await page.getByLabel('Amount received (₹)').fill('1000')
    const year = page.getByLabel('Year sanctioned')
    await year.evaluate((select) => {
      select.append(new Option('2027', '2027'))
    })
    await year.selectOption('2027')
    await page
      .getByRole('group', { name: 'Does this enterprise have existing bank credit?' })
      .getByLabel('No')
      .check()
    await page.getByRole('button', { name: 'Save & Next' }).click()
    await expect(
      page.getByText('Select a sanction year from 1900 through 2026.'),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Previous support and credit' }),
    ).toBeVisible()
  })

  test('moves from evidence requirements to attachments and resumes there while files are missing', async ({
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
    await categories.getByRole('button', { name: 'Owners' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/applications/${id}/form\\?section=APPLICANT_PROFILE$`, 'u'),
    )
    await expect(page.getByRole('heading', { name: 'Owners' })).toBeVisible()

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
    await page.getByLabel('Owners').check()
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
    await expect(page.getByRole('heading', { name: 'Owners' })).toBeVisible()
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
    await page.getByRole('button').filter({ hasText: 'Owners' }).click()
    await expect(page.getByLabel('Your full name')).toBeDisabled()
    await page.getByRole('button').filter({ hasText: 'Attach evidence' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/documents$`, 'u'))
    await expect(page.getByRole('heading', { name: 'Attach evidence' })).toBeVisible()
    await page.getByRole('button').filter({ hasText: 'Review' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/review$`, 'u'))
    await expect(page.getByRole('button', { name: /Submit application/u })).toHaveCount(0)
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()
  })
})
