/**
 * The identifier gate, driven from the cycle that configures it.
 *
 * Which numbers a desk review demands, and which it compares against other
 * applications, is a per-cycle setting rather than something the code decides.
 * These tests configure a cycle through its own form and then assert the review
 * screen obeys what was configured — the loop that a unit test cannot close,
 * because the hardcoded copy the form used to carry passed every unit test in
 * the suite while ignoring the rules entirely.
 *
 * The rules freeze with the submission, so the only way to reach a review that
 * demands something unusual is to configure the cycle before applying into it.
 */
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, SUPER_ADMIN_EMAIL, signIn, submitApplication } from './support'

/** The rule editor's rows, in the order the form seeds them. */
const IDENTIFIER_ROW = {
  stCertificate: 1,
  identityDocument: 2,
  bankAccount: 3,
  businessRegistration: 4,
}

/** Sets one rule's requirement on the cycle form. */
const setRequirement = async (page: Page, row: number, value: string) => {
  await page.locator(`select[aria-label="Demanded, for identifier ${row}"]`)
    .selectOption(value)
}

/** Sets whether one rule is compared against other applications. */
const setCompared = async (page: Page, row: number, compared: boolean) => {
  const box = page.locator(
    `input[aria-label="Compare for duplicates, for identifier ${row}"]`,
  )
  if (compared) await box.check()
  else await box.uncheck()
}

/**
 * Asserts the workspace's status badge, which is the only place the
 * application's actual state is rendered.
 *
 * Deliberately not `getByText('Partner bank')`. The guide's route diagram
 * draws a "Partner bank" desk label on every workspace screen regardless of
 * status, so matching that text asserts nothing about whether the review
 * completed — it passes even when the API refused.
 */
const expectStatus = async (page: Page, status: string) => {
  await expect(page.locator('.badge').filter({ hasText: status }).first()).toBeVisible()
}

/** Opens a submitted application's desk review and passes every check. */
const openReview = async (page: Page, id: string) => {
  await page.goto(`/admin/applications/${id}`)
  await page.getByRole('button', { name: 'Start desk review' }).click()
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

test.describe('what one cycle asks for', () => {
  test('offers no field for an identifier the cycle switched off', async ({ page }) => {
    test.setTimeout(120_000)
    const { id } = await submitApplication(page, {
      prefix: 'offkind',
      configureIdentifiers: async (form) => {
        await setRequirement(form, IDENTIFIER_ROW.stCertificate, 'OFF')
      },
    })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openReview(page, id)

    /*
     * OFF is not "optional and hidden". The programme decided it does not
     * collect this number, so there is nothing to type even with its check
     * passed — and the API refuses a value for it, so a field here would be a
     * field that cannot be submitted.
     */
    await expect(page.getByLabel('Scheduled Tribe certificate number')).toHaveCount(0)

    // The others are untouched, which is what makes this a per-identifier
    // setting rather than a switch on the whole feature.
    await expect(page.getByLabel('Identity document number')).toBeVisible()
    await expect(page.getByLabel('Bank account number')).toBeVisible()
  })

  test('will not complete until a demanded number is typed', async ({ page }) => {
    test.setTimeout(120_000)
    const { id } = await submitApplication(page, { prefix: 'demand' })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openReview(page, id)

    await page.getByRole('radio', { name: /Refer to a partner bank/u }).check()

    /*
     * The button is disabled rather than the form refusing on submit. The API
     * refuses too — that is the guard — but a screen that lets somebody fill in
     * a whole review and press a button only to be told a field above is empty
     * has wasted their time to tell them something it already knew.
     */
    const complete = page.getByRole('button', { name: 'Complete the review' })
    await expect(complete).toBeDisabled()

    await page.getByLabel('Scheduled Tribe certificate number').fill('TR/ST/2026-770001')
    await expect(complete).toBeDisabled()
    await page.getByLabel('Identity document number').fill('770000001111')
    await expect(complete).toBeDisabled()
    await page.getByLabel('Bank account number').fill('50010000770')

    // The account is not complete without its branch: the same digits at two
    // banks are two accounts, so one field alone identifies nothing.
    await expect(complete).toBeDisabled()
    await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')
    await expect(complete).toBeEnabled()
  })

  test('records a repeat without a word when the cycle does not compare it', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const shared = `TR/ST/2026-${Date.now().toString().slice(-6)}`

    /*
     * Collected, demanded, and deliberately not compared. A programme may want
     * the number on file without a repeat stopping anybody — the two settings
     * are independent, and this is the pairing that proves it.
     */
    const notCompared = async (form: Page) => {
      await setCompared(form, IDENTIFIER_ROW.stCertificate, false)
    }

    const first = await submitApplication(page, {
      prefix: 'nocmpa',
      configureIdentifiers: notCompared,
    })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openReview(page, first.id)
    await page.getByLabel('Scheduled Tribe certificate number').fill(shared)
    await page.getByLabel('Identity document number').fill('771100001111')
    await page.getByLabel('Bank account number').fill('50010000771')
    await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')
    await page.getByRole('radio', { name: /Refer to a partner bank/u }).check()
    await page.getByRole('button', { name: 'Complete the review' }).click()
    await expectStatus(page, 'Partner bank evaluation')

    // The same certificate on a second file, in a cycle configured the same
    // way. It goes through, and nothing is said about it.
    await page.context().clearCookies()
    const second = await submitApplication(page, {
      prefix: 'nocmpb',
      businessName: 'Uncompared Works',
      configureIdentifiers: notCompared,
    })
    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openReview(page, second.id)
    await page.getByLabel('Scheduled Tribe certificate number').fill(shared)
    await page.getByLabel('Identity document number').fill('772200002222')
    await page.getByLabel('Bank account number').fill('50010000772')
    await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')
    await page.getByRole('radio', { name: /Refer to a partner bank/u }).check()
    await page.getByRole('button', { name: 'Complete the review' }).click()

    await expectStatus(page, 'Partner bank evaluation')
    await expect(page.getByText(/already recorded against/u)).toHaveCount(0)
  })

  test('shows an empty rule set back as the setting it is', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/cycles/new')

    // Remove every rule. A cycle that collects nothing is legitimate, and it is
    // indistinguishable from one somebody forgot to configure — so it says so
    // rather than rendering an empty space.
    for (let index = 0; index < 4; index += 1) {
      await page
        .getByRole('button', { name: 'Remove' })
        .last()
        .click()
    }
    await expect(page.getByText('This cycle asks for no numbers')).toBeVisible()
  })

  test('is reachable and labelled for somebody working by keyboard', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/cycles/new')

    // Every control in the rule editor is named. An unlabelled select in a row
    // of four identical-looking selects is unusable without sight of the
    // layout, and the rows are otherwise indistinguishable.
    for (const row of Object.values(IDENTIFIER_ROW)) {
      await expect(
        page.locator(`select[aria-label="Identifier ${row}"]`),
      ).toBeVisible()
      await expect(
        page.locator(`select[aria-label="Demanded, for identifier ${row}"]`),
      ).toBeVisible()
      await expect(
        page.locator(`input[aria-label="Compare for duplicates, for identifier ${row}"]`),
      ).toBeVisible()
    }

    /*
     * The check a rule stands behind is only meaningful for the one requirement
     * that has a moment at which it applies. The database enforces exactly
     * that, so an enabled control here would offer a combination the API
     * refuses.
     */
    await setRequirement(page, IDENTIFIER_ROW.stCertificate, 'OPTIONAL')
    await expect(
      page.locator(
        `select[aria-label="Evidence for which check, for identifier ${IDENTIFIER_ROW.stCertificate}"]`,
      ),
    ).toBeDisabled()

    await setRequirement(page, IDENTIFIER_ROW.stCertificate, 'REQUIRED_ON_PASS')
    await expect(
      page.locator(
        `select[aria-label="Evidence for which check, for identifier ${IDENTIFIER_ROW.stCertificate}"]`,
      ),
    ).toBeEnabled()
  })
})
