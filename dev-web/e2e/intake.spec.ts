/**
 * The intake console.
 *
 * These tests drive the programme office the way an officer does: the stages
 * they work and what waits there, the office-wide list and its filters,
 * reference lookup, the console's own rules about what is offered when, and
 * role administration. Working a file through its stages — asking the
 * applicant for a correction among them — is `stage-journey.spec.ts`.
 */
import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  signUpApplicant,
  uniqueEmail,
} from './support'

test.describe('the intake console', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  })

  /*
   * The office opens on its work: the stages the reader works, each with how
   * many files wait there, and the files that have waited longest. A super
   * administrator works every stage of every published pipeline.
   */
  test('leads with the stages the reader works and what has waited longest', async ({ page }) => {
    await page.goto('/admin')

    const stages = page.getByRole('region', { name: 'My stages' })
    await expect(stages).toBeVisible()
    for (const stage of ['TTC review', 'Industries & Commerce']) {
      await expect(stages.getByText(stage, { exact: true }).first()).toBeVisible()
    }
    await expect(page.getByRole('region', { name: 'Waiting longest' })).toBeVisible()
  })

  test('filters the office-wide list and keeps the filters in the address', async ({ page }) => {
    await page.goto('/admin/queue')

    // Choosing a pipeline is what makes its stages and flags filterable.
    const pipeline = page.getByLabel('Pipeline', { exact: true })
    const seeded = pipeline.locator('option').filter({ hasText: 'Mission SEP' }).first()
    await pipeline.selectOption((await seeded.getAttribute('value')) as string)
    await expect(page).toHaveURL(/pipelineId=/u)
    await expect(page.getByLabel(/^At stage/u)).toBeVisible()

    // A second filter must not drop the first. Category is a multi-select;
    // one chosen value appends its count to the label.
    await page.getByLabel(/^Categories/u).selectOption('CATEGORY_A')
    await expect(page).toHaveURL(/pipelineId=/u)
    await expect(page).toHaveURL(/categories=.*CATEGORY_A/u)

    // And the page survives a reload with the same view.
    await page.reload()
    await expect(page.getByLabel(/^Categories/u)).toHaveValues(['CATEGORY_A'])
    await expect(page.getByLabel(/^At stage/u)).toBeVisible()
  })

  test('keeps the ordering chosen while the filters change', async ({ page }) => {
    await page.goto('/admin/queue')
    await page.getByLabel('Order').selectOption('LAST_ACTIVITY')
    await page.getByLabel(/^Categories/u).selectOption('CATEGORY_B')
    await expect(page).toHaveURL(/categories=.*CATEGORY_B/u)
    await expect(page.getByLabel('Order')).toHaveValue('LAST_ACTIVITY')
  })

  test('says what an empty result means', async ({ page }) => {
    // Nobody asked for this much: the emptiness is the filters', and says so.
    await page.goto('/admin/queue')
    await page.getByLabel('Grant asked at least (₹)').fill('900000000')
    await page.getByLabel('Grant asked at least (₹)').press('Tab')
    await expect(page.getByText('Nothing matches')).toBeVisible()
    await expect(page.getByText(/No application matches these filters/u)).toBeVisible()
  })

  test('reports a reference number that does not exist', async ({ page }) => {
    await page.goto('/admin')
    await page.getByLabel('Reference number').fill('SEP-2026-999999')
    await page.getByRole('button', { name: 'Find it' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
  })

  test('is not offered to an applicant', async ({ page }) => {
    await page.context().clearCookies()
    const email = uniqueEmail('plain')
    await signUpApplicant(page, email)
    await signIn(page, email)

    await expect(page.getByRole('link', { name: 'Intake' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Access' })).toHaveCount(0)
  })
})

test.describe('access', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  })

  test('finds an account by its exact address and shows how it got its roles', async ({
    page,
  }) => {
    await page.goto('/admin/access')
    await page.getByLabel('Email address').fill(SUPER_ADMIN_EMAIL)
    await page.getByRole('button', { name: 'Look them up' }).click()

    await expect(page.getByRole('heading', { name: SUPER_ADMIN_EMAIL })).toBeVisible()

    // The bootstrap grant has no granter, because no person made it.
    await expect(page.getByText('by the system').first()).toBeVisible()
    await expect(page.getByRole('row', { name: /^Super admin/u })).toBeVisible()

    /*
     * The bootstrap closes the applicant grant as it opens the super
     * administrator one, and both are kept. A history that dropped the closed
     * grant would not explain why this account is no longer an applicant.
     */
    const applicant = page.getByRole('row', { name: /^Applicant/u })
    await expect(applicant).toContainText('Revoked')
    await expect(applicant).toContainText('First super admin bootstrap')
  })

  test('says so when no account has that address', async ({ page }) => {
    await page.goto('/admin/access')
    await page.getByLabel('Email address').fill('nobody@example.invalid')
    await page.getByRole('button', { name: 'Look them up' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
  })

  test('grants a role, and the history records who did it and why', async ({ page }) => {
    // A real second person, signed up through the product.
    const colleague = uniqueEmail('colleague')
    await page.context().clearCookies()
    await signUpApplicant(page, colleague)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

    await page.goto(`/admin/access?email=${encodeURIComponent(colleague)}`)
    await expect(page.getByRole('heading', { name: colleague })).toBeVisible()

    await page.getByLabel('Role').selectOption('PROGRAMME_OFFICER')
    await page.getByLabel('Why they should have it').fill('Joining the desk review team.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()

    await expect(page.getByText('Programme officer granted.')).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: 'Joining the desk review team.' }),
    ).toBeVisible()
  })

  test('refuses a grant without the operator’s own password', async ({ page }) => {
    const colleague = uniqueEmail('colleague')
    await page.context().clearCookies()
    await signUpApplicant(page, colleague)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

    await page.goto(`/admin/access?email=${encodeURIComponent(colleague)}`)
    await page.getByLabel('Role').selectOption('PROGRAMME_OFFICER')
    await page.getByLabel('Why they should have it').fill('Should not go through.')
    await page.getByLabel('Your password').fill('not the right password')
    await page.getByRole('button', { name: 'Grant it' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: 'Should not go through.' }),
    ).toHaveCount(0)
  })

  test('revokes a role and keeps the closed grant in the history', async ({ page }) => {
    const colleague = uniqueEmail('colleague')
    await page.context().clearCookies()
    await signUpApplicant(page, colleague)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

    await page.goto(`/admin/access?email=${encodeURIComponent(colleague)}`)
    await page.getByLabel('Role').selectOption('PROGRAMME_OFFICER')
    await page.getByLabel('Why they should have it').fill('Temporary cover.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()
    await expect(page.getByText('Programme officer granted.')).toBeVisible()

    await page.getByRole('button', { name: 'Revoke' }).click()
    await page.getByLabel(/Why revoke/u).fill('Cover has ended.')
    await page.getByLabel('Your password').last().fill(PASSWORD)
    await page.getByRole('button', { name: 'Revoke it' }).click()

    // Revocation closes the grant rather than deleting it: the record of why
    // somebody had the role survives.
    await expect(page.getByText('Cover has ended.')).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: 'Temporary cover.' }),
    ).toBeVisible()
  })

  test('does not offer a role the account already holds', async ({ page }) => {
    await page.goto(`/admin/access?email=${encodeURIComponent(SUPER_ADMIN_EMAIL)}`)

    const role = page.getByLabel('Role')
    await expect(role.getByRole('option', { name: 'Super admin' })).toHaveCount(0)
  })

  test('never offers to revoke the applicant role', async ({ page }) => {
    await page.goto(`/admin/access?email=${encodeURIComponent(SUPER_ADMIN_EMAIL)}`)

    // APPLICANT comes only from verified signup and nothing can grant it back,
    // so revoking it would strip somebody permanently.
    const applicantRow = page.getByRole('row').filter({ hasText: 'Applicant' })
    await expect(applicantRow.getByRole('button', { name: 'Revoke' })).toHaveCount(0)
  })
})

test.describe('the application workspace', () => {
  test('refuses an application that does not exist, inside the shell', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openProgrammeCycle(page, { prefix: 'SEP-W' })

    await page.goto('/admin/applications/00000000-0000-4000-8000-000000000000')

    // The refusal stays inside the shell rather than blanking the page.
    await expect(page.getByRole('navigation', { name: 'Portal sections' })).toBeVisible()
    await expect(page.getByRole('alert')).toBeVisible()
  })
})
