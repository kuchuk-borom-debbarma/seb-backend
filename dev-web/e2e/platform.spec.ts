import { expect, test } from '@playwright/test'
import {
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  startApplication,
} from './support'

test.describe('the platform shell', () => {
  test('orders the office navigation around the dashboard and account utilities', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)

    const navigation = page.getByRole('navigation', { name: 'Portal sections' })
    await expect(navigation.getByRole('link').first()).toBeVisible()
    const links = await navigation.getByRole('link').allInnerTexts()

    expect(links.slice(0, 3)).toEqual(['Dashboard', 'Applications', 'Committee meetings'])
    expect(links).toContain('How this works')
    expect(links).toContain('Settings')
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Waiting on us' })).toBeVisible()
    await expect(page.getByLabel('Reference number')).toBeEditable()
    const quickActions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Quick actions' }),
    })
    await expect(
      quickActions.getByRole('link', { name: 'Schedule a meeting' }),
    ).toBeVisible()
    await expect(
      quickActions.getByRole('link', { name: 'Create a programme cycle' }),
    ).toBeVisible()
    await expect(
      quickActions.getByRole('link', { name: 'Invite a colleague' }),
    ).toBeVisible()
  })

  test('keeps the owning office section active on an application detail', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/admin/applications/00000000-0000-4000-8000-000000000000')

    const navigation = page.getByRole('navigation', { name: 'Portal sections' })
    await expect(navigation.getByRole('link', { name: 'Applications' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('gives an applicant a data-backed dashboard', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await openProgrammeCycle(page, { prefix: 'DASH' })
    await page.context().clearCookies()
    await startApplication(page, {
      prefix: 'platform-dashboard',
      businessName: 'Dashboard Works',
    })
    await page.goto('/dashboard')

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    const summary = page.getByRole('region', { name: 'Account summary' })
    await expect(summary.getByRole('link', { name: /Applications/u })).toContainText('1')
    await expect(summary.getByRole('link', { name: /Enterprises/u })).toContainText('1')
    await expect(summary.getByRole('link', { name: /Open cycles/u })).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'Continue your application' }),
    ).toBeVisible()
    await expect(page.getByText('Dashboard Works')).toBeVisible()

    const navigation = page.getByRole('navigation', { name: 'Portal sections' })
    expect((await navigation.getByRole('link').allInnerTexts()).slice(0, 4)).toEqual([
      'Dashboard',
      'Applications',
      'Enterprises',
      'Programme cycles',
    ])
  })

  test('moves account identity and sessions into settings', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/settings/general')

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(
      page.getByRole('definition').filter({ hasText: SUPER_ADMIN_EMAIL }),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Security' })).toBeVisible()

    await page.goto('/account/sessions')
    await expect(page).toHaveURL(/\/settings\/security$/u)

    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings\/general$/u)
  })

  test('opens a keyboard-usable profile menu and signs out', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)

    const account = page.getByRole('button', { name: 'Account menu' })
    await account.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
    await expect(account).toBeFocused()

    await account.click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await expect(page).toHaveURL('/')
  })
})

test.describe('the platform shell on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 900 } })

  test('opens the portal navigation as a dismissible drawer', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)

    const trigger = page.getByRole('button', { name: 'Open navigation' })
    const navigation = page.getByRole('navigation', { name: 'Portal sections' })

    await expect(trigger).toBeVisible()
    await expect(navigation).toBeHidden()
    await trigger.click()
    await expect(navigation).toBeVisible()
    await expect(page.locator('body')).toHaveAttribute('data-navigation-open', 'true')
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(navigation).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page.getByRole('button', { name: 'Close navigation' }).last().click()
    await expect(navigation).toBeHidden()
    await expect(trigger).toBeFocused()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })
})
