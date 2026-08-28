/**
 * The intake console.
 *
 * These tests drive the programme office the way a reviewer does: the queues
 * and their counts, the filters, reference lookup, the console's own rules
 * about what is offered when, role administration, and a revision request the
 * applicant then sees. Submitted applications are reached through the
 * product's own paths — locally the Worker stores documents itself, so no
 * bucket is needed.
 */
import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  signUpApplicant,
  submitApplication,
  uniqueEmail,
} from './support'

test.describe('the intake console', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  })

  test('leads with the queues waiting on the programme office', async ({ page }) => {
    await page.goto('/admin')

    /*
     * Each actionable queue appears twice on the dashboard — a "Waiting on
     * us" row and an "All queues" table row — so first() is deliberate: the
     * point is that it is offered, prominently, not how many times.
     */
    for (const queue of ['New submissions', 'Revision responses', 'Desk review']) {
      await expect(
        page.getByRole('link', { name: new RegExp(queue, 'u') }).first(),
      ).toBeVisible()
    }

    // The rest are listed with counts but not given the same weight.
    await expect(page.getByRole('row').filter({ hasText: 'With the bank' })).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: 'To decide' }),
    ).toBeVisible()
  })

  test('shows every queue even when it is empty', async ({ page }) => {
    await page.goto('/admin')

    // A row that vanished at zero would move everything beside it, and staff
    // learn where their queue sits.
    const newSubmissions = page.getByRole('link', { name: /New submissions/u }).first()
    await expect(newSubmissions).toBeVisible()
    await expect(newSubmissions).toContainText(/\d/u)
  })

  test('opens a queue and keeps the filters in the address', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /New submissions/u }).first().click()
    await expect(page).toHaveURL(/\/admin\/queue\?queue=NEW_SUBMISSIONS/u)

    await page.getByLabel('Type').selectOption('EXPANSION')
    await expect(page).toHaveURL(/applicationType=EXPANSION/u)
    await expect(page).toHaveURL(/queue=NEW_SUBMISSIONS/u)

    // A second filter must not drop the first. Category is a multi-select
    // now; one chosen value appends its count to the label.
    await page.getByLabel('Categories').selectOption('CATEGORY_A')
    await expect(page).toHaveURL(/applicationType=EXPANSION/u)
    await expect(page).toHaveURL(/categories=.*CATEGORY_A/u)

    // And the page survives a reload with the same view.
    await page.reload()
    await expect(page.getByLabel('Type')).toHaveValue('EXPANSION')
    await expect(page.getByLabel(/^Categories/u)).toHaveValues(['CATEGORY_A'])
  })

  test('switching queues does not lose the ordering you chose', async ({ page }) => {
    await page.goto('/admin/queue?queue=NEW_SUBMISSIONS')
    await page.getByLabel('Order').selectOption('LAST_ACTIVITY')

    await page.getByRole('tab', { name: /Desk review/u }).click()
    await expect(page).toHaveURL(/queue=DESK_REVIEW/u)
    await expect(page.getByLabel('Order')).toHaveValue('LAST_ACTIVITY')
  })

  test('says what an empty queue means', async ({ page }) => {
    await page.goto('/admin/queue?queue=DISBURSED')
    await expect(page.getByText('Nothing in this queue')).toBeVisible()
    await expect(page.getByText('Everything here has been dealt with.')).toBeVisible()

    // With a filter on, the emptiness has a different cause and says so.
    await page.getByLabel('Categories').selectOption('CATEGORY_B')
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

    await page.getByLabel('Role').selectOption('ADMIN')
    await page.getByLabel('Why they should have it').fill('Joining the desk review team.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()

    await expect(page.getByText('Admin granted.')).toBeVisible()
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
    await page.getByLabel('Role').selectOption('ADMIN')
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
    await page.getByLabel('Role').selectOption('ADMIN')
    await page.getByLabel('Why they should have it').fill('Temporary cover.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()
    await expect(page.getByText('Admin granted.')).toBeVisible()

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

/*
 * Asking an applicant to correct something.
 *
 * Untested until now, and broken the whole time: the form sent no outcome
 * reason for a revision, so every attempt was refused with "Select an approved
 * outcome reason." over a form that offered nowhere to select one. The whole
 * revision route — the way a case goes back to the applicant — could not be
 * used at all.
 */
test.describe('sending an application back for correction', () => {
  test('asks for a revision, naming why, and the applicant sees it', async ({ page }) => {
    test.setTimeout(180_000)
    const application = await submitApplication(page, { prefix: 'rev' })

    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/applications/${application.id}`)
    await page.getByRole('button', { name: 'Start desk review' }).click()
    await page.getByRole('button', { name: 'Open desk review' }).click()

    for (const check of [
      'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
      'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
      'DPR_FEASIBILITY',
    ]) {
      await page.locator(`input[name="${check}"]`).first().check()
    }
    await page.locator('input[name="EXPANSION_EVIDENCE"]').nth(2).check()
    await page.getByRole('button', { name: 'Next: What documents say' }).click()

    // Passing the checks that gate them means the cycle demands these, exactly
    // as it would for a referral. Unique, so the duplicate check stays quiet.
    const unique = Date.now().toString().slice(-6)
    await page.getByLabel('Scheduled Tribe certificate number').fill(`TR/ST/2026-R${unique}`)
    await page.getByLabel('Identity document number').fill(`9333${unique}`)
    await page.getByLabel('Bank account number').fill(`5009${unique}`)
    await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')

    await page.getByRole('button', { name: 'Next: Outcome' }).click()
    await page.getByRole('radio', { name: /Ask the applicant to correct it/u }).check()

    // The reason the application is going back, distinct from each section's.
    const outcomeReason = page.getByLabel('Why this is going back')
    await expect(outcomeReason).toBeVisible()
    await outcomeReason.selectOption({ index: 1 })

    // One section, with its own reason and instruction.
    await page.getByRole('checkbox', { name: 'Evidence' }).check()
    await page.getByLabel('Reason', { exact: true }).last().selectOption({ index: 1 })
    await page.getByLabel('What the applicant must do').last().fill('Attach the missing quotation.')

    await page
      .getByLabel('Message to the applicant')
      .fill('Please attach the missing quotation and resubmit.')

    await page.getByRole('button', { name: 'Complete the review' }).click()
    await expect(page.locator('.badge').filter({ hasText: 'Revision required' }).first())
      .toBeVisible()

    // And the applicant is actually told, which is the point of the outcome.
    await page.context().clearCookies()
    await signIn(page, application.email, PASSWORD)
    await page.goto(`/applications/${application.id}`)
    await expect(page.getByText('Attach the missing quotation.')).toBeVisible()
  })
})
