import { expect, test, type Page } from '@playwright/test'
import { signIn, signUpApplicant, uniqueEmail } from './support'

const asNewApplicant = async (page: Page) => {
  const email = uniqueEmail('applicant')
  await signUpApplicant(page, email)
  await signIn(page, email)
  return email
}

const registerEnterprise = async (page: Page, name: string) => {
  await page.goto('/enterprises/new')
  await page.getByLabel('Registered or trading name').fill(name)
  await page.getByRole('button', { name: 'Register enterprise' }).click()
  await expect(page).toHaveURL(/\/enterprises\/[0-9a-f-]{36}$/u)
}

test.describe('applications', () => {
  test('says what to do first when there is nothing yet', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/applications')
    await expect(page.getByText('Nothing here yet')).toBeVisible()
  })

  test('asks for an enterprise before an application can be started', async ({
    page,
  }) => {
    await asNewApplicant(page)
    await page.goto('/applications/new')

    // An application is always made on behalf of an enterprise, so this is the
    // real prerequisite rather than a disabled button.
    await expect(page.getByText('Register an enterprise first')).toBeVisible()
  })

  test('reports honestly when no cycle is open', async ({ page }) => {
    await asNewApplicant(page)
    await registerEnterprise(page, 'Cycleless Works')
    await page.goto('/applications/new')

    // The test database has no open cycle until an administrator opens one, and
    // the screen must say so rather than offering an action that would fail.
    await expect(page.getByText('No cycle is open for new applications')).toBeVisible()
  })

  test('programme cycles page distinguishes open from history', async ({ page }) => {
    await asNewApplicant(page)
    await page.goto('/cycles')

    await expect(
      page.getByRole('heading', { name: 'Open for new applications' }),
    ).toBeVisible()
    await expect(page.getByText('No cycle is open')).toBeVisible()

    // "Cycles you have applied in" only appears when there is history, so an
    // empty section is never shown.
    await expect(
      page.getByRole('heading', { name: 'Cycles you have applied in' }),
    ).toBeHidden()
  })

  test('filters are carried in the address so a view can be shared', async ({ page }) => {
    await asNewApplicant(page)
    await registerEnterprise(page, 'Filterable Works')
    await page.goto('/applications')

    await page.getByLabel('Status').selectOption('DRAFT')
    await expect(page).toHaveURL(/status=DRAFT/u)

    await page.getByLabel('Enterprise').selectOption({ label: 'Filterable Works' })
    await expect(page).toHaveURL(/enterpriseId=/u)

    // Both filters survive a reload, because they live in the URL.
    await page.reload()
    await expect(page.getByLabel('Status')).toHaveValue('DRAFT')
  })
})
