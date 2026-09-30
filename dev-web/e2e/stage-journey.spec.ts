/**
 * One file worked through the Mission SEP pipeline on screen, by the people
 * who work each stage — forward, and back.
 *
 * The route is the seeded one (`seedPipeline`): TTC → Industries & Commerce →
 * the bank the applicant chose first, each stage owned by the stage role of
 * the same name. Every officer here is invited into exactly one of those roles,
 * so what each can see and do is decided by the stage their role owns, as it
 * would be for a real bank officer.
 *
 * What each step proves is the thing that would be wrong silently: that a
 * resubmission returns the file to the stage that asked rather than the start,
 * that a send-back walks the file's own trail, that an amount over what was
 * asked is refused, that the bank is pre-filled from the applicant's first
 * choice, and that one bank never sees the other's files.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  inviteSomebodyTo,
  signIn,
  submittedThroughApi,
} from './support'

/** Signs somebody else in on the same page. */
const as = async (page: Page, email: string) => {
  await page.context().clearCookies()
  await signIn(page, email, PASSWORD)
}

/** A stage officer: invited into one stage role, then signed out again. */
const officer = async (page: Page, role: string): Promise<string> => {
  await page.context().clearCookies()
  const email = await inviteSomebodyTo(page, role)
  await page.context().clearCookies()
  return email
}

/**
 * Opens the file and takes one of its offered actions through its dialog.
 * `fill` answers the action's inputs; the dialog's submit button carries the
 * action's own label, as the panel's button does.
 */
const take = async (
  page: Page,
  id: string,
  action: string,
  fill: (dialog: ReturnType<Page['getByRole']>) => Promise<void> = async () => {},
) => {
  await page.goto(`/admin/applications/${id}`)
  await page.getByRole('button', { name: action, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: action })
  await expect(dialog).toBeVisible()
  await fill(dialog)
  await dialog.getByRole('button', { name: action, exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: `${action}:` })).toBeVisible()
}

/** Where the stage panel says the file is now. */
const expectAt = async (page: Page, id: string, stage: string) => {
  await page.goto(`/admin/applications/${id}`)
  await expect(page.getByText(`At ${stage}`, { exact: true })).toBeVisible()
}

test.describe('working a file through its stages', () => {
  test('forward and back: a correction, a send-back, a re-route, then the loan', async ({
    page,
  }) => {
    test.setTimeout(300_000)
    const ttc = await officer(page, 'TTC')
    const ic = await officer(page, 'INDUSTRIES_COMMERCE')
    const sbi = await officer(page, 'SBI_BANK')
    const tgb = await officer(page, 'TGB_BANK')
    // A grant of ₹1,00,000 and a loan of ₹5,00,000, State Bank of India first.
    const applicant = await submittedThroughApi(page, { prefix: 'journey', businessName: 'Journey Works' })
    const id = applicant.id

    // Submitted: at TTC, in review — and the applicant is told so in the
    // pipeline's words.
    await as(page, applicant.email)
    await page.goto(`/applications/${id}`)
    await expect(page.getByText('Under first review').first()).toBeVisible()

    // TTC asks for a correction of the funding section. The file stays at TTC.
    await as(page, ttc)
    await take(page, id, 'Ask the applicant to correct it', async (dialog) => {
      await dialog.getByRole('checkbox', { name: 'Funding requested' }).check()
      await dialog
        .getByLabel('What to correct in Funding requested')
        .fill('Ask for what the project needs: ninety thousand rupees.')
    })
    await expect(page.getByText('With the applicant for corrections')).toBeVisible()

    // The applicant is told it is their turn, corrects and resubmits.
    await as(page, applicant.email)
    await page.goto(`/applications/${id}`)
    await expect(page.getByText('Changes requested').first()).toBeVisible()
    await expect(page.getByText('Ask for what the project needs: ninety thousand rupees.')).toBeVisible()
    await page.goto(`/applications/${id}/form?stage=FINANCIAL#SEED_FUND_REQUESTED_PAISE`)
    await page.getByLabel(/^Desired grant amount/u).fill('90000')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/^Saved /u)).toBeVisible({ timeout: 15_000 })
    await page.goto(`/applications/${id}/review`)
    await page.getByRole('button', { name: 'Resubmit application' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Send corrections' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/submitted$`, 'u'))

    // Back at TTC — the stage that asked, not the start of some other route.
    await as(page, ttc)
    await expectAt(page, id, 'TTC review')
    await take(page, id, 'Move to Industries & Commerce')

    // TTC acted on it, so TTC can still read it, but the actions are the
    // next stage's now: said once, with none of them offered.
    await expect(page.getByText('At Industries & Commerce', { exact: true })).toBeVisible()
    await expect(page.getByText('Industries & Commerce takes it from here.', { exact: false })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve the grant', exact: true })).toHaveCount(0)

    // Industries & Commerce approves the grant: pre-filled with what was asked,
    // and an amount over it is refused.
    await as(page, ic)
    await page.goto(`/admin/applications/${id}`)
    await page.getByRole('button', { name: 'Approve the grant', exact: true }).click()
    const approve = page.getByRole('dialog', { name: 'Approve the grant' })
    const amount = approve.getByLabel(/^Grant approved/u)
    await expect(amount).toHaveValue('₹90,000')
    await amount.fill('150000')
    await approve.getByRole('button', { name: 'Approve the grant', exact: true }).click()
    // Refused against the field itself, in the effect's own words.
    await expect(approve.locator('#AMOUNT-error')).toHaveText('This is more than the ₹90,000 the applicant asked for.')
    await amount.fill('80000')
    await approve.getByRole('button', { name: 'Approve the grant', exact: true }).click()
    await expect(approve).toHaveCount(0)
    await expect(page.getByText('Grant approved').first()).toBeVisible()
    // Approved once; the action is not offered twice.
    await expect(page.getByRole('button', { name: 'Approve the grant', exact: true })).toHaveCount(0)

    // Sent to the bank the applicant chose first.
    await take(page, id, 'Send to the bank', async (dialog) => {
      await expect(dialog.getByLabel(/^Bank/u)).toHaveValue('SBI')
    })
    await expect(page.getByText('At State Bank of India', { exact: true })).toBeVisible()

    // The State Bank of India sends it back — to Industries & Commerce, where it came from.
    await as(page, sbi)
    await take(page, id, 'Send back with a note', async (dialog) => {
      await dialog.getByLabel(/^Note for the previous stage/u).fill('We do not lend in that block.')
    })
    await expect(page.getByText('At Industries & Commerce', { exact: true })).toBeVisible()

    // Industries & Commerce re-routes it to the other bank.
    await as(page, ic)
    await take(page, id, 'Send to the bank', async (dialog) => {
      await dialog.getByLabel(/^Bank/u).selectOption('TGB')
    })
    await expect(page.getByText('At Tripura Gramin Bank', { exact: true })).toBeVisible()

    // The Tripura Gramin Bank fulfils the loan, which completes the file.
    await as(page, tgb)
    await take(page, id, 'Mark the loan fulfilled', async (dialog) => {
      await expect(dialog.getByLabel(/^Loan sanctioned/u)).toHaveValue('₹5,00,000')
      await dialog.getByLabel(/^Bank sanction reference/u).fill('TGB/2026/0042')
      await dialog.getByLabel(/^Date the bank sanctioned it/u).fill(new Date().toISOString().slice(0, 10))
    })
    await expect(page.getByText('Ended as Completed')).toBeVisible()

    // And the applicant sees it finished, with the grant that was approved.
    await as(page, applicant.email)
    await page.goto(`/applications/${id}`)
    await expect(page.getByText('Completed').first()).toBeVisible()
    await expect(page.getByText('₹80,000').first()).toBeVisible()
  })

  test('a file that asked for no loan completes at Industries & Commerce', async ({ page }) => {
    test.setTimeout(180_000)
    const ttc = await officer(page, 'TTC')
    const ic = await officer(page, 'INDUSTRIES_COMMERCE')
    const applicant = await submittedThroughApi(page, {
      prefix: 'noloan',
      businessName: 'Grant Only Works',
      answers: {
        WANTS_BANK_LOAN: false,
        LOAN_BANK_FIRST_CHOICE: null,
        LOAN_BANK_SECOND_CHOICE: null,
        LOAN_AMOUNT_REQUESTED_PAISE: null,
      },
    })
    const id = applicant.id

    await as(page, ttc)
    await take(page, id, 'Move to Industries & Commerce')

    await as(page, ic)
    await page.goto(`/admin/applications/${id}`)
    // Nobody asked for a loan, so there is no bank to send it to.
    await expect(page.getByRole('button', { name: 'Send to the bank', exact: true })).toHaveCount(0)
    await take(page, id, 'Complete (no loan asked for)')
    await expect(page.getByText('Ended as Completed')).toBeVisible()
  })

  test('a rejected file ends at TTC, and the applicant is told', async ({ page }) => {
    test.setTimeout(180_000)
    const ttc = await officer(page, 'TTC')
    const applicant = await submittedThroughApi(page, { prefix: 'reject', businessName: 'Rejected Works' })
    const id = applicant.id

    await as(page, ttc)
    await take(page, id, 'Reject', async (dialog) => {
      // The confirmation is said before the button is pressed.
      await expect(dialog.getByText('This closes the application. It cannot be undone.')).toBeVisible()
      await dialog.getByLabel(/^Why it is rejected/u).fill('The enterprise is outside the programme area.')
    })
    await expect(page.getByText('Ended as Rejected')).toBeVisible()

    await as(page, applicant.email)
    await page.goto(`/applications/${id}`)
    await expect(page.getByText('Not approved').first()).toBeVisible()
  })
})

test.describe('a stage is its owners’ alone', () => {
  test('one bank never sees the other bank’s files', async ({ page }) => {
    test.setTimeout(240_000)
    const ttc = await officer(page, 'TTC')
    const ic = await officer(page, 'INDUSTRIES_COMMERCE')
    const sbi = await officer(page, 'SBI_BANK')
    const tgb = await officer(page, 'TGB_BANK')
    const applicant = await submittedThroughApi(page, {
      prefix: 'scoped',
      businessName: 'Scoped Works',
      answers: { LOAN_BANK_FIRST_CHOICE: 'TGB', LOAN_BANK_SECOND_CHOICE: 'SBI' },
    })
    const id = applicant.id

    await as(page, ttc)
    await take(page, id, 'Move to Industries & Commerce')
    await as(page, ic)
    await take(page, id, 'Send to the bank', async (dialog) => {
      await expect(dialog.getByLabel(/^Bank/u)).toHaveValue('TGB')
    })

    // The Tripura Gramin Bank works it: its stage lists it.
    await as(page, tgb)
    await page.goto('/admin/stages')
    await expect(page.getByText('Tripura Gramin Bank').first()).toBeVisible()
    await expect(page.getByText('State Bank of India')).toHaveCount(0)

    // The State Bank of India cannot find it, nor open it by its address.
    await as(page, sbi)
    await page.goto('/admin/stages')
    await expect(page.getByText('Tripura Gramin Bank')).toHaveCount(0)
    await page.goto(`/admin/applications/${id}`)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mark the loan fulfilled', exact: true })).toHaveCount(0)

    // A super administrator works every stage, and can see where it is.
    await as(page, SUPER_ADMIN_EMAIL)
    await expectAt(page, id, 'Tripura Gramin Bank')
  })
})
