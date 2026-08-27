/**
 * Two portals, and the line between them.
 *
 * The rule being tested is not "the right screen appears" but something
 * stricter: nothing is ever offered that this account cannot open. A refusal
 * has to say what the account is, where it can go, and — when it can go
 * nowhere — what to ask for. And the navigation beside a refusal must be the
 * one that works, not the one that just turned somebody away.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  signIn,
  signUpApplicant,
  uniqueEmail,
} from './support'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Portal sections' })

/** The measure the shell is currently set to, as the browser computes it. */
const shellSize = (page: Page) =>
  page.evaluate(() => {
    const shell = document.querySelector('[data-portal]')
    return shell ? getComputedStyle(shell).fontSize : '0'
  })

test.describe('the applicant portal', () => {
  test('is the dashboard, and sign-in lands there', async ({ page }) => {
    const email = uniqueEmail('portal')
    await signUpApplicant(page, email)
    await signIn(page, email)

    // The root is the public site now; the signed-in home is /dashboard.
    await expect(page).toHaveURL(/\/dashboard$/u)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(sidebar(page).getByRole('link', { name: 'Enterprises' })).toBeVisible()
  })

  test('offers nothing from the programme office', async ({ page }) => {
    const email = uniqueEmail('portal')
    await signUpApplicant(page, email)
    await signIn(page, email)

    for (const entry of [
      'Intake',
      'Cycle administration',
      'Access',
    ]) {
      await expect(sidebar(page).getByRole('link', { name: entry })).toHaveCount(0)
    }
  })

  test('refuses the console, and says where this account can go instead', async ({
    page,
  }) => {
    const email = uniqueEmail('portal')
    await signUpApplicant(page, email)
    await signIn(page, email)
    await page.goto('/admin')

    await expect(
      page.getByRole('heading', {
        name: 'This part of Mission SEP is for the programme office',
      }),
    ).toBeVisible()
    await expect(page.getByText('This account holds')).toBeVisible()
    // "Applicant" also appears in the shell's own chrome, so scope to the
    // refusal card's main region.
    await expect(
      page.getByRole('main').getByText('Applicant', { exact: true }).first(),
    ).toBeVisible()

    // And the navigation beside the refusal is the one that works — listing
    // four links that would every one of them refuse is the thing this
    // interface does not do.
    await expect(sidebar(page).getByRole('link', { name: 'Enterprises' })).toBeVisible()
    await expect(sidebar(page).getByRole('link', { name: 'Intake' })).toHaveCount(0)

    await page.getByRole('link', { name: 'Go to the applicant portal' }).click()
    await expect(page).toHaveURL(/\/dashboard$/u)
  })
})

test.describe('the programme office', () => {
  test('is where sign-in lands an account with no applicant grant', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

    await expect(page).toHaveURL(/\/admin$/u)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(sidebar(page).getByText('Programme office')).toBeVisible()
  })

  test('refuses the applicant portal to an account that is not one', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    // The root is public; the applicant portal starts at /dashboard.
    await page.goto('/dashboard')

    await expect(
      page.getByRole('heading', { name: 'This part of Mission SEP is for applicants' }),
    ).toBeVisible()
    await expect(page.getByText('Super administrator')).toBeVisible()

    await page.getByRole('link', { name: 'Go to the programme office' }).click()
    await expect(page).toHaveURL(/\/admin$/u)
  })

  test('an administrator is refused role management', async ({ page }) => {
    // A real second person, granted ADMIN and nothing more.
    const colleague = uniqueEmail('officer')
    await signUpApplicant(page, colleague)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/access?email=${encodeURIComponent(colleague)}`)
    await page.getByLabel('Role').selectOption('ADMIN')
    await page.getByLabel('Why they should have it').fill('Joining the desk review team.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()
    await expect(page.getByText('Admin granted.')).toBeVisible()

    await page.context().clearCookies()
    await signIn(page, colleague)

    // The console opens — either administrative role does that.
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    // Role management does not, and is not advertised.
    await expect(sidebar(page).getByRole('link', { name: 'Access' })).toHaveCount(0)
    await page.goto('/admin/access')
    await expect(
      page.getByRole('heading', {
        name: 'This part of Mission SEP is for the programme office',
      }),
    ).toBeVisible()
  })
})

test.describe('an account holding both', () => {
  test('crosses between the portals by the sidebar link', async ({ page }) => {
    // The bootstrap revoked the founder's applicant grant, so build an account
    // that genuinely holds both: sign up, then grant ADMIN.
    const both = uniqueEmail('both')
    await signUpApplicant(page, both)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/access?email=${encodeURIComponent(both)}`)
    await page.getByLabel('Role').selectOption('ADMIN')
    await page.getByLabel('Why they should have it').fill('Runs the demonstration.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()
    await expect(page.getByText('Admin granted.')).toBeVisible()

    await page.context().clearCookies()
    await signIn(page, both)

    // Holding applicant, sign-in lands on the applicant portal.
    await expect(page).toHaveURL(/\/dashboard$/u)

    // The crossing lives in the account menu now, so open it first each way.
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Programme office' }).click()
    await expect(page).toHaveURL(/\/admin$/u)

    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Applicant portal' }).click()
    await expect(page).toHaveURL(/\/dashboard$/u)
  })
})

test.describe('the two densities', () => {
  test('the applicant portal is set larger than the console', async ({ page }) => {
    const both = uniqueEmail('density')
    await signUpApplicant(page, both)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/access?email=${encodeURIComponent(both)}`)
    await page.getByLabel('Role').selectOption('ADMIN')
    await page.getByLabel('Why they should have it').fill('Comparing the two portals.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()
    await expect(page.getByText('Admin granted.')).toBeVisible()

    await page.context().clearCookies()
    await signIn(page, both)

    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    const applicant = Number.parseFloat(await shellSize(page))

    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    const office = Number.parseFloat(await shellSize(page))

    /*
     * Somebody applying once in their life gets room; somebody working forty
     * applications a day gets density. Asserted as a computed value rather than
     * a class name, because the point is what a reader actually sees.
     */
    expect(applicant).toBeGreaterThan(office)
  })
})

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 900 } })

  test('the applicant portal fits, at its own measure', async ({ page }) => {
    const email = uniqueEmail('narrow')
    await signUpApplicant(page, email)
    await signIn(page, email)

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    // The larger applicant measure must not cost the page its fit. A card
    // header with a long title beside a badge is where this last broke.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })
})
