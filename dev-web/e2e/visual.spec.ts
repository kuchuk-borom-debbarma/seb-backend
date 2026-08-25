import { expect, test } from '@playwright/test'
import {
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  signUpApplicant,
  startApplication,
  uniqueEmail,
} from './support'

const stabilizeDynamicText = async (page: import('@playwright/test').Page) => {
  await page.addStyleTag({
    content: `
      [class*="metricValue"],
      [class*="queueCard"] strong,
      [class*="accountText"] strong,
      [class*="cycleCallout"] h2,
      [class*="cycleCallout"] p,
      [class*="details"] dd,
      .tabular { color: transparent !important; }
    `,
  })
}

test.describe('stable platform visuals', () => {
  test('authentication', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveScreenshot('authentication.png', {
      animations: 'disabled',
    })
  })

  test('programme-office dashboard and navigation states', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await stabilizeDynamicText(page)
    const dynamicMeetings = page.getByRole('region', {
      name: 'Latest scheduled meetings',
    })

    await expect(page).toHaveScreenshot('office-dashboard-expanded.png', {
      animations: 'disabled',
      mask: [dynamicMeetings],
      maskColor: '#f7f7f8',
    })

    await page.getByRole('button', { name: 'Collapse navigation' }).click()
    await expect(page.locator('[data-collapsed="true"]')).toBeVisible()
    await expect(page).toHaveScreenshot('office-dashboard-collapsed.png', {
      animations: 'disabled',
      mask: [dynamicMeetings],
      maskColor: '#f7f7f8',
    })
  })

  test('applicant dashboard', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await openProgrammeCycle(page, { prefix: 'VISUAL' })
    await page.context().clearCookies()

    const email = uniqueEmail('visual-applicant')
    await signUpApplicant(page, email)
    await signIn(page, email)
    await stabilizeDynamicText(page)

    await expect(page).toHaveScreenshot('applicant-dashboard.png', {
      animations: 'disabled',
    })
  })

  test('categorized application journey on desktop and mobile', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await openProgrammeCycle(page, { prefix: 'VISUAL-JOURNEY' })
    await page.context().clearCookies()

    await startApplication(page, {
      prefix: 'visual-journey',
      businessName: 'Visual Journey Works',
    })
    const firstVisitDismissal = page.getByText('Not now', { exact: true })
    if (await firstVisitDismissal.isVisible()) await firstVisitDismissal.click()
    await stabilizeDynamicText(page)
    const journey = page.getByTestId('form-journey')
    const closingNotice = page.getByText('When applications close').locator('..')
    await expect(page).toHaveScreenshot('application-journey-desktop.png', {
      animations: 'disabled',
      mask: [closingNotice],
      maskColor: '#f7f7f8',
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByLabel('Application category')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Form categories' })).toBeHidden()
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page).toHaveScreenshot('application-journey-mobile.png', {
      animations: 'disabled',
      mask: [closingNotice],
      maskColor: '#f7f7f8',
    })

    const finalControl = page.getByLabel(
      'Majority ownership is held by Scheduled Tribe members',
    )
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const [controlBox, footerBox] = await Promise.all([
      finalControl.boundingBox(),
      journey.locator('footer').boundingBox(),
    ])
    expect(
      controlBox && footerBox && controlBox.y + controlBox.height <= footerBox.y,
    ).toBe(true)

    await page.setViewportSize({ width: 360, height: 800 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0)
  })

  test('general settings', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/settings/general')
    await stabilizeDynamicText(page)

    await expect(page).toHaveScreenshot('settings-general.png', {
      animations: 'disabled',
    })
  })
})

test.describe('stable mobile platform visuals', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('open navigation drawer', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await stabilizeDynamicText(page)

    await expect(page).toHaveScreenshot('mobile-navigation-drawer.png', {
      animations: 'disabled',
    })
  })
})
