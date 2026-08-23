import { expect, test } from '@playwright/test'
import { SUPER_ADMIN_EMAIL, signIn, signUpApplicant, uniqueEmail } from './support'

test.describe('the signed-in shell', () => {
  test('shows the account and the roles it actually holds', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)

    const sidebar = page.getByRole('navigation', { name: 'Portal sections' })
    await expect(sidebar.getByText(SUPER_ADMIN_EMAIL)).toBeVisible()
    await expect(sidebar.getByText('super admin')).toBeVisible()

    // Bootstrap swaps APPLICANT for SUPER_ADMIN, so this account holds one role.
    await expect(page.getByText('Super administrator')).toBeVisible()
    await expect(page.getByText('Applicant', { exact: true })).toBeHidden()
  })

  test('an applicant sees the applicant capability and not the administrative one', async ({
    page,
  }) => {
    const email = uniqueEmail('applicant')
    await signUpApplicant(page, email)
    await signIn(page, email)

    await expect(page.getByText('Applicant', { exact: true })).toBeVisible()
    await expect(page.getByText('Programme officer')).toBeHidden()
    await expect(page.getByText('Super administrator')).toBeHidden()
  })

  /**
   * Every link in the sidebar must lead somewhere real.
   *
   * This is the rule the whole client is built on: nothing appears on screen
   * that does not work. A section is added to the navigation only once its
   * screen exists, so an entry that 404s is a defect rather than a to-do.
   */
  test('every navigation link leads to a real page', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)

    const links = page
      .getByRole('navigation', { name: 'Portal sections' })
      .getByRole('link')
    // `evaluateAll` does not auto-wait, so the navigation has to be on screen
    // before the hrefs are collected.
    await expect(links.first()).toBeVisible()
    const targets = await links.evaluateAll((anchors) =>
      anchors.map((anchor) => (anchor as HTMLAnchorElement).getAttribute('href') ?? ''),
    )
    expect(targets.length).toBeGreaterThan(0)

    for (const target of targets) {
      const response = await page.goto(target)
      expect(response?.status(), `${target} should not be an error`).toBeLessThan(400)
      await expect(
        page.getByText('There is nothing at this address'),
        `${target} should not be the not-found page`,
      ).toBeHidden()
    }
  })

  test('marks the current section', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/account/sessions')

    const current = page.getByRole('link', { name: 'Signed-in devices' })
    await expect(current).toHaveAttribute('data-status', 'active')
  })

  test('an unknown address shows the not-found page rather than an error', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/no-such-page')
    await expect(page.getByText('There is nothing at this address')).toBeVisible()
  })
})

test.describe('signed-in devices', () => {
  test('lists this browser and can end other sessions', async ({ page, browser }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)

    // A second browser context is a genuinely separate device holding its own
    // session, which is what makes "sign out other devices" meaningful.
    const second = await browser.newContext()
    const secondPage = await second.newPage()
    await signIn(secondPage, SUPER_ADMIN_EMAIL)

    await page.goto('/account/sessions')
    await expect(page.getByText('This device')).toBeVisible()

    // The suite shares one database, so earlier tests leave sessions behind and
    // an absolute starting count would be meaningless. What is deterministic is
    // the state afterwards: revoking the others leaves exactly this one.
    const before = await page.getByRole('row').count()
    expect(before).toBeGreaterThan(2) // header + this device + at least one other

    await page.getByRole('button', { name: 'Sign out other devices' }).click()
    await expect(page.getByRole('row')).toHaveCount(2) // header + this device

    // The other device is genuinely signed out, not just hidden from the list.
    await secondPage.goto('/app')
    await expect(secondPage).toHaveURL(/\/sign-in/u)
    await second.close()
  })

  test('signing out everywhere ends this session too', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/account/sessions')

    await page.getByRole('button', { name: 'Sign out everywhere' }).click()
    await expect(page).toHaveURL(/\/sign-in/u)

    await page.goto('/app')
    await expect(page).toHaveURL('/sign-in?next=%2Fapp')
  })
})
