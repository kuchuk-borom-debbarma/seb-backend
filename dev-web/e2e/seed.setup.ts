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
  OFFICE_ROLES,
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  bootstrapSuperAdmin,
  composeRole,
  navigationSections,
  signIn,
  signUpApplicant,
} from './support'

setup(
  'the first super administrator can be created and can sign in',
  async ({ page }) => {
    await signUpApplicant(page, SUPER_ADMIN_EMAIL)

    // Before promotion this is an ordinary applicant, so sign-in lands on the
    // applicant portal's dashboard.
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await expect(page).toHaveURL(/\/dashboard$/u)
    expect(await navigationSections(page)).toContain('workspace')

    await page.context().clearCookies()
    await bootstrapSuperAdmin()

    /*
     * The bootstrap swaps APPLICANT for SUPER_ADMIN rather than adding to it,
     * and destroys existing sessions, so this is a genuinely fresh
     * administrative sign-in — and it now lands in the office rather than on a
     * portal this account can no longer use.
     */
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await expect(page).toHaveURL(/\/admin$/u)
    expect(await navigationSections(page)).toContain('workspace')

    /*
     * The office's own roles, composed through the screens that compose them.
     *
     * A real deployment starts with none: authority is data now, so the six
     * fixed roles this replaced do not exist and nothing seeds a substitute.
     * Every later spec grants one of these, so composing them here is part of
     * bringing the database up to a state the product can actually reach.
     */
    for (const role of OFFICE_ROLES) {
      await composeRole(page, role)
    }
  },
)
