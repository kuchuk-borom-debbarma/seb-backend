/**
 * The guidance layer.
 *
 * Three things have to be true of a guide, and each is asserted here rather
 * than assumed. It must be honest: every route it offers must lead to a screen
 * that exists, and it must not claim to explain something it cannot show. It
 * must not get in the way: the product stays visible and usable while the guide
 * is talking. And it must be leadable by anyone: reachable from a standing
 * start, resumable after an interruption, and operable by keyboard.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  signUpApplicant,
  startApplication,
  uniqueEmail,
} from './support'

/** Clears what the browser remembers about the guide, for a first-visit test. */
const forgetGuide = async (page: Page) => {
  await page.evaluate(() => {
    window.localStorage.removeItem('seb.guide')
    window.localStorage.removeItem('seb.guide.seen')
  })
}

test.describe('how this works', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  })

  test('is the first thing in the navigation', async ({ page }) => {
    await page.goto('/app')
    const navigation = page.getByRole('navigation', { name: 'Portal sections' })
    const links = await navigation.getByRole('link').allInnerTexts()
    expect(links[0]).toBe('How this works')
  })

  test('draws the whole route, one stop per row, in order', async ({ page }) => {
    await page.goto('/guide')

    const stops = page
      .getByRole('listitem')
      .filter({ hasText: /Draft|Submitted|Sanctioned/u })
    await expect(stops.first()).toBeVisible()

    // Eleven states, and the count on the page says the same number the
    // diagram draws rather than one read from a query.
    await expect(page.getByText('11 states · 4 desks · 1 reference number')).toBeVisible()

    /*
     * Consecutive stops must not share a row. Draft and Submitted happen one
     * after the other; laying them side by side would say they happen at once.
     */
    const draft = await page
      .getByRole('heading', { name: 'Draft', exact: true })
      .boundingBox()
    const submitted = await page
      .getByRole('heading', { name: 'Submitted', exact: true })
      .boundingBox()
    expect(submitted?.y ?? 0).toBeGreaterThan(draft?.y ?? 0)

    // And a stop sits under the desk that holds it: the bank's stop is to the
    // right of the applicant's.
    const withBank = await page
      .getByRole('heading', { name: 'With a partner bank' })
      .boundingBox()
    expect(withBank?.x ?? 0).toBeGreaterThan(draft?.x ?? 0)
  })

  test('offers only the routes this account can actually walk', async ({ page }) => {
    await page.goto('/guide')

    // A super administrator holds no applicant role here, so the applicant
    // route is withheld — and the page says so rather than silently omitting it.
    await expect(
      page.getByRole('heading', { name: 'Reviewing what comes in' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Who is allowed to do what' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Applying for seed funding' }),
    ).toHaveCount(0)
    await expect(
      page.getByText(/more routes cover work this account cannot do/u),
    ).toBeVisible()
  })

  test('an applicant is offered their own route and not the office’s', async ({
    page,
  }) => {
    await page.context().clearCookies()
    const email = uniqueEmail('guide')
    await signUpApplicant(page, email)
    await signIn(page, email)
    await page.goto('/guide')

    await expect(
      page.getByRole('heading', { name: 'Applying for seed funding' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Reviewing what comes in' }),
    ).toHaveCount(0)
  })
})

test.describe('walking a route', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/guide')
    await forgetGuide(page)
  })

  test('takes you to the real screen and says where you are', async ({ page }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    // The first step's screen, not a picture of it.
    await expect(page).toHaveURL(/\/admin$/u)

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    await expect(rail).toBeVisible()
    await expect(rail.getByText('Step 1 of 5')).toBeVisible()
    await expect(rail.getByText('Programme office', { exact: true })).toBeVisible()
    await expect(
      rail.getByRole('heading', { name: 'Start from what needs you' }),
    ).toBeVisible()
  })

  test('marks what it is talking about instead of hiding everything else', async ({
    page,
  }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()
    await expect(page).toHaveURL(/\/admin$/u)

    // The queues the step is about carry the mark.
    await expect(page.locator('[data-marked]')).toHaveCount(1)
    await expect(page.locator('[data-guide="waiting-on-us"]')).toHaveAttribute(
      'data-marked',
    )

    /*
     * And the product is still there. A tour that dimmed the page would make
     * the demonstration worse than no demonstration.
     */
    await expect(page.getByRole('heading', { name: 'Intake' })).toBeVisible()
    await expect(page.getByLabel('Reference number')).toBeEditable()
  })

  test('moves forward and back through the steps', async ({ page }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    await expect(rail.getByRole('button', { name: 'Back' })).toBeDisabled()

    await rail.getByRole('button', { name: 'Next' }).click()
    await expect(page).toHaveURL(/\/admin\/queue/u)
    await expect(rail.getByText('Step 2 of 5')).toBeVisible()

    await rail.getByRole('button', { name: 'Back' }).click()
    await expect(rail.getByText('Step 1 of 5')).toBeVisible()
    await expect(page).toHaveURL(/\/admin$/u)
  })

  test('says plainly when a step needs data the demonstration may not have', async ({
    page,
  }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    // Step 3 is the claim, which needs a submitted application to claim.
    await rail.getByRole('button', { name: 'Next' }).click()
    await rail.getByRole('button', { name: 'Next' }).click()

    await expect(rail.getByText('To try this')).toBeVisible()
    await expect(rail.getByText(/Open any submitted application/u)).toBeVisible()
  })

  test('the last step finishes rather than running off the end', async ({ page }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Who is allowed to do what' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    await rail.getByRole('button', { name: 'Next' }).click()
    await rail.getByRole('button', { name: 'Next' }).click()

    await expect(rail.getByText('Step 3 of 3')).toBeVisible()
    await rail.getByRole('button', { name: 'Finish' }).click()
    await expect(rail).toHaveCount(0)
  })

  test('can be left and picked up where it stopped', async ({ page }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    await rail.getByRole('button', { name: 'Next' }).click()
    await expect(rail.getByText('Step 2 of 5')).toBeVisible()

    // A demonstration gets interrupted. Coming back must not start again.
    await page.reload()
    await expect(
      page.getByRole('complementary', { name: /Guided route/u }).getByText('Step 2 of 5'),
    ).toBeVisible()
  })

  test('ends when asked, and stays ended', async ({ page }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    await page.getByRole('button', { name: 'End the tour' }).click()
    await expect(page.getByRole('complementary', { name: /Guided route/u })).toHaveCount(
      0,
    )
    await expect(page.locator('[data-marked]')).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('complementary', { name: /Guided route/u })).toHaveCount(
      0,
    )
  })

  test('is operable by keyboard', async ({ page }) => {
    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    await rail.getByRole('button', { name: 'Next' }).focus()
    await page.keyboard.press('Enter')
    await expect(rail.getByText('Step 2 of 5')).toBeVisible()
  })
})

test.describe('the first visit', () => {
  test('points at the guide once, then stops asking', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')
    await forgetGuide(page)
    await page.reload()

    await expect(page.getByText('First time here?')).toBeVisible()

    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByText('First time here?')).toHaveCount(0)

    // And it does not come back on the next page.
    await page.goto('/admin/queue')
    await expect(page.getByText('First time here?')).toHaveCount(0)
  })

  test('is never shown on the guide itself', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')
    await forgetGuide(page)
    await page.goto('/guide')

    await expect(page.getByText('First time here?')).toHaveCount(0)
  })
})

test.describe('a question that explains itself', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await openProgrammeCycle(page, { prefix: 'SEP-G' })
    await page.context().clearCookies()
  })

  test('opens on click, closes on Escape, and does not rename its field', async ({
    page,
  }) => {
    const id = await startApplication(page, {
      prefix: 'guide',
      businessName: 'Guide Works',
    })
    await page.goto(`/app/applications/${id}/form`)

    /*
     * The control must still be named by its own label. Putting the explanation
     * inside the <label> would have made the field announce as "Category ?".
     */
    await expect(page.getByLabel('Category', { exact: true })).toBeVisible()

    const opener = page.getByRole('button', { name: 'Why Category is asked' })
    await expect(opener).toHaveAttribute('aria-expanded', 'false')

    await opener.click()
    await expect(page.getByRole('note')).toBeVisible()
    await expect(page.getByRole('note')).toContainText(/how much seed funding/u)
    await expect(opener).toHaveAttribute('aria-expanded', 'true')

    // Escape closes it, because a popover that can only be closed with the
    // mouse is a trap for anyone using a keyboard.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('note')).toHaveCount(0)
  })

  test('is offered only where a question genuinely surprises', async ({ page }) => {
    const id = await startApplication(page, {
      prefix: 'guide',
      businessName: 'Guide Works',
    })
    await page.goto(`/app/applications/${id}/form`)

    // One explanation on a form of forty questions. An icon beside every label
    // teaches nothing and doubles the reading.
    await expect(page.getByRole('button', { name: /^Why .* is asked$/u })).toHaveCount(1)
  })
})

test.describe('the pointer and the tour do not talk over each other', () => {
  test('the first-visit line goes quiet while a route is being walked', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')
    await forgetGuide(page)
    await page.reload()
    await expect(page.getByText('First time here?')).toBeVisible()

    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    // Somebody being led through the product is not lost.
    await expect(page.getByText('First time here?')).toHaveCount(0)
  })
})
