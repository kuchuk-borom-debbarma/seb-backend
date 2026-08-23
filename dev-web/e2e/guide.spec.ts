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
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  signUpApplicant,
  startApplication,
  submitApplication,
  uniqueEmail,
} from './support'

/**
 * Clears what the browser remembers about the guide, for a first-visit test.
 *
 * By prefix rather than by name: the first visit is now remembered once per
 * portal, and a helper listing keys by hand is a helper that silently stops
 * clearing the one somebody adds next.
 */
const forgetGuide = async (page: Page) => {
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('seb.guide')) window.localStorage.removeItem(key)
    }
  })
}

/** Every `.tsx` under a directory, so no screen is missed by a hand-kept list. */
const collectSources = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return collectSources(path)
      return entry.name.endsWith('.tsx') ? [path] : []
    }),
  )
  return found.flat()
}

test.describe('the guide keeps its own promises', () => {
  /*
   * A step that marks an element nobody registered brackets nothing: the rail
   * polls for thirty frames, gives up, and scrolls to the top instead — so the
   * failure is invisible and survives review. It did, for one step, until this
   * test was written. Read as files rather than driven through a browser,
   * because it is a fact about the source, not about a running page.
   */
  test('every mark a route declares is registered on a real screen', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const tours = await readFile(join(here, '../src/features/guide/tours.ts'), 'utf8')
    const declared = [...tours.matchAll(/mark: '([a-z-]+)'/gu)].flatMap(
      (match) => match[1] ?? [],
    )
    expect(declared.length).toBeGreaterThan(0)

    const sources = await collectSources(join(here, '../src'))
    const registered = new Set<string>()
    for (const file of sources) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/mark\('([a-z-]+)'\)/gu)) {
        if (match[1]) registered.add(match[1])
      }
    }

    expect([...new Set(declared)].filter((mark) => !registered.has(mark))).toEqual([])
  })
})

test.describe('how this works', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  })

  test('is the first thing in the navigation', async ({ page }) => {
    await page.goto('/')
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
      page.getByText(/more routes? covers? work this account cannot do/u),
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
    await expect(rail.getByText('Step 1 of 9')).toBeVisible()
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
    await expect(rail.getByText('Step 2 of 9')).toBeVisible()

    await rail.getByRole('button', { name: 'Back' }).click()
    await expect(rail.getByText('Step 1 of 9')).toBeVisible()
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
    await expect(
      rail.getByText(/If this queue is empty, nothing has been sent in yet/u),
    ).toBeVisible()
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
    await expect(rail.getByText('Step 2 of 9')).toBeVisible()

    // A demonstration gets interrupted. Coming back must not start again.
    await page.reload()
    await expect(
      page.getByRole('complementary', { name: /Guided route/u }).getByText('Step 2 of 9'),
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
    await expect(rail.getByText('Step 2 of 9')).toBeVisible()
  })
})

test.describe('the first visit', () => {
  test('points at the guide once, then stops asking', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')
    await forgetGuide(page)
    await page.reload()

    await expect(page.getByText('First time in the programme office?')).toBeVisible()

    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByText('First time in the programme office?')).toHaveCount(0)

    // And it does not come back on the next page.
    await page.goto('/admin/queue')
    await expect(page.getByText('First time in the programme office?')).toHaveCount(0)
  })

  test('is never shown on the guide itself', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')
    await forgetGuide(page)
    await page.goto('/guide')

    await expect(page.getByText('First time in the programme office?')).toHaveCount(0)
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
    await page.goto(`/applications/${id}/form`)

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
    await page.goto(`/applications/${id}/form`)

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
    await expect(page.getByText('First time in the programme office?')).toBeVisible()

    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    // Somebody being led through the product is not lost.
    await expect(page.getByText('First time in the programme office?')).toHaveCount(0)
  })
})

test.describe('the office is led to the work, not only to the console', () => {
  /*
   * The property that made this half of the guidance layer worth building. A
   * route may now name a screen that exists only for one application — and the
   * only honest way to follow it is to follow the file the reader has actually
   * opened. These two tests are the two halves of that: it follows one when
   * there is one, and it refuses to invent one when there is not.
   */

  test('a step that needs a file nobody opened stays put and says what to open', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await forgetGuide(page)
    await page.goto('/guide')

    await page
      .getByRole('article')
      .filter({ hasText: 'From approval to money' })
      .getByRole('button', { name: 'Walk this route' })
      .click()
    await expect(page).toHaveURL(/\/admin\/queue/u)

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    await rail.getByRole('button', { name: 'Next' }).click()

    // Step two names /admin/applications/$id/funding. With no application in
    // hand it must not navigate, and must not fabricate an id.
    await expect(page).toHaveURL(/\/admin\/queue/u)
    await expect(
      rail.getByText(/Open an approved application from the queue first/u),
    ).toBeVisible()
    await expect(page.locator('[data-marked]')).toHaveCount(0)

    /*
     * And it does not offer to take anybody anywhere, because there is nowhere
     * honest to go. The offer appears the moment a file is in hand — asserted
     * in the test below rather than here, where it would be a lie.
     */
    await expect(rail.getByRole('button', { name: 'Take me to this step' })).toHaveCount(
      0,
    )
  })

  test('a route follows the application the reader has open', async ({ page }) => {
    const { id } = await submitApplication(page, {
      prefix: 'guided',
      businessName: 'Guided Works',
    })

    await page.context().clearCookies()
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await forgetGuide(page)

    // Open the file first — this is how the guide learns which one is meant.
    await page.goto(`/admin/applications/${id}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.goto('/guide')
    await page
      .getByRole('article')
      .filter({ hasText: 'Reviewing what comes in' })
      .getByRole('button', { name: 'Walk this route' })
      .click()

    const rail = page.getByRole('complementary', { name: /Guided route/u })
    for (const step of [2, 3, 4]) {
      await rail.getByRole('button', { name: 'Next' }).click()
      await expect(rail.getByText(`Step ${step} of 9`)).toBeVisible()
    }

    // Step four is the claim card, on that exact application.
    await expect(page).toHaveURL(new RegExp(`/admin/applications/${id}$`, 'u'))
    await expect(page.locator('[data-marked]')).toHaveCount(1)
    await expect(page.locator('[data-guide="assignment"][data-marked]')).toBeVisible()

    // And the product is still the product while the guide talks about it: the
    // card it brackets is readable and its control is still usable.
    await expect(page.getByText('Assignment', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Claim it' })).toBeEnabled()
  })
})

test.describe('the office reads its own words', () => {
  test('a word whose name does not give its meaning has an answer beside it', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')

    const opener = page.getByRole('button', {
      name: 'Why new submissions and revision responses are counted apart',
    })
    await expect(opener).toBeVisible()
    await expect(opener).toHaveAttribute('aria-expanded', 'false')

    await opener.click()
    await expect(opener).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('note')).toContainText(/never land in one pile/u)

    await page.keyboard.press('Escape')
    await expect(opener).toHaveAttribute('aria-expanded', 'false')
  })

  test('the console still reads as a console, not as a help page', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin')

    /*
     * Scarcity is the whole rule. One answer per card at most — an icon beside
     * every label teaches nothing and doubles the reading — so the count is
     * asserted rather than left to taste.
     */
    await expect(page.locator('button.explain')).toHaveCount(1)
  })

  test('every office screen says what it is for', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)

    for (const path of [
      '/admin',
      '/admin/queue',
      '/admin/cycles',
      '/admin/cycles/new',
      '/admin/meetings',
      '/admin/access',
    ]) {
      await page.goto(path)
      const lede = page.locator('.page-header-description')
      await expect(lede, `${path} opens with no lede`).toBeVisible()
      // A lede is a sentence, not a label.
      expect(
        (await lede.innerText()).length,
        `${path} lede is too short`,
      ).toBeGreaterThan(30)
    }
  })
})

test.describe('the first visit', () => {
  test('welcomes each portal in its own words, once', async ({ page }) => {
    // An account that genuinely holds both, built the way portals.spec.ts does.
    const both = uniqueEmail('welcome')
    await signUpApplicant(page, both)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/access?email=${encodeURIComponent(both)}`)
    await page.getByLabel('Role').selectOption('ADMIN')
    await page.getByLabel('Why they should have it').fill('Runs the demonstration.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()
    await expect(page.getByText('Admin granted.')).toBeVisible()

    await page.context().clearCookies()
    await signIn(page, both)
    await forgetGuide(page)

    await page.goto('/')
    await expect(page.getByText('First time here?')).toBeVisible()
    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByText('First time here?')).toHaveCount(0)

    /*
     * Dismissing the applicant welcome says nothing about the office: they are
     * two products with two things to say, and one key for both would silence
     * the only line that would ever explain the second.
     */
    await page.goto('/admin')
    await expect(page.getByText('First time in the programme office?')).toBeVisible()
    await page.getByRole('button', { name: 'Not now' }).click()

    await page.goto('/')
    await expect(page.getByText('First time here?')).toHaveCount(0)
    await page.goto('/admin')
    await expect(page.getByText('First time in the programme office?')).toHaveCount(0)
  })
})
