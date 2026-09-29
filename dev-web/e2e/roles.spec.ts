/**
 * Who may do what, seen from the browser.
 *
 * The API refuses on its own and is tested there; what these assert is the
 * half a person actually experiences — that a control they cannot use is not
 * drawn, that a screen they may not open says so, and that being invited into
 * the office actually lands them in it.
 */
import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  composeRole,
  inviteSomebodyTo,
  navigationSections,
  signIn,
} from './support'

test.describe('being invited into the office', () => {
  test('a reviewer arrives, and can read casework without changing it', async ({
    page,
  }) => {
    await inviteSomebodyTo(page, 'CASEWORK_READER')

    // The applicant grant was exchanged, not added to, so the office is where
    // they work now.
    await page.goto('/admin')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    /*
     * Read-only means the administration group is absent entirely — a reviewer
     * governs nothing. Casework is theirs to read.
     */
    const sections = await navigationSections(page)
    expect(sections).toContain('workspace')
    expect(sections).not.toContain('administration')

    /*
     * And a screen they cannot reach says which one it is and who holds it —
     * rather than "this part is for the programme office", which would be
     * untrue of somebody already working in it.
     */
    await page.goto('/admin/audit')
    await expect(
      page.getByText('This screen is open to anybody whose role may read the activity history.'),
    ).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'Back to the programme office' }),
    ).toBeVisible()
  })

  test('an approver sees casework and still governs nothing', async ({ page }) => {
    await inviteSomebodyTo(page, 'DECISION_APPROVER')
    await page.goto('/admin')
    const sections = await navigationSections(page)
    expect(sections).toContain('workspace')
    expect(sections).not.toContain('administration')
  })
})

test.describe('the super administrator', () => {
  test('reads the activity history and filters it', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/audit')

    // Something has certainly happened: signing in is itself recorded.
    const rows = page.getByRole('row')
    await expect(rows.first()).toBeVisible()

    await page.getByLabel('Outcome').selectOption('SUCCESS')
    await expect(page).toHaveURL(/outcome=SUCCESS/u)

    // Ordering is a real filter, not decoration.
    await page.getByLabel('Order').selectOption('oldest')
    await expect(page).toHaveURL(/oldest=true/u)
  })

  test('offers the office links a reviewer never sees', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')
    const sections = await navigationSections(page)
    expect(sections).toContain('administration')
    await expect(page.getByRole('link', { name: 'Activity history' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Announcement banner' })).toBeVisible()
    // Offered twice — the rail and the dashboard's quick actions — so first()
    // is deliberate.
    await expect(page.getByRole('link', { name: 'Invite a colleague' }).first()).toBeVisible()
  })
})

test.describe('an invitation that cannot be used', () => {
  test('says so rather than pretending something happened', async ({ page }) => {
    // A token that was never issued. Every failure gives one answer, so the
    // page cannot be used to probe which tokens are real.
    await page.goto('/invite#not-a-real-invitation')
    await page.getByRole('button', { name: 'Accept the invitation' }).click()
    await expect(page.getByRole('alert')).toContainText('not usable')
  })

  test('a link with nothing after the hash asks for the whole one', async ({ page }) => {
    await page.goto('/invite')
    await expect(page.getByText('This link is incomplete')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Accept the invitation' })).toHaveCount(
      0,
    )
  })
})

test.describe('a role composed for one screen', () => {
  /*
   * The office console used to open on two named permissions, which was safe
   * while six fixed roles existed and is not now: a role holding only the
   * activity history hit the door and was told this part of the portal was for
   * the programme office — while standing in it, holding a permission the API
   * would have served.
   *
   * The narrowest useful role there is, end to end.
   */
  test('reaches the one screen it holds, and nothing else', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await composeRole(page, {
      key: 'HISTORY_READER',
      name: 'History reader',
      description: 'Reads the activity history and nothing else.',
      permissions: [['audit', 'read']],
    })
    await page.context().clearCookies()

    /*
     * Invited rather than granted, because accepting *exchanges* applicant
     * access for the role. That is what produces a staff-only account, and a
     * staff-only account is what sign-in sends to `/admin` — the case where a
     * dashboard built entirely from casework had nothing it could load.
     */
    const auditor = await inviteSomebodyTo(page, 'HISTORY_READER')
    await page.context().clearCookies()
    await signIn(page, auditor)

    // Sign-in lands them in the office, and the dashboard renders for a role
    // that can read none of the casework it is otherwise built from.
    await expect(page).toHaveURL(/\/admin$/u)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    // The navigation is drawn, with the one screen they hold in it.
    expect(await navigationSections(page)).toContain('administration')
    await expect(
      page.getByLabel('Portal sections').getByRole('link', { name: 'Activity history' }),
    ).toBeVisible()

    // And that screen actually works.
    await page.goto('/admin/audit')
    await expect(page.getByRole('heading', { name: 'Activity history' })).toBeVisible()
    await expect(page.getByRole('row').first()).toBeVisible()

    /*
     * The door is wide and the screens are narrow, which is the whole point:
     * a refusal on the screen you asked for is a sentence you can act on, while
     * a refusal at the door is being told you are in the wrong building.
     */
    await page.goto('/admin/access')
    await expect(
      page.getByText('This screen is open to super administrators.'),
    ).toBeVisible()
  })
})
