import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  latestOtp,
  navigationSections,
  signIn,
  signUpApplicant,
  uniqueEmail,
  workerLogLength,
} from './support'

test.describe('landing-page authentication', () => {
  test('shows the safe refusal returned by the backend', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email Address').fill(uniqueEmail('nobody'))
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In as Applicant' }).click()

    await expect(page.getByRole('alert')).toContainText('Invalid email or password')
    await expect(page).toHaveURL(/\/login/u)
  })

  test('registers with the issued code and then signs the applicant in', async ({
    page,
  }) => {
    const email = uniqueEmail('landing-applicant')
    const offset = await workerLogLength()

    await page.goto('/login')
    await page.getByRole('button', { name: 'Create Account' }).click()
    await page.getByLabel('Email Address').fill(email)
    await page.getByRole('button', { name: 'Send verification code' }).click()

    const code = await latestOtp(offset)
    await page.getByLabel(/Six-digit code/u).fill(code)
    await page.getByLabel('Choose a password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create Applicant Account' }).click()

    await expect(page.getByRole('status')).toContainText('Account created')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In as Applicant' }).click()

    await expect(page).toHaveURL(/\/dashboard$/u)
    await expect(page.getByText(email).first()).toBeVisible()
  })
})

test.describe('signing in', () => {
  test('turns away a visitor and remembers where they were going', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL('/login?next=%2Fdashboard')
    await expect(page.getByRole('heading', { name: 'Applicant Sign In' })).toBeVisible()
  })

  test('a signed-out visitor is sent to login from anywhere', async ({ page }) => {
    await page.goto('/applications')
    await expect(page).toHaveURL('/login?next=%2Fapplications')
  })

  test('shows the message the API returned for a wrong password', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email Address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill('not the right password')
    await page.getByRole('button', { name: 'Sign In as Applicant' }).click()

    // The Worker deliberately returns one message for both an unknown address
    // and a wrong password, so this must not leak which it was.
    await expect(page.getByRole('alert')).toContainText('Invalid email or password')
    await expect(page).toHaveURL(/\/login/u)
  })

  test('gives the same answer for an address that does not exist', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email Address').fill(uniqueEmail('nobody'))
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In as Applicant' }).click()
    await expect(page.getByRole('alert')).toContainText('Invalid email or password')
  })

  /**
   * Regression: signing in used to land back on the login page.
   *
   * The identity is read by route guards through `ensureQueryData`, which
   * returns whatever is cached. Invalidating it after sign-in was not enough —
   * the query has no observers, so nothing refetched it and the next guard
   * still held the signed-out answer. This asserts the whole client-side
   * navigation, not just that the API accepted the credentials.
   */
  test('lands on the portal its roles fit, without a full page reload', async ({
    page,
  }) => {
    await page.goto('/login')
    await page.getByLabel('Email Address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In as Applicant' }).click()

    // The bootstrap revoked this account's applicant grant, so the applicant
    // portal would only refuse it. Sign-in sends it to the office instead.
    await expect(page).toHaveURL(/\/admin$/u)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })

  test('returns to the page that was originally asked for', async ({ page }) => {
    await page.goto('/account/sessions')
    await expect(page).toHaveURL('/login?next=%2Faccount%2Fsessions')

    await page.getByLabel('Email Address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In as Applicant' }).click()

    await expect(page).toHaveURL(/\/settings\/security$/u)
  })

  test('sends an already signed-in person straight past the form', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/login')
    await expect(page).not.toHaveURL(/\/login/u)
  })
})

test.describe('signing out', () => {
  test('ends at the public site and refuses the portal afterwards', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()

    await expect(page).toHaveURL('/')

    // Not merely a redirect: the session is deleted, so going back is refused.
    await page.goto('/dashboard')
    await expect(page).toHaveURL('/login?next=%2Fdashboard')
  })
})

test.describe('creating an account', () => {
  test('registers a real applicant through the code sent by the server', async ({
    page,
  }) => {
    const email = uniqueEmail('applicant')
    await signUpApplicant(page, email)

    // Verified signup creates the account but no session, by design.
    await expect(page).toHaveURL(/\/login/u)

    await signIn(page, email)
    await expect(page).toHaveURL(/\/dashboard$/u)
    await expect(page.getByText(email).first()).toBeVisible()
    expect(await navigationSections(page)).toContain('workspace')
  })

  test('refuses a code that is not the one that was sent', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Create Account' }).click()
    await page.getByLabel('Email Address').fill(uniqueEmail('applicant'))
    await page.getByRole('button', { name: 'Send verification code' }).click()

    await page.getByLabel(/Six-digit code/u).fill('000000')
    await page.getByLabel('Choose a password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create Applicant Account' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/login/u)
  })

  test('says where the code actually comes from in development', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Create Account' }).click()
    await page.getByLabel('Email Address').fill(uniqueEmail('applicant'))
    await page.getByRole('button', { name: 'Send verification code' }).click()

    // Honesty rule: the interface must not claim an email was sent when the
    // transport is a console logger.
    await expect(page.getByText('Read the code from the server console')).toBeVisible()
  })

  test('refuses a password the signup policy rejects', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Create Account' }).click()
    await page.getByLabel('Email Address').fill(uniqueEmail('applicant'))
    await page.getByRole('button', { name: 'Send verification code' }).click()

    await page.getByLabel(/Six-digit code/u).fill('123456')
    await page.getByLabel('Choose a password').fill('short')
    await page.getByRole('button', { name: 'Create Applicant Account' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
  })
})
