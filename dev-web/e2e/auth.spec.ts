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
  test('the root is the public site; the portal remembers where you were going', async ({
    page,
  }) => {
    // The landing page is public now — no redirect, no session needed.
    await page.goto('/')
    await expect(page).toHaveURL('/')

    // Portal routes still turn a visitor away, remembering the destination.
    await page.goto('/applications')
    await expect(page).toHaveURL('/login?next=%2Fapplications')
  })

  test('shows the message the API returned for a wrong password', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill('not the right password')
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()

    // The Worker deliberately returns one message for both an unknown address
    // and a wrong password, so this must not leak which it was.
    await expect(page.getByRole('alert')).toContainText('Invalid email or password')
    await expect(page).toHaveURL(/\/login/u)
  })

  test('gives the same answer for an address that does not exist', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(uniqueEmail('nobody'))
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
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
  test('lands on the portal its roles fit, without a full page reload', async ({
    page,
  }) => {
    await page.goto('/login')
    await page.getByLabel('Email address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()

    // The bootstrap revoked this account's applicant grant, so the applicant
    // portal would only refuse it. Sign-in sends it to the office instead.
    await expect(page).toHaveURL(/\/admin$/u)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })

  test('returns to the page that was originally asked for', async ({ page }) => {
    await page.goto('/account/sessions')
    await expect(page).toHaveURL('/login?next=%2Faccount%2Fsessions')

    await page.getByLabel('Email address').fill(SUPER_ADMIN_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()

    // The old sessions address forwards to its new home in settings.
    await expect(page).toHaveURL(/\/settings\/security$/u)
  })

  test('sends an already signed-in person straight past the form', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await page.goto('/login')
    await expect(page).not.toHaveURL(/\/login/u)
  })
})

test.describe('signing out', () => {
  test('ends the session and refuses the portal afterwards', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL)
    await signOut(page)

    // Not merely a redirect: the session is deleted, so a portal route is
    // refused afterwards. (The root itself is the public site now.)
    await page.goto('/applications')
    await expect(page).toHaveURL('/login?next=%2Fapplications')
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
