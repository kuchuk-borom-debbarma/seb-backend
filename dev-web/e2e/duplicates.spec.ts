/**
 * What a reviewer read, and what happens when two files say the same thing.
 *
 * A desk review used to record only pass or fail. That is an attestation with
 * nothing behind it — it cannot afterwards be asked *which* certificate was
 * seen, and so cannot be asked whether the same one has been seen before.
 *
 * These tests hold the whole loop: the numbers are asked for where the reviewer
 * still has the documents open, a repeat is caught, and the catch is a question
 * rather than a verdict, because the same promoter legitimately returns for a
 * later phase.
 */
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, SUPER_ADMIN_EMAIL, signIn, submitApplication } from './support'

/**
 * Asserts the status badge rather than any text on the page.
 *
 * `getByText('Partner bank')` looks like it proves a desk review completed and
 * does not: the guide's route diagram draws that desk label on every workspace
 * screen whatever the status, so the assertion passed even when the API had
 * refused the review.
 */
const expectStatus = async (page: Page, status: string) => {
  await expect(page.locator('.badge').filter({ hasText: status }).first()).toBeVisible()
}

/** Opens an application's desk review and passes every check. */
const openReview = async (page: Page, id: string) => {
  await page.goto(`/admin/applications/${id}`)
  await page.getByRole('button', { name: 'Start desk review' }).click()
  await page.getByRole('button', { name: 'Open desk review' }).click()

  for (const check of [
    'IDENTITY_KYC',
    'ST_ELIGIBILITY',
    'MAJORITY_OWNERSHIP',
    'JURISDICTION',
    'FORM_COMPLETENESS',
    'DOCUMENT_COMPLETENESS',
    'ANSWER_DOCUMENT_CONSISTENCY',
    'DPR_FEASIBILITY',
  ]) {
    await page.locator(`input[name="${check}"]`).first().check()
  }
  await page.locator('input[name="EXPANSION_EVIDENCE"]').last().check()
}

test.describe('what the documents say', () => {
  test('is asked for only once the check it evidences is passed', async ({ page }) => {
    const { id } = await submitApplication(page, { prefix: 'ask' })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

    await page.goto(`/admin/applications/${id}`)
    await page.getByRole('button', { name: 'Start desk review' }).click()
    await page.getByRole('button', { name: 'Open desk review' }).click()

    // Nothing passed yet, so nothing is being attested to.
    await expect(page.getByLabel('Scheduled Tribe certificate number')).toHaveCount(0)

    await page.locator('input[name="ST_ELIGIBILITY"]').first().check()
    await expect(page.getByLabel('Scheduled Tribe certificate number')).toBeVisible()

    // Failing it withdraws the question rather than greying the field out.
    await page.locator('input[name="ST_ELIGIBILITY"]').nth(1).check()
    await expect(page.getByLabel('Scheduled Tribe certificate number')).toHaveCount(0)
  })

  test('catches the same certificate on a second file, and asks rather than refuses', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const certificate = `TR/ST/2026-${Date.now().toString().slice(-6)}`

    // One application, reviewed and referred with a certificate recorded.
    const first = await submitApplication(page, { prefix: 'dupa' })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openReview(page, first.id)
    await page.getByLabel('Scheduled Tribe certificate number').fill(certificate)
    await page.getByLabel('Identity document number').fill('911100001111')
    await page.getByLabel('Bank account number').fill('50010000911')
    await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')
    await page.getByRole('radio', { name: /Refer to a partner bank/u }).check()
    await page.getByRole('button', { name: 'Complete the review' }).click()
    await expectStatus(page, 'Partner bank evaluation')

    // A second, unrelated application carrying the same certificate.
    await page.context().clearCookies()
    const second = await submitApplication(page, {
      prefix: 'dupb',
      businessName: 'Second Works',
    })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openReview(page, second.id)
    await page.getByLabel('Scheduled Tribe certificate number').fill(certificate)
    await page.getByLabel('Identity document number').fill('922200002222')
    await page.getByLabel('Bank account number').fill('50010000922')
    await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')
    await page.getByRole('radio', { name: /Refer to a partner bank/u }).check()
    await page.getByRole('button', { name: 'Complete the review' }).click()

    // Refused, and it says which number and which file — a reviewer cannot
    // judge a match without being able to go and look.
    await expect(page.getByText(/already recorded against/u)).toBeVisible()
    await expect(
      page.getByText(/Scheduled Tribe certificate number is already recorded/u),
    ).toBeVisible()

    /*
     * And the way through appears: a match is a question. Answering it is
     * allowed, and the answer is kept beside the number that raised it.
     */
    const reason = page.getByLabel('Why this is not the same claim')
    await expect(reason).toBeVisible()
    await reason.fill('Second-phase expansion by the same promoter.')
    await page.getByRole('button', { name: 'Complete the review' }).click()
    await expectStatus(page, 'Partner bank evaluation')
  })
})
