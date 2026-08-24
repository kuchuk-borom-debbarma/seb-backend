import { expect, test } from '@playwright/test'
import { SUPER_ADMIN_EMAIL, signIn, signUpApplicant, uniqueEmail } from './support'

test.describe('the signed-in shell', () => {
  test('shows the account, the roles it holds, and only its own portal', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)

    const sidebar = page.getByRole('navigation', { name: 'Portal sections' })
    await expect(sidebar.getByText(SUPER_ADMIN_EMAIL)).toBeVisible()
    await expect(sidebar.getByText('super admin')).toBeVisible()

    /*
     * Bootstrap swaps APPLICANT for SUPER_ADMIN, so this account holds one role
     * and belongs in one portal. The office masthead names it, and none of the
     * applicant sections are offered.
     */
    await expect(sidebar.getByText('Programme office', { exact: true })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Dashboard' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Enterprises' })).toHaveCount(0)
    await expect(sidebar.getByRole('link', { name: 'Applicant portal' })).toHaveCount(0)
  })

  test('an applicant sees the applicant capability and not the administrative one', async ({
    page,
  }) => {
    const email = uniqueEmail('applicant')
    await signUpApplicant(page, email)
    await signIn(page, email)

    const sidebar = page.getByRole('navigation', { name: 'Portal sections' })
    await expect(sidebar.getByText('Applicant', { exact: true })).toBeVisible()
    await expect(sidebar.getByText('Programme officer')).toBeHidden()
    await expect(sidebar.getByText('Super administrator')).toBeHidden()
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

    const current = page.getByRole('link', { name: 'Settings' })
    await expect(current).toHaveAttribute('aria-current', 'page')
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
    await secondPage.goto('/')
    await expect(secondPage).toHaveURL(/\/sign-in/u)
    await second.close()
  })

  test('signing out everywhere ends this session too', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/account/sessions')

    await page.getByRole('button', { name: 'Sign out everywhere' }).click()
    await expect(page).toHaveURL(/\/sign-in/u)

    await page.goto('/')
    await expect(page).toHaveURL('/sign-in?next=%2F')
  })
})

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 360, height: 900 } })

  test('the navigation becomes a drawer and the page never scrolls sideways', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/admin')

    // The links remain in the same order, but stay outside the viewport until
    // the compact header opens the drawer.
    const navigation = page.getByRole('navigation', { name: 'Portal sections' })
    await expect(navigation).toBeHidden()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(navigation).toBeVisible()
    await expect(navigation.getByRole('link', { name: 'Dashboard' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(navigation).toBeHidden()
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()

    // Wide content scrolls inside its own container; the body does not.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('a table scrolls inside its wrapper rather than collapsing', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/admin')

    const wrapper = page.locator('.table-wrap').first()
    const scrollable = await wrapper.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    )
    expect(scrollable).toBe(true)
  })
})

test.describe('by keyboard alone', () => {
  test('every control on the sign-in screen is reachable and visibly focused', async ({
    page,
  }) => {
    await page.goto('/sign-in')

    const reached: string[] = []
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab')
      const here = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null
        if (!element || element === document.body) return null
        // The focus ring must be drawn by :focus-visible, not merely implied.
        const outline = getComputedStyle(element).outlineWidth
        return `${element.tagName.toLowerCase()}:${outline}`
      })
      if (here) reached.push(here)
    }

    // Email, password, the submit button and the sign-up link at least.
    expect(reached.length).toBeGreaterThanOrEqual(4)
    // Nothing lands with no ring at all.
    expect(reached.every((entry) => !entry.endsWith(':0px'))).toBe(true)
  })

  test('the skip of a disabled action is not a trap', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/admin')

    // Tabbing forward from the first link always moves on; a control that
    // swallowed focus would return the same element twice.
    await page.keyboard.press('Tab')
    const first = await page.evaluate(() => document.activeElement?.textContent ?? '')
    await page.keyboard.press('Tab')
    const second = await page.evaluate(() => document.activeElement?.textContent ?? '')
    expect(second).not.toBe(first)
  })
})
