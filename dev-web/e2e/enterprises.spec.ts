import { expect, test } from '@playwright/test'
import { signIn, signUpApplicant, uniqueEmail } from './support'

/** A fresh applicant per test, so one test's enterprises never affect another. */
const asNewApplicant = async (page: import('@playwright/test').Page) => {
  const email = uniqueEmail('applicant')
  await signUpApplicant(page, email)
  await signIn(page, email)
  return email
}

test.describe('enterprises', () => {
  test('invites registration when there are none', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/app/enterprises')

    await expect(page.getByText('No enterprises yet')).toBeVisible()
    await page
      .getByRole('main')
      .getByRole('link', { name: 'Register an enterprise' })
      .first()
      .click()
    await expect(page).toHaveURL(/\/app\/enterprises\/new$/u)
  })

  test('registers one and shows it in the list and on its own page', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/app/enterprises/new')

    await page.getByLabel('Registered or trading name').fill('Khumulwng Food Works')
    await page.getByLabel('Date established').fill('2026-01-15')
    await page.getByLabel('Sector').selectOption('FOOD_PROCESSING')
    await page.getByLabel('Block or village').fill('Khumulwng')
    await page.getByLabel('District').fill('West Tripura')
    await page.getByLabel('PIN code').fill('799045')
    await page.getByRole('button', { name: 'Register enterprise' }).click()

    // Registration lands on the new enterprise, not back on the list.
    await expect(page).toHaveURL(/\/app\/enterprises\/[0-9a-f-]{36}$/u)
    await expect(page.getByRole('heading', { name: 'Khumulwng Food Works' })).toBeVisible()
    await expect(page.getByText('Food processing')).toBeVisible()
    await expect(page.getByText('West Tripura')).toBeVisible()

    await page.goto('/app/enterprises')
    await expect(page.getByRole('link', { name: 'Khumulwng Food Works' })).toBeVisible()
  })

  test('asks for a registration number only when the enterprise is registered', async ({
    page,
  }) => {
    await asNewApplicant(page)
    await page.goto('/app/enterprises/new')

    // The API refuses a number on an unregistered enterprise, so the field is
    // not offered until the type calls for one.
    await expect(page.getByLabel('UDYAM number')).toBeHidden()
    await page.getByLabel('Registration').selectOption('UDYAM')
    await expect(page.getByLabel('UDYAM number')).toBeVisible()

    await page.getByLabel('Registration').selectOption('NONE')
    await expect(page.getByLabel('UDYAM number')).toBeHidden()
  })

  test('describes the sector when it is not one of the listed ones', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/app/enterprises/new')

    await expect(page.getByLabel('Describe the sector')).toBeHidden()
    await page.getByLabel('Sector').selectOption('OTHER')
    await expect(page.getByLabel('Describe the sector')).toBeVisible()
  })

  test('shows the message the API returns for an invalid profile', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/app/enterprises/new')

    await page.getByLabel('Registered or trading name').fill('Bad GSTIN Works')
    await page.getByLabel('GSTIN').fill('not-a-gstin')
    await page.getByRole('button', { name: 'Register enterprise' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/app\/enterprises\/new$/u)
  })

  test('edits an enterprise and keeps the change', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/app/enterprises/new')
    await page.getByLabel('Registered or trading name').fill('Original Name')
    await page.getByRole('button', { name: 'Register enterprise' }).click()
    await expect(page.getByRole('heading', { name: 'Original Name' })).toBeVisible()

    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Registered or trading name').fill('Corrected Name')
    await page.getByLabel('Contact number').fill('+919876543210')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await expect(page.getByRole('heading', { name: 'Corrected Name' })).toBeVisible()
    await expect(page.getByText('+919876543210')).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Corrected Name' })).toBeVisible()
  })

  test('removes an enterprise and restores it again', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/app/enterprises/new')
    await page.getByLabel('Registered or trading name').fill('Removable Works')
    await page.getByRole('button', { name: 'Register enterprise' }).click()

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('This enterprise has been removed')).toBeVisible()

    // Removal is reversible and keeps history, so it is hidden rather than gone.
    await page.goto('/app/enterprises')
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
