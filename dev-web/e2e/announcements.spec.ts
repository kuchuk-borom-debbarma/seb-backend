/**
 * The announcement banner, end to end: an announcer authors it, the public
 * landing page shows it, and an announcer never reaches casework.
 */
import { expect, test, type Page } from '@playwright/test'
import { inviteSomebodyTo, navigationSections } from './support'

/** Fills the editor's required fields and saves. The modal closes on success. */
const authorAnnouncement = async (
  page: Page,
  card: { tag: string; title: string; body: string; published?: boolean },
) => {
  await page.getByRole('button', { name: /New announcement|Write the first announcement/u }).first().click()
  await page.getByLabel('Tag').fill(card.tag)
  await page.getByLabel('Headline').fill(card.title)
  // Not exact: the accessible label carries the character counter ("Text 0/1000").
  await page.getByLabel('Text').fill(card.body)
  if (card.published === false) {
    await page.getByLabel('Published').uncheck()
  }
  await page.getByRole('button', { name: 'Create announcement' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByText(card.title).first()).toBeVisible()
}

test.describe('the announcement banner', () => {
  test('the landing page hides the board until something is published', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await expect(page.getByTestId('announcement-panel')).toHaveCount(0)
    await expect(page.getByTestId('announcement-panel-mobile')).toHaveCount(0)
  })

  test('an announcer lands on the board, publishes, and the public reads it', async ({ page }) => {
    // Accepting the invitation leaves the announcer signed in.
    await inviteSomebodyTo(page, 'Announcer')
    // The office door forwards an announcer straight to the one screen it
    // unlocks — the dashboard's casework queries would only refuse them.
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/announcements$/u)
    const sections = await navigationSections(page)
    expect(sections).toContain('administration')
    expect(sections).not.toContain('workspace')

    await authorAnnouncement(page, {
      tag: 'Notice',
      title: 'The window opens Monday',
      body: 'Applications for the new cycle open at nine.',
    })

    // The editor's preview showed the card; the landing page now shows it for
    // real, to a visitor with no session at all.
    await page.context().clearCookies()
    await page.goto('/')
    const panel = page.getByTestId('announcement-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('The window opens Monday')).toBeVisible()
  })

  test('a hidden draft stays off the landing page until flipped live', async ({ page }) => {
    await inviteSomebodyTo(page, 'Announcer')
    await page.goto('/admin/announcements')
    await authorAnnouncement(page, {
      tag: 'Draft',
      title: 'Not ready to say this yet',
      body: 'Still being worded.',
      published: false,
    })

    // The suite shares one database, so earlier tests' cards may be on the
    // banner — what must be absent is this draft, not the whole panel.
    await page.goto('/')
    await expect(page.getByText('Not ready to say this yet')).toHaveCount(0)

    await page.goto('/admin/announcements')
    const draftRow = page
      .locator(`[class*="row_"]`)
      .filter({ hasText: 'Not ready to say this yet' })
    await draftRow.getByRole('button', { name: 'Hidden' }).click()
    await expect(draftRow.getByRole('button', { name: 'Live' })).toBeVisible()

    await page.goto('/')
    const panel = page.getByTestId('announcement-panel')
    await expect(panel).toBeVisible()
    // The carousel shows one card at a time; walk it until the draft appears.
    await expect(async () => {
      if (await panel.getByText('Not ready to say this yet').count()) return
      await panel.getByRole('button', { name: 'Next notification' }).click()
      await expect(panel.getByText('Not ready to say this yet')).toBeVisible({ timeout: 500 })
    }).toPass()
  })

  test('reordering moves a card up the board and the banner alike', async ({ page }) => {
    await inviteSomebodyTo(page, 'Announcer')
    await page.goto('/admin/announcements')
    await authorAnnouncement(page, {
      tag: 'First',
      title: 'The elder card',
      body: 'Authored first.',
    })
    await authorAnnouncement(page, {
      tag: 'Second',
      title: 'The younger card',
      body: 'Authored second.',
    })

    await page.getByRole('button', { name: 'Move The younger card earlier' }).click()
    // The board repaints from the reorder's own answer: the younger card now
    // sits above the elder one.
    await expect(async () => {
      const titles = await page.locator('[class*="rowTitle"]').allTextContents()
      expect(titles.indexOf('The younger card')).toBeLessThan(
        titles.indexOf('The elder card'),
      )
    }).toPass()
  })

  test('an announcer is contained to the banner', async ({ page }) => {
    await inviteSomebodyTo(page, 'Announcer')
    await page.goto('/admin/queue')
    await expect(page).toHaveURL(/\/admin\/announcements$/u)
  })
})
