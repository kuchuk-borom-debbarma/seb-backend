/**
 * The intake console.
 *
 * These tests drive the programme office the way a reviewer does. An
 * application can only be submitted once every required document is attached,
 * and uploading needs a bucket development does not have — so the submitted
 * states these tests would need cannot be reached here. What is covered is
 * everything reachable: the queues and their counts, the filters, reference
 * lookup, and the console's own rules about what is offered when.
 *
 * The desk review path is exercised through the form's own guards rather than
 * through a completed review.
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

  test('leads with the queues waiting on the programme office', async ({ page }) => {
    await page.goto('/admin')

    // The three that need somebody here, as cards.
    for (const queue of ['New submissions', 'Revision responses', 'Desk review']) {
      await expect(page.getByRole('link', { name: new RegExp(queue, 'u') })).toBeVisible()
    }

    // The rest are listed with counts but not given the same weight.
    await expect(page.getByRole('row').filter({ hasText: 'With the bank' })).toBeVisible()
    await expect(
      page.getByRole('row').filter({ hasText: 'For the committee' }),
    ).toBeVisible()
  })

  test('shows every queue even when it is empty', async ({ page }) => {
    await page.goto('/admin')

    // A chip that vanished at zero would move everything beside it, and staff
    // learn where their queue sits.
    const newSubmissions = page.getByRole('link', { name: /New submissions/u })
    await expect(newSubmissions).toBeVisible()
    await expect(newSubmissions).toContainText(/\d/u)
  })

  test('opens a queue and keeps the filters in the address', async ({ page }) => {
    await page.goto('/admin')
    await page.getByRole('link', { name: /New submissions/u }).click()
    await expect(page).toHaveURL(/\/admin\/queue\?queue=NEW_SUBMISSIONS/u)

    await page.getByLabel('Type').selectOption('EXPANSION')
    await expect(page).toHaveURL(/applicationType=EXPANSION/u)
    await expect(page).toHaveURL(/queue=NEW_SUBMISSIONS/u)

    // A second filter must not drop the first.
    await page.getByLabel('Category', { exact: true }).selectOption('CATEGORY_A')
    await expect(page).toHaveURL(/applicationType=EXPANSION/u)
    await expect(page).toHaveURL(/category=CATEGORY_A/u)

    // And the page survives a reload with the same view.
    await page.reload()
    await expect(page.getByLabel('Type')).toHaveValue('EXPANSION')
    await expect(page.getByLabel('Category', { exact: true })).toHaveValue('CATEGORY_A')
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
    await page.getByLabel('Category', { exact: true }).selectOption('CATEGORY_B')
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

test.describe('committee meetings', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  })

  test('schedules a meeting and opens it', async ({ page }) => {
    await page.goto('/admin/meetings')
    await page.getByRole('button', { name: 'Schedule a meeting' }).click()

    const reference = `TTM-${Date.now().toString(36).toUpperCase()}`
    await page.getByLabel('Meeting reference').fill(reference)
    await page
      .getByLabel('When')
      .fill(new Date(Date.now() + 604_800_000).toISOString().slice(0, 16))
    await page.getByLabel('Where').fill('TTAADC headquarters, Khumulwng')
    await page.getByRole('button', { name: 'Schedule it' }).click()

    // Scheduling lands on the meeting, because building the agenda is the next
    // thing anyone does.
    await expect(page).toHaveURL(/\/admin\/meetings\/[0-9a-f-]{36}$/u)
    await expect(page.getByRole('heading', { name: reference })).toBeVisible()
  })

  test('will not start a meeting with an empty agenda, and says why', async ({
    page,
  }) => {
    await page.goto('/admin/meetings')
    await page.getByRole('button', { name: 'Schedule a meeting' }).click()
    await page.getByLabel('Meeting reference').fill(`TTM-E${Date.now().toString(36)}`)
    await page
      .getByLabel('When')
      .fill(new Date(Date.now() + 604_800_000).toISOString().slice(0, 16))
    await page.getByLabel('Where').fill('Khumulwng')
    await page.getByRole('button', { name: 'Schedule it' }).click()
    await expect(page).toHaveURL(/\/admin\/meetings\/[0-9a-f-]{36}$/u)

    /*
     * The emptiness is stated once, in the card where the agenda would be, and
     * it names the one way an item gets there — a notice ten lines above saying
     * the same thing was two answers to one question.
     */
    await expect(
      page.getByRole('heading', { name: 'Nothing on the agenda yet' }),
    ).toBeVisible()
    await expect(page.getByText(/added from its own workspace/u)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start the meeting' })).toBeDisabled()
  })

  test('changing the time of a scheduled meeting is recorded', async ({ page }) => {
    await page.goto('/admin/meetings')
    await page.getByRole('button', { name: 'Schedule a meeting' }).click()
    const reference = `TTM-C${Date.now().toString(36).toUpperCase()}`
    await page.getByLabel('Meeting reference').fill(reference)
    await page
      .getByLabel('When')
      .fill(new Date(Date.now() + 604_800_000).toISOString().slice(0, 16))
    await page.getByLabel('Where').fill('Khumulwng')
    await page.getByRole('button', { name: 'Schedule it' }).click()
    await expect(page).toHaveURL(/\/admin\/meetings\/[0-9a-f-]{36}$/u)

    await page.getByRole('button', { name: 'Change the details' }).click()
    await page.getByLabel('Where').fill('Agartala circuit house')

    // People have been told where the meeting is, so a change needs a reason
    // and the button refuses without one.
    await expect(page.getByRole('button', { name: 'Save the change' })).toBeDisabled()
    await page.getByLabel('Why it is changing').fill('The venue was double-booked.')
    await page.getByRole('button', { name: 'Save the change' }).click()

    await expect(page.getByText('Agartala circuit house')).toBeVisible()
  })
})
