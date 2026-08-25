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
  latestInviteLink,
  navigationSections,
  signIn,
  signOut,
  signUpApplicant,
  uniqueEmail,
} from './support'

/**
 * Signs somebody up, invites them to a role, and accepts on their behalf.
 *
 * The whole flow, because it is the only way to become staff: there is no
 * seeded reviewer to borrow, which is the point of the invitation existing.
 */
const inviteSomebodyTo = async (
  page: import('@playwright/test').Page,
  role: 'Reviewer' | 'Approver',
) => {
  const email = uniqueEmail('invited')
  // Signup deliberately creates no session, so there is nobody to sign out.
  await signUpApplicant(page, email)

  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  await page.goto('/admin/invite')
  await page.getByLabel('Their email address').fill(email)
  await page.getByRole('button', { name: 'Look them up' }).click()
  await expect(page.getByRole('heading', { name: email })).toBeVisible()
  // Selected by value rather than label, because the labels carry a
  // description after the role name.
  await page.getByLabel('Invite them to be').selectOption(role.toUpperCase())
  await page.getByLabel('Why').fill('Joining the intake team')
  await page.getByRole('button', { name: 'Send the invitation' }).click()
  await expect(page.getByText(`Invitation sent to ${email}`)).toBeVisible()

  // The link is never shown to the issuer; it only exists in what was sent.
  await expect(page.getByText('/invite#')).toHaveCount(0)
  const link = await latestInviteLink(email)
  await signOut(page)

  await signIn(page, email, PASSWORD)
  await page.goto(link)
  await page.getByRole('button', { name: 'Accept the invitation' }).click()
  await expect(page.getByRole('heading', { name: /You are now/u })).toBeVisible()
  return email
}

test.describe('being invited into the office', () => {
  test('a reviewer arrives, and can read casework without changing it', async ({
    page,
  }) => {
    await inviteSomebodyTo(page, 'Reviewer')

    // The applicant grant was exchanged, not added to, so the office is where
    // they work now.
    await page.goto('/admin')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    /*
     * Read-only means the administration group is absent entirely — a reviewer
     * governs nothing. Casework is theirs to read.
     */
    const sections = await navigationSections(page)
    expect(sections).toContain('casework')
    expect(sections).not.toContain('administration')

    /*
     * And a screen they cannot reach says which one it is and who holds it —
     * rather than "this part is for the programme office", which would be
     * untrue of somebody already working in it.
     */
    await page.goto('/admin/audit')
    await expect(
      page.getByText('This screen is open to super administrators.'),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to intake' })).toBeVisible()
  })

  test('an approver sees casework and still governs nothing', async ({ page }) => {
    await inviteSomebodyTo(page, 'Approver')
    await page.goto('/admin')
    const sections = await navigationSections(page)
    expect(sections).toContain('casework')
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
    await expect(page.getByRole('link', { name: 'Invite a colleague' })).toBeVisible()
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
