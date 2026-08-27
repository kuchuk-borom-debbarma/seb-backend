/**
 * Searching, filtering and paging the lists.
 *
 * What is being tested is the whole loop, not the control: typing narrows the
 * rows, the address carries it so a reload lands in the same view, an empty
 * result says which kind of empty it is, and the pager reports a total rather
 * than an unlabelled Next button.
 *
 * Search matches an indexed prefix. That is a real limit and the label says so
 * — these tests hold the label to it, because a box that promised "search" and
 * quietly meant "starts with" would be discovered by somebody typing a word
 * from the middle of a name and getting nothing.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  openProgrammeCycle,
  signIn,
  signUpApplicant,
  uniqueEmail,
} from './support'

/** Registers an enterprise through its own screen. */
const registerEnterprise = async (page: Page, name: string) => {
  await page.goto('/enterprises/new')
  await page.getByLabel('Registered or trading name').fill(name)
  // The form is a four-step wizard now; a name plus defaults carries through.
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole('button', { name: 'Next' }).click()
  }
  await page.getByRole('button', { name: 'Register enterprise' }).click()
  await expect(page).toHaveURL(/\/enterprises\/[0-9a-f-]{36}$/u)
}

test.describe('the enterprises list', () => {
  test.beforeEach(async ({ page }) => {
    const email = uniqueEmail('lists')
    await signUpApplicant(page, email)
    await signIn(page, email)
    await registerEnterprise(page, 'Khumulwng Food Works')
    await registerEnterprise(page, 'Khumulwng Handloom')
    await registerEnterprise(page, 'Agartala Textiles')
  })

  test('narrows as you type, and keeps it in the address', async ({ page }) => {
    await page.goto('/enterprises')
    await expect(page.getByRole('row')).toHaveCount(4) // header plus three

    await page.getByLabel('Name starts with').fill('Khumulwng')
    await expect(page.getByRole('row')).toHaveCount(3)
    await expect(page.getByText('Agartala Textiles')).toHaveCount(0)

    // The address carries it, so the view is linkable and survives a reload.
    await expect(page).toHaveURL(/search=Khumulwng/u)
    await page.reload()
    await expect(page.getByLabel('Name starts with')).toHaveValue('Khumulwng')
    await expect(page.getByRole('row')).toHaveCount(3)
  })

  test('is a prefix, and the label says so', async ({ page }) => {
    await page.goto('/enterprises')

    // The control does not promise more than the API does.
    await expect(page.getByLabel('Name starts with')).toBeVisible()

    // "Food" is inside a name but not at the start of one.
    await page.getByLabel('Name starts with').fill('Food')
    await expect(page.getByText('Nothing matches')).toBeVisible()
  })

  test('tells "nothing matches" apart from "nothing yet"', async ({ page }) => {
    await page.goto('/enterprises')
    await page.getByLabel('Name starts with').fill('Nothing At All')

    await expect(page.getByText('Nothing matches')).toBeVisible()
    await expect(page.getByText('No enterprises yet')).toHaveCount(0)

    // And offers the way out of it.
    await page.getByRole('button', { name: 'Clear the filters' }).click()
    await expect(page.getByRole('row')).toHaveCount(4)
    await expect(page).not.toHaveURL(/search=/u)
  })

  test('reports how many results there are', async ({ page }) => {
    await page.goto('/enterprises')
    await expect(page.getByText('Showing 3 of 3 enterprises')).toBeVisible()

    await page.getByLabel('Name starts with').fill('Khumulwng')
    await expect(page.getByText('Showing 2 of 2 enterprises')).toBeVisible()
  })

  test('filters by sector and state', async ({ page }) => {
    await page.goto('/enterprises')

    // Registration makes an enterprise active; nothing is inactive yet.
    await page.getByLabel('State').selectOption('INACTIVE')
    await expect(page.getByText('Nothing matches')).toBeVisible()

    await page.getByLabel('State').selectOption('')
    await page.getByLabel('Sector').selectOption('TOURISM_AND_HOSPITALITY')
    await expect(page.getByText('Nothing matches')).toBeVisible()
  })
})

test.describe('the intake queue', () => {
  test('searches by reference or enterprise, and says when nothing matches', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/queue')

    await expect(page.getByLabel('Reference or enterprise starts with')).toBeVisible()
    await page.getByLabel('Reference or enterprise starts with').fill('nothing-like-this')

    // The heading now says which kind of empty this is, and offers the way out.
    await expect(page.getByText('Nothing matches')).toBeVisible()
    await expect(page.getByText(/No application matches these filters/u)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Clear the filters' })).toBeVisible()
    await expect(page).toHaveURL(/search=nothing-like-this/u)
  })

  test('a search survives switching queues', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto('/admin/queue')
    await page.getByLabel('Reference or enterprise starts with').fill('sep')
    await expect(page).toHaveURL(/search=sep/u)

    await page.getByRole('tab', { name: /Desk review/u }).click()
    await expect(page).toHaveURL(/queue=DESK_REVIEW/u)
    await expect(page).toHaveURL(/search=sep/u)
  })
})

test.describe('the cycle list', () => {
  test('filters by state, year and code', async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const code = await openProgrammeCycle(page, { prefix: 'SEP-L' })
    await page.goto('/admin/cycles')

    /*
     * Search first. The suite shares one database and the list pages at twenty,
     * so by the time this runs a cycle created just now is not necessarily on
     * the first page — which is pagination working, not a problem to assert
     * around.
     */
    await page.getByLabel('Code starts with').fill(code)
    await expect(page.getByRole('cell', { name: code })).toBeVisible()

    // An open cycle is not archived.
    await page.getByLabel('State').selectOption('ARCHIVED')
    await expect(page.getByText('Nothing matches')).toBeVisible()

    await page.getByLabel('State').selectOption('OPEN')
    await expect(page.getByRole('cell', { name: code })).toBeVisible()

    // A prefix of the code still finds it.
    await page.getByLabel('Code starts with').fill(code.slice(0, 5))
    await expect(page.getByRole('cell', { name: code })).toBeVisible()

    await page.getByLabel('Programme year').fill('2000')
    await expect(page.getByText('Nothing matches')).toBeVisible()
  })
})

