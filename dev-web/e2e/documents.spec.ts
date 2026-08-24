/**
 * The evidence screen.
 *
 * These run the upload for real. There is no bucket here and no credentials,
 * but the storage seam sends the bytes to the Worker instead, which writes them
 * and checks them exactly as the bucket would — so the whole path is exercised:
 * the browser's own refusals, the cross-origin PUT, and the document coming
 * back attached.
 *
 * The upload is genuinely cross-origin, because it is deployed too — the page
 * is served from the client's origin and the bytes go to the bucket's. Locally
 * the Worker answers the preflight in the bucket's place.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  startApplication,
} from './support'

/** Puts a file on the page's hidden picker the way a person's chooser would. */
const choose = async (
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) => {
  await page.locator('input[type="file"]').first().setInputFiles(file)
}

test.describe('evidence', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openProgrammeCycle(page, { prefix: 'SEP-E' })
    await page.context().clearCookies()
  })

  test('lists every document the application can carry', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/documents`)

    for (const title of [
      'Identity and age proof',
      'Scheduled Tribe certificate',
      'Address proof',
      'Business registration',
      'GST registration',
      'Detailed project report',
      'Bank account details',
      'No-objection certificate',
    ]) {
      await expect(page.getByRole('heading', { name: title })).toBeVisible()
    }
  })

  test('separates what is required from what is optional', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/documents`)

    // The requirement is the API's own message, so the screen never states a
    // rule the server does not hold.
    await expect(page.getByText('Upload the detailed project report.')).toBeVisible()

    // The cycle's rules did not ask for these, and the screen says so rather
    // than leaving them looking overdue.
    await expect(
      page.getByText('Not attached. This one is optional.').first(),
    ).toBeVisible()
  })

  test('refuses a file of the wrong type before sending it anywhere', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/documents`)

    await choose(page, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a document'),
    })
    await expect(page.getByText('Choose a PDF, JPEG or PNG file.')).toBeVisible()
  })

  test('refuses an empty file', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/documents`)

    await choose(page, {
      name: 'blank.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(0),
    })
    await expect(page.getByText('This file is empty. Choose another one.')).toBeVisible()
  })

  test('refuses a file over the limit, and one whose name lies', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/documents`)

    // Refused in the browser, so a six-megabyte file is never uploaded only to
    // be rejected after the wait.
    await choose(page, {
      name: 'big.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(6 * 1024 * 1024, 0x20),
    })
    await expect(page.getByText('The largest a document can be is 5 MB.')).toBeVisible()

    /*
     * The name is the one thing about an upload that is stored and served back
     * later. This passes the type check and would pass the signature check too
     * — the bytes really are a PDF. The name is what lies.
     */
    await choose(page, {
      name: 'report.pdf.exe',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 a small but real-looking file'),
    })
    await expect(
      page.getByText(
        'The file name must end in .pdf, .jpg, .jpeg or .png, matching the file.',
      ),
    ).toBeVisible()
  })

  test('a file the browser accepts is stored, and comes back attached', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/documents`)

    /*
     * Scoped to one card rather than `choose`, which takes the first picker on
     * the page. Which card receives the file only started mattering once the
     * upload could actually succeed.
     */
    const card = page
      .locator('.card')
      .filter({ has: page.getByRole('heading', { name: 'Detailed project report' }) })
    await expect(card.getByText('Upload the detailed project report.')).toBeVisible()

    await card.locator('input[type="file"]').setInputFiles({
      name: 'dpr.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 a small but real-looking file'),
    })

    /*
     * The whole round trip: the API issued an authorization, the browser PUT
     * the bytes to it cross-origin, and finalization turned the intent into a
     * document version. If the preflight were missing the PUT would never be
     * sent, and this is what would notice.
     */
    await expect(card.getByText('dpr.pdf')).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText('Upload the detailed project report.')).toBeHidden()
  })

  test('each issue in the report links to the screen that fixes it', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/review`)

    // The row for a missing document leads to the evidence screen, not the
    // form, because that is where the file is attached.
    const documentIssue = page
      .getByRole('row')
      .filter({ hasText: 'Upload the detailed project report.' })
      .getByRole('link')
    await documentIssue.click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/documents$`, 'u'))

    // An answer on the form leads to the form.
    await page.goto(`/applications/${id}/review`)
    const formIssue = page
      .getByRole('row')
      .filter({ hasText: 'About you' })
      .first()
      .getByRole('link')
    await formIssue.click()
    // With the field named in the address — the form is forty questions long,
    // and the section alone is not where the answer goes.
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/form#\\w+$`, 'u'))
  })

  test('sends the no-objection question to the form, not to the evidence screen', async ({
    page,
  }) => {
    /*
     * The evidence section carries two different kinds of issue. "Upload the
     * detailed project report" is a file and belongs on the evidence screen.
     * "Is a no-objection certificate needed for these premises?" is a form
     * question that happens to be filed under the same section — and routing
     * by section sent it to a screen with no such control, so the applicant
     * was told to fix something where it does not exist.
     */
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/applications/${id}/review`)

    const row = page.getByRole('row').filter({ hasText: 'no-objection certificate' })
    // Asked as the form asks it, rather than as the field is spelled. The old
    // label was "Noc required", which is not a question anybody was asked.
    await expect(row).toContainText(
      'Is a no-objection certificate needed for these premises?',
    )

    await row.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/form#nocRequired$`, 'u'))
    // And the control is genuinely there.
    await expect(page.locator('#nocRequired')).toBeVisible()
  })

  test('is reachable from the application and from the form', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })

    await page.goto(`/applications/${id}`)
    await page.getByRole('link', { name: 'Evidence' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/documents$`, 'u'))

    await page.goto(`/applications/${id}/form`)
    await page.getByRole('link', { name: 'Attach evidence' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/documents$`, 'u'))
  })
})
