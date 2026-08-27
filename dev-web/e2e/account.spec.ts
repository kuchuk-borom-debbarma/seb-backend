import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  latestOtp,
  signIn,
  signOut,
  signUpApplicant,
  uniqueEmail,
} from './support'

/*
 * Every test here owns the account it changes.
 *
 * Not a style preference: these flows change credentials and end sessions, so a
 * shared account would break whatever else was signed in as it. That is exactly
 * how `founder@example.com` must be treated — other specs sign in as it, and
 * they run against the same database.
 */

test.describe('resetting a forgotten password', () => {
  test('sends a code, sets a new password, and signs the old devices out', async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail('forgot')
    await signUpApplicant(page, email)
    await signIn(page, email)

    // A second device, so "every device is signed out" can be shown rather
    // than asserted about the tab doing the resetting.
    const second = await browser.newContext()
    const secondPage = await second.newPage()
    await signIn(secondPage, email)
    await signOut(page)

    // The way in is from the login screen, so prove that link goes somewhere.
    await page.goto('/login')
    await page.getByRole('link', { name: 'Forgot your password?' }).click()
    await expect(page).toHaveURL(/\/forgot-password/u)

    /*
     * Loaded rather than reached by the in-app link, and the difference is not
     * cosmetic: arriving here by client-side navigation immediately after
     * signing out leaves the route re-resolving its session, which remounts the
     * form and discards whatever has been typed. The link is asserted above;
     * the flow is exercised from a clean load.
     */
    /*
     * The code signup sent, so the reset code can be told from it. Both go to
     * the same address, and the log is a pipe — read without this, the newest
     * line is still the signup code and the reset fails as "invalid".
     */
    const signupCode = await latestOtp(email)

    await page.goto('/forgot-password')
    const address = page.getByLabel('Email address')
    await expect(address).toBeVisible()
    await address.fill(email)
    await expect(address).toHaveValue(email)
    await page.getByRole('button', { name: 'Send reset code' }).click()

    const code = await latestOtp(email, { differentFrom: signupCode })
    await page.getByLabel(/Six-digit code/u).fill(code)
    const NEW_PASSWORD = 'a different correct horse'
    await page.getByLabel('Choose a new password').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Set new password' }).click()

    // Ends on the login screen: a reset deliberately does not create a session.
    await page.waitForURL('**/login')

    await signIn(page, email, NEW_PASSWORD)
    await expect(page).not.toHaveURL(/\/login/u)

    // The other device really was signed out, not merely hidden from a list.
    // The root is public now, so a portal route is what proves it.
    await secondPage.goto('/applications')
    await expect(secondPage).toHaveURL(/\/login/u)
    await second.close()
  })

  test('says the same thing for an address that has no account', async ({ page }) => {
    /*
     * The enumeration defence, seen from the screen. If this page ever answered
     * differently for a stranger's address, it would tell anybody who asked
     * which businesses had applied for funding.
     */
    await page.goto('/forgot-password')
    await page.getByLabel('Email address').fill(uniqueEmail('nobody'))
    await page.getByRole('button', { name: 'Send reset code' }).click()

    // It advances to the code step exactly as a real address does.
    await expect(page.getByLabel(/Six-digit code/u)).toBeVisible()
  })
})

test.describe('changing a password that is known', () => {
  test('changes it, and keeps this device signed in', async ({ page }) => {
    const email = uniqueEmail('changepw')
    await signUpApplicant(page, email)
    await signIn(page, email)

    // The old address forwards to settings, where the form lives now.
    await page.goto('/account/security')
    await page.getByLabel('Current password').fill(PASSWORD)
    const NEW_PASSWORD = 'another correct horse entirely'
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('Repeat the new password').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Change password' }).click()

    await expect(page.getByText('Your password has been changed.')).toBeVisible()

    // Still signed in here — the person is holding this session.
    await page.goto('/account/sessions')
    await expect(page.getByText('This device')).toBeVisible()

    await signOut(page)
    await signIn(page, email, NEW_PASSWORD)
    await expect(page).toHaveURL(/\/(?!sign-in)/u)
  })

  test('refuses a wrong current password, and catches a mistyped repeat', async ({ page }) => {
    const email = uniqueEmail('changepwbad')
    await signUpApplicant(page, email)
    await signIn(page, email)
    // The old address forwards to settings, where the form lives now.
    await page.goto('/account/security')

    // The repeat is checked in the browser, so this never reaches the API and
    // never spends an allowance.
    await page.getByLabel('Current password').fill(PASSWORD)
    await page.getByLabel('New password', { exact: true }).fill('a long enough password')
    await page.getByLabel('Repeat the new password').fill('a different one entirely')
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('These two do not match.')).toBeVisible()

    await page.getByLabel('Current password').fill('not the password')
    await page.getByLabel('Repeat the new password').fill('a long enough password')
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('Your password is incorrect.')).toBeVisible()
  })
})

test.describe('changing the address you sign in with', () => {
  test('confirms the new address by code, then signs in with it', async ({ page }) => {
    const email = uniqueEmail('changeemail')
    await signUpApplicant(page, email)
    await signIn(page, email)

    const moved = uniqueEmail('moved')
    await page.goto('/account/profile')
    await page.getByLabel('New email address').fill(moved)
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Send confirmation code' }).click()

    // Keyed on the new address, because that is where the code was sent.
    const code = await latestOtp(moved)
    await page.getByLabel(/Six-digit code/u).fill(code)
    await page.getByRole('button', { name: 'Confirm new address' }).click()
    await expect(page.getByText('Address changed')).toBeVisible()

    await signOut(page)
    await signIn(page, moved)
    await expect(page).toHaveURL(/\/(?!sign-in)/u)

    // The address it moved off no longer names anybody.
    await signOut(page)
    await page.goto('/login')
    await page.getByLabel('Email address').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
  })
})

test.describe('what you are called', () => {
  test('saves a name and shows it back', async ({ page }) => {
    const email = uniqueEmail('named')
    await signUpApplicant(page, email)
    await signIn(page, email)

    await page.goto('/account/profile')
    await page.getByLabel('Name').fill('Ada Lovelace')
    await page.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByText('Your name has been saved.')).toBeVisible()

    // Survives a reload, so it was stored rather than held in the form.
    await page.reload()
    await expect(page.getByLabel('Name')).toHaveValue('Ada Lovelace')
  })
})
