/**
 * The applicant's view of their award.
 *
 * An award only exists after the committee approves an application and the
 * programme office issues a sanction order, and neither of those screens is
 * built yet. So what is covered here is the state every application is in
 * first — nothing sanctioned — and the rule that decides whether the screen is
 * offered at all. The sanctioned path is covered once the administrative
 * console can sanction.
 */
import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  startApplication,
} from './support'

test.describe('funding', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openProgrammeCycle(page, { prefix: 'SEP-F' })
    await page.context().clearCookies()
  })

  test('says plainly that nothing has been sanctioned yet', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'funding',
      businessName: 'Funding Works',
    })
    await page.goto(`/app/applications/${id}/funding`)

    await expect(page.getByText('Nothing has been sanctioned yet')).toBeVisible()

    // No invented figures: an unsanctioned application has no amounts at all.
    await expect(page.getByRole('table')).toHaveCount(0)
  })

  test('is not offered from an application that cannot have an award', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'funding',
      businessName: 'Funding Works',
    })
    await page.goto(`/app/applications/${id}`)

    // A draft is offered the form and the check, not a funding screen that
    // could only say "nothing yet".
    await expect(page.getByRole('link', { name: 'Funding' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Fill in the form' })).toBeVisible()
  })

  test('leads back to the application', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'funding',
      businessName: 'Funding Works',
    })
    await page.goto(`/app/applications/${id}/funding`)

    await page.getByRole('link', { name: 'Back to the application' }).click()
    await expect(page).toHaveURL(new RegExp(`/app/applications/${id}$`, 'u'))
  })
})
