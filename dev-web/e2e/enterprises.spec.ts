import { expect, test } from '@playwright/test'
import { registerEnterprise, signIn, signUpApplicant, uniqueEmail } from './support'

/** A fresh applicant per test, so one test's enterprises never affect another. */
const asNewApplicant = async (page: import('@playwright/test').Page) => {
  const email = uniqueEmail('applicant')
  await signUpApplicant(page, email)
  await signIn(page, email)
  return email
}

/** Advances the wizard past the current category, after its checks pass. */
const next = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Next' }).click()
}

test.describe('enterprises', () => {
  test('invites registration when there are none', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/enterprises')

    await expect(page.getByText('No enterprises yet')).toBeVisible()
    await page
      .getByRole('main')
      .getByRole('link', { name: 'Register an enterprise' })
      .first()
      .click()
    await expect(page).toHaveURL(/\/enterprises\/new$/u)
  })

  test('registers one and shows it in the list and on its own page', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/enterprises/new')

    // The wizard asks one category at a time; the first is the enterprise
    // itself.
    await page.getByLabel('Registered or trading name').fill('Khumulwng Food Works')
    await page.getByLabel('Date established').fill('2026-01-15')
    await page.getByLabel('Sector').selectOption('FOOD_PROCESSING')
    await next(page)

    // Registration and tax: the defaults stand for a sole proprietorship.
    await next(page)

    // Business location. The address must be the business's own, and the form
    // says so up front.
    await expect(page.getByText('not a personal or home address')).toBeVisible()
    await page
      .getByLabel('Office address (as per your business documents)')
      .fill('Khumulwng')
    // Stored as the district code; every screen renders the name from it.
    await page.getByLabel('District').selectOption('WEST_TRIPURA')
    await page.getByLabel('PIN code').fill('799045')
    await next(page)

    // Contact details. A malformed number is refused by the browser's own
    // validity check before it can reach the API.
    await page.getByLabel('Contact number').fill('12345')
    expect(
      await page
        .getByLabel('Contact number')
        .evaluate((input: HTMLInputElement) => input.checkValidity()),
    ).toBe(false)
    await page.getByLabel('Contact number').fill('')
    await page.getByRole('button', { name: 'Register enterprise' }).click()

    // Registration lands on the new enterprise, not back on the list.
    await expect(page).toHaveURL(/\/enterprises\/[0-9a-f-]{36}$/u)
    await expect(
      page.getByRole('heading', { name: 'Khumulwng Food Works' }),
    ).toBeVisible()
    await expect(page.getByText('Food processing')).toBeVisible()
    // The read view shows the district's bare name, mapped from the code.
    await expect(page.getByText('West Tripura')).toBeVisible()
    await expect(page.getByText('Sole Proprietorship')).toBeVisible()

    await page.goto('/enterprises')
    await expect(page.getByRole('link', { name: 'Khumulwng Food Works' })).toBeVisible()
  })

  test('requires the statutory number only for the incorporated types', async ({
    page,
  }) => {
    await asNewApplicant(page)
    await page.goto('/enterprises/new')

    // The name is the one requirement of the first category; the registration
    // questions live in the second.
    await page.getByLabel('Registered or trading name').fill('Statutory Works')
    await next(page)

    // A fresh form starts as a sole proprietorship, whose number is optional —
    // that is what keeps a name-only registration possible.
    await expect(page.getByLabel('Registration', { exact: true })).toHaveValue(
      'SOLE_PROPRIETORSHIP',
    )
    await expect(page.getByLabel('Registration number')).not.toHaveAttribute('required')
    await expect(page.getByText('Only if the proprietorship holds one.')).toBeVisible()

    // The incorporated types each hold a statutory number, so the field turns
    // required and takes the name of the number the type confers.
    await page.getByLabel('Registration', { exact: true }).selectOption('PRIVATE_LIMITED')
    await expect(page.getByLabel('CIN', { exact: true })).toHaveAttribute('required', '')

    await page.getByLabel('Registration', { exact: true }).selectOption('LLP')
    await expect(page.getByLabel('LLPIN', { exact: true })).toHaveAttribute(
      'required',
      '',
    )
  })

  test('describes the sector when it is not one of the listed ones', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/enterprises/new')

    await expect(page.getByLabel('Describe the sector')).toBeHidden()
    await page.getByLabel('Sector').selectOption('OTHER')
    await expect(page.getByLabel('Describe the sector')).toBeVisible()
  })

  test('shows the message the API returns for an invalid profile', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/enterprises/new')

    await page.getByLabel('Registered or trading name').fill('Bad GSTIN Works')
    await next(page)
    // The browser does not police the GSTIN's shape; the Worker does, and its
    // message is what the person sees.
    await page.getByLabel('GSTIN').fill('not-a-gstin')
    await next(page)
    await next(page)
    await page.getByRole('button', { name: 'Register enterprise' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/enterprises\/new$/u)
  })

  test('edits an enterprise and keeps the change', async ({ page }) => {
    await asNewApplicant(page)
    await registerEnterprise(page, 'Original Name')
    await expect(page.getByRole('heading', { name: 'Original Name' })).toBeVisible()

    // Editing reopens the same wizard; the change on the first category is
    // kept in memory while the later ones are stepped through.
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Registered or trading name').fill('Corrected Name')
    await next(page)
    await next(page)
    await next(page)
    await page.getByLabel('Contact number').fill('+919876543210')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(page.getByRole('heading', { name: 'Corrected Name' })).toBeVisible()
    // The Worker stores the bare 10 digits, so the +91 typed above is gone.
    await expect(page.getByText('9876543210', { exact: true })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Corrected Name' })).toBeVisible()
  })

  test('removes an enterprise and restores it again', async ({ page }) => {
    await asNewApplicant(page)
    await registerEnterprise(page, 'Removable Works')

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('This enterprise has been removed')).toBeVisible()

    // Removal is reversible and keeps history, so it is hidden rather than gone.
    await page.goto('/enterprises')
    await expect(page.getByRole('link', { name: 'Removable Works' })).toBeHidden()
    // The filter lives in the URL, so its state follows the navigation rather
    // than changing the moment the box is clicked.
    await page.getByLabel('Include removed enterprises').click()
    await expect(page).toHaveURL(/includeDeleted=true/u)
    await expect(page.getByRole('link', { name: 'Removable Works' })).toBeVisible()

    await page.getByRole('link', { name: 'Removable Works' }).click()
    await page.getByRole('button', { name: 'Restore' }).click()
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible()
  })
})
