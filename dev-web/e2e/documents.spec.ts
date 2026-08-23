/**
 * The evidence screen.
 *
 * Uploading a file end to end needs a real R2 bucket: the Worker signs a URL
 * addressed to Cloudflare's storage endpoint, and the browser puts the bytes
 * there directly. Development has no credentials, so these tests cover
 * everything either side of that — what the screen offers, what it refuses
 * before spending a request, and that the attempt reaches the API and its
 * answer is shown rather than swallowed.
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
    await page.goto(`/app/applications/${id}/documents`)

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
    await page.goto(`/app/applications/${id}/documents`)

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
    await page.goto(`/app/applications/${id}/documents`)

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
    await page.goto(`/app/applications/${id}/documents`)

    await choose(page, {
      name: 'blank.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(0),
    })
    await expect(page.getByText('This file is empty. Choose another one.')).toBeVisible()
  })

  test('a file the browser accepts is sent, and the answer is shown', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/app/applications/${id}/documents`)

    await choose(page, {
      name: 'dpr.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 a small but real-looking file'),
    })

    /*
     * Development has no bucket credentials, so this attempt fails at the
     * signing step. What is being asserted is not the failure — it is that a
     * file which passes the browser's own checks is actually sent, and that
     * whatever the API answers reaches the person who chose it rather than the
     * console. The Worker deliberately masks a configuration error, so the
     * message here is the generic one; with a bucket configured this same path
     * attaches the document.
     */
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 15_000 })
    await expect(alert).not.toBeEmpty()

    // And nothing was recorded: a failed upload must not leave a document
    // behind that the applicant thinks is attached.
    await expect(
      page.getByText('Not attached. This one is optional.').first(),
    ).toBeVisible()
    await expect(page.getByText('Upload the detailed project report.')).toBeVisible()
  })

  test('each issue in the report links to the screen that fixes it', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })
    await page.goto(`/app/applications/${id}/review`)

    // The row for a missing document leads to the evidence screen, not the
    // form, because that is where the file is attached.
    const documentIssue = page
      .getByRole('row')
      .filter({ hasText: 'Upload the detailed project report.' })
      .getByRole('link')
    await documentIssue.click()
    await expect(page).toHaveURL(new RegExp(`/app/applications/${id}/documents$`, 'u'))

    // An answer on the form leads to the form.
    await page.goto(`/app/applications/${id}/review`)
    const formIssue = page
      .getByRole('row')
      .filter({ hasText: 'About you' })
      .first()
      .getByRole('link')
    await formIssue.click()
    await expect(page).toHaveURL(new RegExp(`/app/applications/${id}/form$`, 'u'))
  })

  test('is reachable from the application and from the form', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'evidence',
      businessName: 'Evidence Works',
    })

    await page.goto(`/app/applications/${id}`)
    await page.getByRole('link', { name: 'Evidence' }).click()
    await expect(page).toHaveURL(new RegExp(`/app/applications/${id}/documents$`, 'u'))

    await page.goto(`/app/applications/${id}/form`)
    await page.getByRole('link', { name: 'Attach evidence' }).click()
    await expect(page).toHaveURL(new RegExp(`/app/applications/${id}/documents$`, 'u'))
  })
})
