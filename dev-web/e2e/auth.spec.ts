import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  navigationSections,
  signIn,
  signOut,
  signUpApplicant,
  uniqueEmail,
} from './support'

test.describe('signing in', () => {
  test('turns away a visitor and remembers where they were going', async ({ page }) => {
    await page.goto('/app')
    await expect(page).toHaveURL('/sign-in?next=%2Fapp')
    await expect(page.getByRole('heading', { name: 'Mission SEP' })).toBeVisible()
  })

  test('the root address sends a signed-out visitor to sign in', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL('/sign-in')
  })

  test('shows the message the API returned for a wrong password', async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByLabel('Email address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password').fill('not the right password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    // The Worker deliberately returns one message for both an unknown address
    // and a wrong password, so this must not leak which it was.
    await expect(page.getByRole('alert')).toContainText('Invalid email or password')
    await expect(page).toHaveURL(/\/sign-in/u)
  })

  test('gives the same answer for an address that does not exist', async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByLabel('Email address').fill(uniqueEmail('nobody'))
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('alert')).toContainText('Invalid email or password')
  })

  /**
   * Regression: signing in used to land back on the sign-in page.
   *
   * The identity is read by route guards through `ensureQueryData`, which
   * returns whatever is cached. Invalidating it after sign-in was not enough —
   * the query has no observers, so nothing refetched it and the next guard
   * still held the signed-out answer. This asserts the whole client-side
   * navigation, not just that the API accepted the credentials.
   */
  test('lands on the portal without a full page reload', async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByLabel('Email address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/app$/u)
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  })

  test('returns to the page that was originally asked for', async ({ page }) => {
    await page.goto('/account/sessions')
    await expect(page).toHaveURL('/sign-in?next=%2Faccount%2Fsessions')

    await page.getByLabel('Email address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/account\/sessions$/u)
  })

  test('sends an already signed-in person straight past the form', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/sign-in')
    await expect(page).toHaveURL(/\/app$/u)
  })
})

test.describe('signing out', () => {
  test('ends the session and refuses the portal afterwards', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await signOut(page)

    // Not merely a redirect: the session is deleted, so going back is refused.
    await page.goto('/app')
    await expect(page).toHaveURL('/sign-in?next=%2Fapp')
  })
})

test.describe('creating an account', () => {
  test('registers a real applicant through the code sent by the server', async ({
    page,
  }) => {
    const email = uniqueEmail('applicant')
    await signUpApplicant(page, email)

    // Verified signup creates the account but no session, by design.
    await expect(page).toHaveURL(/\/sign-in/u)

    await signIn(page, email)
    await expect(page).toHaveURL(/\/app$/u)
    await expect(page.getByText(email).first()).toBeVisible()
    expect(await navigationSections(page)).toContain('portal')
  })

  test('refuses a code that is not the one that was sent', async ({ page }) => {
    await page.goto('/sign-up')
    await page.getByLabel('Email address').fill(uniqueEmail('applicant'))
    await page.getByRole('button', { name: 'Send verification code' }).click()

    await page.getByLabel(/Six-digit code/u).fill('000000')
    await page.getByLabel('Choose a password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/sign-up/u)
  })

  test('says where the code actually comes from in development', async ({ page }) => {
    await page.goto('/sign-up')
    await page.getByLabel('Email address').fill(uniqueEmail('applicant'))
    await page.getByRole('button', { name: 'Send verification code' }).click()

    // Honesty rule: the interface must not claim an email was sent when the
    // transport is a console logger.
    await expect(page.getByText('Read the code from the server console')).toBeVisible()
  })

  test('refuses a password the signup policy rejects', async ({ page }) => {
    await page.goto('/sign-up')
    await page.getByLabel('Email address').fill(uniqueEmail('applicant'))
    await page.getByRole('button', { name: 'Send verification code' }).click()

    await page.getByLabel(/Six-digit code/u).fill('123456')
    await page.getByLabel('Choose a password').fill('short')
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
  })
})
