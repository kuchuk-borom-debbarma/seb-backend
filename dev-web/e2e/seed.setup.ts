/**
 * Brings the empty test database up to the state a real deployment starts from.
 *
 * Every step is the product's own path — signup, the curl bootstrap, sign-in —
 * so this doubles as a test of the documented setup procedure. If the
 * first-administrator flow ever breaks, the whole suite fails here with a clear
 * message rather than mysteriously later.
 */
import { test as setup, expect } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  bootstrapSuperAdmin,
  navigationSections,
  signIn,
  signUpApplicant,
} from './support'

setup('the first super administrator can be created and can sign in', async ({ page }) => {
  await signUpApplicant(page, SUPER_ADMIN_EMAIL)

  // Before promotion this is an ordinary applicant.
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  await expect(page).toHaveURL(/\/app$/u)
  expect(await navigationSections(page)).toContain('portal')

  await page.context().clearCookies()
  await bootstrapSuperAdmin()

  // The bootstrap swaps APPLICANT for SUPER_ADMIN rather than adding to it, and
  // destroys existing sessions, so this is a genuinely fresh administrative
  // sign-in.
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  await expect(page.getByText('Super administrator')).toBeVisible()
});
