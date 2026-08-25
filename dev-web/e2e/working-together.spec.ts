/**
 * Two officers, one file, and nothing reserved beforehand.
 *
 * The office used to require claiming an application before acting on it, and
 * the claim locked everybody else out. It was never what made a write safe —
 * the version guard on each transition is — and it cost something concrete:
 * reading a document was gated on holding the file, and a reviewer could not
 * hold anything, so the role that exists to read casework could not open a
 * single piece of evidence.
 *
 * What replaced it is a notice. These tests hold the properties that makes
 * necessary: the notice forbids nothing, the second officer through is refused
 * cleanly rather than overwriting, and a reviewer can read.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  latestInviteLink,
  signIn,
  signOut,
  signUpApplicant,
  submitApplication,
  uniqueEmail,
} from './support'

/**
 * Asserts the workspace's status badge rather than any text on the page.
 *
 * `getByText('Partner bank')` looks like it proves the review completed and
 * does not: the guide's route diagram draws that desk label on every workspace
 * screen, so it matches four elements whatever the status.
 */
const expectStatus = async (page: Page, status: string) => {
  await expect(page.locator('.badge').filter({ hasText: status }).first()).toBeVisible()
}

test.describe('working the same file', () => {
  test('says who was here last, and disables nothing', async ({ page }) => {
    test.setTimeout(120_000)
    const { id } = await submitApplication(page, { prefix: 'shared' })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

    // Nobody has touched it, and it is workable immediately — there is no step
    // between opening a file and acting on it.
    await page.goto(`/admin/applications/${id}`)
    await expect(
      page.getByRole('heading', { name: 'Nobody has worked this yet' }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start desk review' })).toBeEnabled()

    // Starting the review is what records the actor. There is nothing else that
    // does, so a file under review would otherwise name nobody.
    await page.getByRole('button', { name: 'Start desk review' }).click()
    await page.goto(`/admin/applications/${id}`)
    await expect(
      page.getByRole('heading', { name: 'You worked this last' }),
    ).toBeVisible()

    // No claim, release or takeover control exists anywhere on the screen —
    // absent, not disabled. A control that only ever refuses teaches people to
    // distrust the screen.
    for (const gone of ['Claim it', 'Release it', 'Take it over', 'Hand it to someone']) {
      await expect(page.getByRole('button', { name: gone })).toHaveCount(0)
    }
  })

  test('lets a second officer act on a file somebody else started', async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000)
    const { id } = await submitApplication(page, { prefix: 'second' })

    // The first officer starts the review and stops there.
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/applications/${id}`)
    await page.getByRole('button', { name: 'Start desk review' }).click()

    // A second officer, in a separate browser context, picks it up. Signing up
    // creates no session, so the super administrator's is still the one here.
    const invited = uniqueEmail('secondofficer')
    await signOut(page)
    await signUpApplicant(page, invited)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/invite')
    await page.getByLabel('Their email address').fill(invited)
    await page.getByRole('button', { name: 'Look them up' }).click()
    await expect(page.getByRole('heading', { name: invited })).toBeVisible()
    await page.getByLabel('Invite them to be').selectOption('ADMIN')
    await page.getByLabel('Why').fill('Second officer on intake')
    await page.getByRole('button', { name: 'Send the invitation' }).click()
    const link = await latestInviteLink(invited)
    await signOut(page)
    await signIn(page, invited, PASSWORD)
    await page.goto(link)
    await page.getByRole('button', { name: 'Accept the invitation' }).click()

    const other = await browser.newContext()
    const otherPage = await other.newPage()
    await signIn(otherPage, invited, PASSWORD)
    await otherPage.goto(`/admin/applications/${id}`)

    /*
     * They are told somebody has been here, and it is a notice rather than a
     * refusal: the form below it is theirs to complete. This is the whole
     * behaviour the claim used to prevent.
     */
    await expect(otherPage.getByText('Somebody else has been here')).toBeVisible()
    await expect(
      otherPage.getByRole('heading', { name: 'Complete the desk review' }),
    ).toBeVisible()
    await other.close()
  })

  test('refuses the second of two simultaneous reviews, and recovers', async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000)
    const { id } = await submitApplication(page, { prefix: 'race' })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/applications/${id}`)
    await page.getByRole('button', { name: 'Start desk review' }).click()

    // The same officer in two tabs is the honest reproduction of two officers:
    // the guard is on the record's version, not on who holds it.
    const other = await browser.newContext({
      storageState: await page.context().storageState(),
    })
    const otherPage = await other.newPage()

    const fill = async (target: typeof page, certificate: string, account: string) => {
      await target.goto(`/admin/applications/${id}`)
      for (const check of [
        'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
        'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
        'DPR_FEASIBILITY',
      ]) {
        await target.locator(`input[name="${check}"]`).first().check()
      }
      await target.locator('input[name="EXPANSION_EVIDENCE"]').last().check()
      await target.getByLabel('Scheduled Tribe certificate number').fill(certificate)
      await target.getByLabel('Identity document number').fill(account)
      await target.getByLabel('Bank account number').fill('50010000660')
      await target.getByLabel('Branch code (IFSC)').fill('SBIN0007890')
      await target.getByRole('radio', { name: /Refer to a partner bank/u }).check()
    }

    // Both load the same version, so both hold the same expected version.
    await fill(page, 'TR/ST/2026-660011', '660000001111')
    await fill(otherPage, 'TR/ST/2026-660022', '660000002222')

    await page.getByRole('button', { name: 'Complete the review' }).click()
    await expectStatus(page, 'Partner bank evaluation')

    /*
     * The loser is told the record changed — not that somebody else holds it,
     * because nobody does. Nothing was overwritten, which is the property the
     * claim was mistakenly credited with providing.
     */
    await otherPage.getByRole('button', { name: 'Complete the review' }).click()
    await expect(otherPage.getByText(/The record changed/u)).toBeVisible()

    // And the screen recovers rather than stranding: reloading shows the state
    // the winner left behind.
    await otherPage.reload()
    await expectStatus(otherPage, 'Partner bank evaluation')
    await other.close()
  })
})

test.describe('a reviewer reading casework', () => {
  test('opens a submitted document without holding anything', async ({ page }) => {
    test.setTimeout(180_000)
    const { id } = await submitApplication(page, { prefix: 'revread' })

    const reviewer = uniqueEmail('reviewerread')
    await page.context().clearCookies()
    // The account has to exist before the invitation can find it: this screen
    // looks a person up by address and invites the account, it does not create
    // one.
    await signUpApplicant(page, reviewer)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/invite')
    await page.getByLabel('Their email address').fill(reviewer)
    await page.getByRole('button', { name: 'Look them up' }).click()
    await page.getByLabel('Invite them to be').selectOption('REVIEWER')
    await page.getByLabel('Why').fill('Reading casework')
    await page.getByRole('button', { name: 'Send the invitation' }).click()
    const link = await latestInviteLink(reviewer)
    await signOut(page)
    await signIn(page, reviewer, PASSWORD)
    await page.goto(link)
    await page.getByRole('button', { name: 'Accept the invitation' }).click()

    /*
     * The regression this whole change started from. A reviewer cannot claim,
     * and document reads used to be gated on holding the file — so the role
     * whose entire job is reading casework could not open the workspace's
     * evidence at all.
     */
    await page.goto(`/admin/applications/${id}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText(/Submitted/u).first()).toBeVisible()

    // And they still cannot act: reading is not a step towards writing.
    await expect(page.getByRole('button', { name: 'Start desk review' })).toHaveCount(0)
  })
})
