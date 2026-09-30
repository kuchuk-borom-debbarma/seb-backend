import { expect, test } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  setClosingTime,
  signIn,
  startApplication,
} from './support'

/** The cycle this file opened, so its applications start in that one. */
let cycleCode = ''

test.describe('the application form', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    cycleCode = await openProgrammeCycle(page, { prefix: 'SEP-D' })
    await page.context().clearCookies()
  })

  test('saves answers when Save is pressed, and says so', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form`)

    await page.getByRole('button', { name: 'Add owner', exact: true }).click()
    await page.getByLabel('Full name').fill('Bethel Debbarma')
    // Nothing is saved on a timer: the answer waits, said to be unsaved, until
    // the applicant saves it — and the indicator is the server's word, not
    // the click's.
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByLabel('Full name')).toHaveValue('Bethel Debbarma')
  })

  /**
   * An abandoned draft can be put away, and taken back out.
   *
   * The same soft delete an enterprise and a document already had. Until this
   * existed the applications list carried an "Include removed drafts" filter
   * for a category of row nothing could create — and an applicant who started
   * an application by mistake had to ask the office.
   */
  test('removes a draft nobody wants and restores it again', async ({ page }) => {
    // Signing up, registering an enterprise and starting an application is
    // three journeys before the assertion begins, and whichever test a worker
    // runs first also pays for the cold client. The same allowance
    // `identifiers.spec` makes for the same reason.
    test.setTimeout(120_000)
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'binned',
      businessName: 'Binned Works',
    })

    await page.goto(`/applications/${id}`)
    await page.getByRole('button', { name: 'Remove this draft' }).click()
    // Removal lands on the list, where the draft is gone by default.
    await expect(page).toHaveURL(/\/applications$/u)
    /*
     * Addressed by its own link rather than by the enterprise's name: the name
     * is also an option in the list's enterprise filter, which is drawn from
     * every enterprise the applicant has and would match whether the row was
     * there or not.
     */
    const row = page.locator(`a[href*="/applications/${id}"]`)
    await expect(row).toHaveCount(0)

    // It is not destroyed: the filter that always existed now has something to
    // show, and the row leads back to a draft that can be restored.
    // `click`, not `check`: the box is driven by the address, so React resets
    // it until the navigation lands and `check` retries against its own click.
    // `enterprises.spec` does the same with the same control.
    await page.getByLabel('Include removed drafts').click()
    await expect(row.first()).toBeVisible()

    await page.goto(`/applications/${id}`)
    await page.getByRole('button', { name: 'Restore this draft' }).click()
    await expect(page.getByRole('button', { name: 'Remove this draft' })).toBeVisible()
  })

  test('shows every section of the form', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form`)

    // One stage renders at a time now; the journey rail names them all.
    const rail = page.getByRole('navigation', { name: 'Form categories' })
    for (const title of [
      'Owners',
      'Funding requested',
      'Previous support',
      'Documents',
    ]) {
      await expect(rail.getByText(title, { exact: true })).toBeVisible()
    }
  })

  test('reveals conditional questions only when they apply', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    // The field hash is the issue-link form — the one address allowed to
    // open a stage whose predecessors are incomplete.
    await page.goto(
      `/applications/${id}/form?stage=PRIOR_FUNDING#RECEIVED_GOVERNMENT_FUNDING`,
    )

    // The API refuses details for support that was not received, so the fields
    // are not offered until the answer calls for them.
    await expect(page.getByLabel('Scheme')).toBeHidden()
    const government = page.getByRole('group', {
      name: 'Has this enterprise received government funding before?',
    })
    await government.getByLabel('Yes').check()
    await expect(page.getByLabel('Scheme')).toBeVisible()

    // "No" is a complete answer, not the absence of one, and it puts the
    // details away again.
    await government.getByLabel('No').check()
    await expect(page.getByLabel('Scheme')).toBeHidden()

    // The same on the funding stage: the banks and the amount are asked only
    // of somebody who wants a loan.
    await page.goto(`/applications/${id}/form?stage=FINANCIAL#WANTS_BANK_LOAN`)
    await expect(page.getByLabel(/^First choice of bank/u)).toBeHidden()
    await page.getByRole('group', { name: 'Do you want a bank loan?' }).getByLabel('Yes').check()
    await expect(page.getByLabel(/^First choice of bank/u)).toBeVisible()
    await expect(page.getByLabel(/^Loan amount requested/u)).toBeVisible()
  })

  /*
   * The rules about several answers at once. The browser checks them as the
   * applicant answers, so the message is on the screen before anything is
   * sent; the server checks them again on submission, which is why the review
   * screen refuses too.
   */
  test('says so at once when the funding answers contradict each other', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form?stage=FINANCIAL#WANTS_GRANT`)

    // Neither a grant nor a loan.
    await page.getByRole('group', { name: 'Do you want a grant?' }).getByLabel('No').check()
    await page.getByRole('group', { name: 'Do you want a bank loan?' }).getByLabel('No').check()
    await expect(page.getByText('Ask for a grant, a bank loan, or both.')).toBeVisible()

    // A loan from the same bank twice.
    await page.getByRole('group', { name: 'Do you want a bank loan?' }).getByLabel('Yes').check()
    await expect(page.getByText('Ask for a grant, a bank loan, or both.')).toBeHidden()
    await page.getByLabel(/^First choice of bank/u).selectOption('SBI')
    await page.getByLabel(/^Second choice of bank/u).selectOption('SBI')
    await expect(page.getByText('Choose two different banks.')).toBeVisible()

    // The server holds the same rule: the review screen will not submit it.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })
    await page.goto(`/applications/${id}/review`)
    await expect(page.getByText('Choose two different banks.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Submit application' })).toBeDisabled()
  })

  test('will not submit an incomplete application, and lists what is missing', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/review`)

    await expect(page.getByText('Not ready yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Submit application' })).toBeDisabled()

    // Every issue names its section, its question, and what to do — the API's
    // own message rather than a generic complaint.
    const rows = page.getByRole('row')
    expect(await rows.count()).toBeGreaterThan(1)
  })

  test('money is entered in rupees and survives a reload', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/form?stage=FINANCIAL#WANTS_GRANT`)

    await page.getByRole('group', { name: 'Do you want a grant?' }).getByLabel('Yes').check()
    await page.getByLabel(/^Desired grant amount/u).fill('500000')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })

    await page.reload()
    // Stored as paise, shown as rupees: 500000 rupees must not come back as
    // 50000000 or 5000. The box groups the digits the Indian way.
    await expect(page.getByLabel(/^Desired grant amount/u)).toHaveValue('₹5,00,000')
  })
})

test.describe('the closing date', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    cycleCode = await openProgrammeCycle(page, { prefix: 'SEP-D' })
    // The wizard no longer takes a deadline; this notice is about a cycle
    // that carries one, so the spec sets it through the API.
    const cycleId = page.url().match(/\/admin\/cycles\/([0-9a-f-]{36})/u)![1]!
    await setClosingTime(page, cycleId, new Date(Date.now() + 30 * 86_400_000))
    await page.context().clearCookies()
  })

  test('is repeated where the work happens, with the time left', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })

    // On the form, because a date seen on the cycles screen three weeks ago is
    // no help to somebody halfway through the questions.
    await page.goto(`/applications/${id}/form`)
    await expect(page.getByText('When applications close')).toBeVisible()
    await expect(page.getByText(/closes in \d+ (day|month)/u)).toBeVisible()

    // And on the screen where somebody decides whether to send it now.
    await page.goto(`/applications/${id}/review`)
    await expect(page.getByText('When applications close')).toBeVisible()
  })
})

test.describe('the validation report', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    cycleCode = await openProgrammeCycle(page, { prefix: 'SEP-V' })
    await page.context().clearCookies()
  })

  test('takes the applicant to the field, not just the page', async ({ page }) => {
    const id = await startApplication(page, {
      cycleCode,
      prefix: 'draft',
      businessName: 'Draft Works',
    })
    await page.goto(`/applications/${id}/review`)

    // The group itself is the addressable control when no entries exist.
    const row = page.getByRole('row').filter({ hasText: 'Owners' }).first()
    await row.getByRole('link').click()

    await expect(page).toHaveURL(
      // The template's own key, which is now the question's name everywhere.
      new RegExp(`/applications/${id}/form(\\?stage=OWNERS)?#OWNERS$`, 'u'),
    )
  })
})
