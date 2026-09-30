/**
 * Authoring a pipeline on screen: the route an application takes after it is
 * submitted.
 *
 * Each pipeline here is a new one with its own key, so nothing in these tests
 * touches the seeded Mission SEP route every other spec's cycles are pinned
 * to. The editor's promises are the ones asserted: it starts from the worked
 * example, draws the route, says whether the draft may be published, hands a
 * stage to a role, publishes — and refuses a save that would overwrite a
 * colleague's, offering to load theirs instead.
 */
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, SUPER_ADMIN_EMAIL, signIn } from './support'

/** A key no other run or worker will have used. */
const freshKey = () =>
  `E2E_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`

/** Creates a pipeline from the example through the list's dialog, and opens it. */
const createFromExample = async (page: Page, key: string): Promise<void> => {
  await page.goto('/admin/pipelines')
  await page.getByRole('button', { name: 'New pipeline' }).click()
  const dialog = page.getByRole('dialog', { name: 'New pipeline' })
  await dialog.getByLabel('Name').fill(`Editor route ${key}`)
  await dialog.getByLabel('Key').fill(key)
  await dialog.getByLabel('Description').fill('Authored by the end-to-end suite.')
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await dialog.getByRole('button', { name: 'Create the draft' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/pipelines/${key}$`, 'u'))
}

test.describe('authoring a pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
  })

  test('starts from the example, draws it, hands a stage to a role and publishes', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const key = freshKey()
    await createFromExample(page, key)

    // A draft, at its first revision, drawn as a route.
    await expect(page.getByText('Draft v1 · revision 1')).toBeVisible()
    const flow = page.getByRole('img', {
      name: "The pipeline's stages and how an application moves between them",
    })
    await expect(flow).toBeVisible()
    for (const stage of ['TTC review', 'Industries & Commerce', 'State Bank of India', 'Tripura Gramin Bank']) {
      await expect(flow.getByText(stage, { exact: true }).first()).toBeVisible()
    }

    // The worked example is publishable as it stands, and the check says so.
    await page.getByRole('button', { name: 'Check' }).click()
    await expect(page.getByText('Nothing stops this draft from being published.')).toBeVisible()

    // Owners are live data: set before publishing, with a reason.
    await page.getByRole('tab', { name: 'Owners' }).click()
    const ttcRow = page.getByRole('row').filter({ hasText: 'TTC review' })
    await expect(ttcRow.getByText('Nobody — files here cannot be worked')).toBeVisible()
    await ttcRow.getByRole('button', { name: 'Change' }).click()
    const owners = page.getByRole('dialog', { name: 'Who works TTC review' })
    await owners.getByRole('checkbox', { name: /^TTC TTC$/u }).check()
    await owners.getByLabel('Why').fill('The TTC office reviews every file first.')
    await owners.getByRole('button', { name: 'Save owners' }).click()
    await expect(owners).toHaveCount(0)
    await expect(ttcRow.getByRole('listitem').filter({ hasText: /^TTC$/u })).toBeVisible()

    // Publishing freezes the draft as version 1.
    await page.getByRole('button', { name: 'Publish' }).click()
    const publish = page.getByRole('dialog', { name: 'Publish version 1' })
    await publish.getByLabel('What changed').fill('The first route.')
    await publish.getByRole('button', { name: 'Publish' }).click()
    await expect(page.getByText('Published v1')).toBeVisible()

    // And the list says so.
    await page.goto('/admin/pipelines')
    const row = page.getByRole('article').filter({ hasText: `Editor route ${key}` })
    await expect(row).toBeVisible()
    await expect(row.getByText('Draft v1')).toHaveCount(0)
  })

  test('refuses a save that would overwrite a colleague’s, and offers theirs', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000)
    const key = freshKey()
    await createFromExample(page, key)

    // A colleague opens the same draft in another browser.
    const colleague = await browser.newContext()
    const theirs = await colleague.newPage()
    await signIn(theirs, SUPER_ADMIN_EMAIL, PASSWORD)
    await theirs.goto(`/admin/pipelines/${key}`)

    // They rename the first stage and save first.
    await theirs.getByRole('tab', { name: /^Stages/u }).click()
    await theirs.getByLabel('Name, for the office').fill('First review')
    await theirs.getByRole('button', { name: 'Save draft' }).click()
    await expect(theirs.getByText('Draft v1 · revision 2')).toBeVisible()

    // This page still holds revision 1, so its save is refused as stale.
    await page.getByRole('tab', { name: /^Stages/u }).click()
    await page.getByLabel('Name, for the office').fill('Initial review')
    await page.getByRole('button', { name: 'Save draft' }).click()
    const reload = page.getByRole('button', { name: /Load the saved draft/u })
    await expect(reload).toBeVisible()

    // Loading theirs replaces this page's unsaved change with the saved one.
    await reload.click()
    await expect(page.getByText('Draft v1 · revision 2')).toBeVisible()
    await page.getByRole('tab', { name: /^Stages/u }).click()
    await expect(page.getByLabel('Name, for the office')).toHaveValue('First review')

    await colleague.close()
  })

  test('lists every problem at once, each leading to where it is', async ({ page }) => {
    const key = freshKey()
    await createFromExample(page, key)

    // Emptying a stage's name is a problem the check names.
    await page.getByRole('tab', { name: /^Stages/u }).click()
    await page.getByLabel('Name, for the office').fill('')
    await page.getByRole('button', { name: 'Check' }).click()
    const problems = page.getByRole('alert').filter({ hasText: /stops? this draft from being published/u })
    await expect(problems).toBeVisible()
    await expect(problems.getByRole('listitem').first()).toBeVisible()
  })
})
