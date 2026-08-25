/**
 * The whole programme, end to end.
 *
 * One application is taken from signup to money in the bank, through every
 * screen a real applicant and a real programme officer would use: submission,
 * desk review, referral to a partner bank, the bank's outcome, a
 * committee agenda and decision, a sanction order, and a payment.
 *
 * This is the test that proves the parts fit together. The individual specs
 * cover each screen's own rules; this one covers the seam between them, which
 * is where a status version or a stale id would actually break.
 */
import { expect, test } from '@playwright/test'
import { PASSWORD, SUPER_ADMIN_EMAIL, signIn, submitApplication } from './support'

test('an application is carried from submission to payment', async ({ page }) => {
  test.setTimeout(180_000)

  const { email, id } = await submitApplication(page, { prefix: 'journey' })

  // The acknowledgement carries the reference number away with it.
  const reference = await page.locator('.tabular').first().innerText()
  expect(reference).toMatch(/\S/u)

  // --- The programme office picks it up -----------------------------------
  await page.context().clearCookies()
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

  await page.goto('/admin/queue?queue=NEW_SUBMISSIONS')
  await expect(page.getByRole('link', { name: reference })).toBeVisible()

  await page.goto(`/admin/applications/${id}`)
  // Nobody has worked it yet, and it is workable anyway.
  await expect(
    page.getByRole('heading', { name: 'Nobody has worked this yet' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Start desk review' }).click()
  await expect(page.getByRole('heading', { name: /desk review/iu })).toBeVisible()

  // --- Desk review --------------------------------------------------------
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
  // Not applicable: this is an initial application, and the API refuses a pass
  // or a fail on the expansion check for one.
  await page.locator('input[name="EXPANSION_EVIDENCE"]').last().check()

  /*
   * Passing a check means having read the document, so the numbers on them are
   * now part of the review. The fields appear as the checks they evidence are
   * passed, which is why this sits after the checks and not before.
   */
  await page.getByLabel('Scheduled Tribe certificate number').fill('TR/ST/2026-000117')
  await page.getByLabel('Identity document number').fill('411700002222')
  await page.getByLabel('Bank account number').fill('50010000411')
  await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')

  await page.getByRole('radio', { name: /Refer to a partner bank/u }).check()
  await page.getByRole('button', { name: 'Complete the review' }).click()

  /*
   * The badge, not the guide's desk label. `getByText('Partner bank')` matches
   * the route diagram on every workspace screen, so it passed whether or not
   * the review had actually been accepted.
   */
  await expect(
    page.locator('.badge').filter({ hasText: 'Partner bank evaluation' }).first(),
  ).toBeVisible()

  // --- The bank -----------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10)
  await page.getByLabel('Bank', { exact: true }).fill('Tripura Gramin Bank')
  await page.getByLabel('Branch').fill('Khumulwng')
  await page.getByLabel('Referral reference').fill('TGB/SEP/2026/01')
  await page.getByLabel('Dated', { exact: true }).fill(today)
  await page
    .getByLabel('Message to the applicant')
    .fill('Your application has gone to Tripura Gramin Bank for evaluation.')
  await page.getByRole('button', { name: 'Refer to the bank' }).click()
  await expect(page.getByText('Awaiting the bank').first()).toBeVisible()

  await page.getByRole('radio', { name: /^Recommended/u }).check()
  await page.getByLabel("The bank's decision reference").fill('TGB/DEC/2026/44')
  await page.getByLabel('Dated', { exact: true }).fill(today)
  await page.getByLabel('Loan the bank will provide (₹)').fill('600000')
  await page
    .getByLabel('What the applicant is told')
    .fill('The bank has recommended your proposal.')
  await page.getByRole('button', { name: 'Record the outcome' }).click()
  await expect(page.getByText('Answered').first()).toBeVisible()

  // --- The committee ------------------------------------------------------
  await page.goto('/admin/meetings')
  await page.getByRole('button', { name: 'Schedule a meeting' }).click()
  const meetingReference = `TTM-J${Date.now().toString(36).toUpperCase()}`
  await page.getByLabel('Meeting reference').fill(meetingReference)
  await page
    .getByLabel('When')
    .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16))
  await page.getByLabel('Where').fill('TTAADC headquarters')
  await page.getByRole('button', { name: 'Schedule it' }).click()
  await expect(page).toHaveURL(/\/admin\/meetings\/[0-9a-f-]{36}$/u)
  const meetingUrl = page.url()

  await page.goto(`/admin/applications/${id}`)
  const meetingLabel = await page
    .getByLabel('Meeting')
    .locator('option')
    .filter({ hasText: meetingReference })
    .innerText()
  await page.getByLabel('Meeting').selectOption({ label: meetingLabel })
  await page.getByRole('button', { name: 'Add it to the agenda' }).click()
  await expect(page.getByText('On an agenda')).toBeVisible()

  /*
   * The committee sits. Only a meeting still being planned can take a new item,
   * and only a meeting in session can produce a decision — so the order here is
   * the order the office works in, not an arrangement of convenience.
   */
  await page.goto(meetingUrl)
  await page.getByRole('button', { name: 'Start the meeting' }).click()
  await expect(page.getByText('In session')).toBeVisible()

  await page.goto(`/admin/applications/${id}`)
  await page.getByRole('radio', { name: /^Approved/u }).check()
  await page.getByLabel('Decision reference').fill('TTM/2026/07/12')
  await page.getByLabel('Dated', { exact: true }).fill(today)
  await page.getByLabel('Amount approved (₹)').fill('250000')
  await page
    .getByLabel('What the applicant is told')
    .fill('The committee has approved your application.')
  await page.getByRole('button', { name: 'Record the decision' }).click()

  // --- The money ----------------------------------------------------------
  await page.goto(`/admin/applications/${id}/funding`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Sanction order number').fill('TTAADC/SEP/SO/2026/019')
  await page.getByLabel('Issued on').fill(new Date().toISOString().slice(0, 10))
  await page.getByRole('button', { name: 'Issue the sanction order' }).click()
  await expect(
    page.getByRole('heading', { name: 'TTAADC/SEP/SO/2026/019' }),
  ).toBeVisible()

  const now = new Date().toISOString().slice(0, 16)
  await page.getByLabel('Amount (₹)', { exact: true }).fill('125000')
  await page.getByLabel('Paid on').fill(now)
  await page.getByLabel('Payment reference').fill('NEFT/2026/000771')
  await page.getByLabel('Committee approval reference').fill('TTM/2026/07/12')
  await page.getByLabel('Approved on').fill(today)
  await page.getByLabel('Bank account verified').fill(now)
  await page.getByLabel('Performance agreement').fill('PA/2026/019')
  await page.getByLabel('Executed on').fill(now)
  await page.locator('#release-message').fill('The first instalment has been released.')
  await page.getByRole('button', { name: 'Record the payment' }).click()

  await expect(
    page.getByRole('row').filter({ hasText: 'NEFT/2026/000771' }),
  ).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '₹1,25,000' })).toBeVisible()

  // --- And the applicant sees their own money -----------------------------
  await page.context().clearCookies()
  await signIn(page, email)
  await page.goto(`/applications/${id}/funding`)

  // The figures are the server's arithmetic, shown in the applicant's terms.
  await expect(page.getByText('TTAADC/SEP/SO/2026/019')).toBeVisible()
  await expect(page.getByText('₹2,50,000')).toBeVisible()
  await expect(page.getByText('₹1,25,000').first()).toBeVisible()
  await expect(
    page.getByRole('row').filter({ hasText: 'NEFT/2026/000771' }),
  ).toBeVisible()

  // What the office keeps to itself stays there: the applicant's view of an
  // award carries no internal note, no bank prerequisite and no reviewer
  // reference.
  await expect(page.getByText('PA/2026/019')).toHaveCount(0)
  await expect(page.getByText('TTM/2026/07/12')).toHaveCount(0)
})

/*
 * The committee sending an application back.
 *
 * The same defect the desk review had, at the other gate: `REVISION_REQUIRED`
 * fell through to an empty reason catalogue, so no select rendered, the
 * readiness guard passed precisely *because* the list was empty, and the API
 * refused a decision the form could not complete. Untested, so 138 passing
 * tests said nothing about it.
 */
test('the committee asks for a correction rather than deciding', async ({ page }) => {
  test.setTimeout(240_000)
  const application = await submitApplication(page, { prefix: 'ttmrev' })
  const id = application.id
  const today = new Date().toISOString().slice(0, 10)
  const unique = Date.now().toString().slice(-6)

  await page.context().clearCookies()
  await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

  // --- Through desk review and the bank, so the committee can sit ----------
  await page.goto(`/admin/applications/${id}`)
  await page.getByRole('button', { name: 'Start desk review' }).click()
  for (const check of [
    'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
    'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
    'DPR_FEASIBILITY',
  ]) {
    await page.locator(`input[name="${check}"]`).first().check()
  }
  await page.locator('input[name="EXPANSION_EVIDENCE"]').last().check()
  await page.getByLabel('Scheduled Tribe certificate number').fill(`TR/ST/2026-T${unique}`)
  await page.getByLabel('Identity document number').fill(`4117${unique}`)
  await page.getByLabel('Bank account number').fill(`5001${unique}`)
  await page.getByLabel('Branch code (IFSC)').fill('SBIN0007890')
  await page.getByRole('radio', { name: /Refer to a partner bank/u }).check()
  await page.getByRole('button', { name: 'Complete the review' }).click()
  await expect(
    page.locator('.badge').filter({ hasText: 'Partner bank evaluation' }).first(),
  ).toBeVisible()

  await page.getByLabel('Bank', { exact: true }).fill('Tripura Gramin Bank')
  await page.getByLabel('Branch').fill('Khumulwng')
  await page.getByLabel('Referral reference').fill(`TGB/SEP/R${unique}`)
  await page.getByLabel('Dated', { exact: true }).fill(today)
  await page
    .getByLabel('Message to the applicant')
    .fill('Your application has gone to the bank for evaluation.')
  await page.getByRole('button', { name: 'Refer to the bank' }).click()
  await expect(page.getByText('Awaiting the bank').first()).toBeVisible()

  await page.getByRole('radio', { name: /^Recommended/u }).check()
  await page.getByLabel("The bank's decision reference").fill(`TGB/DEC/R${unique}`)
  await page.getByLabel('Dated', { exact: true }).fill(today)
  await page.getByLabel('Loan the bank will provide (₹)').fill('600000')
  await page
    .getByLabel('What the applicant is told')
    .fill('The bank has recommended your proposal.')
  await page.getByRole('button', { name: 'Record the outcome' }).click()
  await expect(page.getByText('Answered').first()).toBeVisible()

  // --- A meeting, in session -----------------------------------------------
  await page.goto('/admin/meetings')
  await page.getByRole('button', { name: 'Schedule a meeting' }).click()
  const meetingReference = `TTM-R${Date.now().toString(36).toUpperCase()}`
  await page.getByLabel('Meeting reference').fill(meetingReference)
  await page
    .getByLabel('When')
    .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16))
  await page.getByLabel('Where').fill('TTAADC headquarters')
  await page.getByRole('button', { name: 'Schedule it' }).click()
  await expect(page).toHaveURL(/\/admin\/meetings\/[0-9a-f-]{36}$/u)
  const meetingUrl = page.url()

  await page.goto(`/admin/applications/${id}`)
  const meetingLabel = await page
    .getByLabel('Meeting')
    .locator('option')
    .filter({ hasText: meetingReference })
    .innerText()
  await page.getByLabel('Meeting').selectOption({ label: meetingLabel })
  await page.getByRole('button', { name: 'Add it to the agenda' }).click()
  await expect(page.getByText('On an agenda')).toBeVisible()

  await page.goto(meetingUrl)
  await page.getByRole('button', { name: 'Start the meeting' }).click()
  await expect(page.getByText('In session')).toBeVisible()

  // --- And the decision that sends it back ---------------------------------
  await page.goto(`/admin/applications/${id}`)
  await page.getByRole('radio', { name: /Correction needed/u }).check()

  // The control that did not exist: a revision needs an outcome reason, and
  // the API refuses without one.
  const reason = page.getByLabel('Reason', { exact: true }).first()
  await expect(reason).toBeVisible()
  await reason.selectOption({ index: 1 })

  await page.getByLabel('Decision reference').fill(`TTM/REV/${unique}`)
  await page.getByLabel('Dated', { exact: true }).fill(today)
  await page
    .getByLabel('What the applicant is told')
    .fill('The committee has asked for a correction before deciding.')

  await page.getByRole('checkbox', { name: 'Evidence' }).check()
  await page.getByLabel('Reason', { exact: true }).last().selectOption({ index: 1 })
  await page.getByLabel('What the applicant must do').last().fill('Provide the revised quotation.')

  await page.getByRole('button', { name: 'Record the decision' }).click()
  await expect(
    page.locator('.badge').filter({ hasText: 'Revision required' }).first(),
  ).toBeVisible()
})
