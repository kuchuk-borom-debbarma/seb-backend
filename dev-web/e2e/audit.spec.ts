/**
 * The activity history, read the way the office reads it.
 *
 * The API's own suite proves what each entry records. What these prove is the
 * half a person experiences: that an entry says what happened in words and
 * opens to everything it recorded, that a person can be found by their
 * address, that an application's own screen shows its history, and that
 * taking a copy of the history is itself recorded.
 */
import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  signIn,
  signUpApplicant,
  submittedThroughApi,
  uniqueEmail,
} from './support'

/** Looks somebody up on Users & access and grants them a role, with a reason. */
const grantWithReason = async (
  page: import('@playwright/test').Page,
  email: string,
  reason: string,
) => {
  await page.goto('/admin/access')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Look them up' }).click()
  await expect(page.getByRole('heading', { name: email })).toBeVisible()
  await page
    .getByLabel('Role', { exact: true })
    .selectOption({ label: 'Casework reader' })
  await page.getByLabel('Why they should have it').fill(reason)
  await page.getByLabel('Your password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Grant it' }).click()
  await expect(page.getByRole('button', { name: 'Grant it' })).toBeHidden({
    timeout: 15_000,
  })
}

test.describe('the activity history', () => {
  test('says who was given a role, and why, when the entry is opened', async ({
    page,
  }) => {
    const email = uniqueEmail('granted')
    await signUpApplicant(page, email)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const reason = `Joined the desk ${Date.now()}`
    await grantWithReason(page, email, reason)

    // Straight to that person's history from their access record.
    await page.getByRole('link', { name: 'Activity', exact: true }).click()
    await expect(page).toHaveURL(/involving=/u)
    const entry = page.getByRole('button', {
      name: `Gave ${email} the role Casework reader directly`,
    })
    await expect(entry).toBeVisible()
    await entry.click()

    // The dialog is addressed by the URL, so back closes it.
    await expect(page).toHaveURL(/event=/u)
    // The reason is a labelled detail of its own, not only raw text.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('definition').filter({ hasText: reason })).toBeVisible()
    await expect(dialog.getByText('RBAC.ROLE_GRANTED')).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('finds a person by their whole address', async ({ page }) => {
    const email = uniqueEmail('found')
    await signUpApplicant(page, email)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/audit')

    await page.getByLabel('Person (whole email address)').fill(email)
    await page.getByLabel('Show').selectOption('involving')
    await page.getByRole('button', { name: 'Add person' }).click()

    await expect(page).toHaveURL(/involving=/u)
    await expect(page.getByText(`Everything about ${email}`)).toBeVisible()
    // Their signup is theirs: the account created for them is in their history.
    await expect(
      page.getByRole('button', { name: /^Created the account/u }),
    ).toBeVisible()

    // A partial address names nobody, and says so rather than guessing.
    await page.getByLabel('Person (whole email address)').fill(`x${email}`)
    await page.getByRole('button', { name: 'Add person' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
  })

  test("shows an application's history on the application itself", async ({ page }) => {
    const { id } = await submittedThroughApi(page, { prefix: 'activity' })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/applications/${id}`)

    const activity = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Activity', exact: true }),
    })
    await expect(
      activity.getByRole('link', { name: /^Submitted application / }),
    ).toBeVisible()
    await expect(
      activity.getByRole('link', { name: /^Started an initial application/u }),
    ).toBeVisible()
    // Only this file's history: signing in just now happened, but not to it.
    await expect(activity.getByRole('link', { name: /^Signed in/u })).toHaveCount(0)

    // The full view is the same slice, filtered to this application.
    await activity.getByRole('link', { name: /in the activity history$/u }).click()
    await expect(page).toHaveURL(new RegExp(`application=${id}`, 'u'))
    await expect(page.getByText('One application')).toBeVisible()
  })

  test('records who took a copy, and why', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/audit')
    await page.getByRole('button', { name: 'Export' }).click()

    const purpose = `Quarterly review ${Date.now()}`
    await page.getByLabel('Why is this being exported?').fill(purpose)
    const download = page.waitForEvent('download')
    await page.getByRole('dialog').getByRole('button', { name: 'Export' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^activity-history-.*\.csv$/u)
    await expect(page.getByRole('status')).toContainText('Downloaded')
    await page.getByRole('button', { name: 'Done' }).click()

    // The export is now the newest entry in the history it copied.
    await page.goto('/admin/audit?kinds=AUDIT')
    const exported = page
      .getByRole('button', {
        name: /^Exported \d+ entr(y|ies) of the activity history$/u,
      })
      .first()
    await exported.click()
    await expect(
      page.getByRole('dialog').getByRole('definition').filter({ hasText: purpose }),
    ).toBeVisible()
  })
})
