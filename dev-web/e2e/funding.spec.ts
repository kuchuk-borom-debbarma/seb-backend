/**
 * The applicant's view of their award.
 *
 * What is covered here is the state every application is in first — nothing
 * sanctioned — and the rule that decides whether the screen is offered at
 * all. The sanctioned path itself — approval, the sanction order, a payment,
 * and the applicant reading the result — is carried end to end by
 * `journey.spec.ts`.
 */
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

test.describe('funding', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    cycleCode = await openProgrammeCycle(page, { prefix: 'SEP-F' })
    await page.context().clearCookies()
  })

  test('says plainly that nothing has been sanctioned yet', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'funding',
      businessName: 'Funding Works',
    })
    await page.goto(`/applications/${id}/funding`)

    await expect(page.getByText('Nothing has been sanctioned yet')).toBeVisible()

    // No invented figures: an unsanctioned application has no amounts at all.
    await expect(page.getByRole('table')).toHaveCount(0)
  })

  test('is not offered from an application that cannot have an award', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'funding',
      businessName: 'Funding Works',
    })
    await page.goto(`/applications/${id}`)

    // A draft is offered the form and the check, not a funding screen that
    // could only say "nothing yet".
    await expect(page.getByRole('link', { name: 'Funding' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Fill in the form' })).toBeVisible()
  })

  test('leads back to the application', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'funding',
      businessName: 'Funding Works',
    })
    await page.goto(`/applications/${id}/funding`)

    await page.getByRole('link', { name: 'Back to the application' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}$`, 'u'))
  })
})
