/**
 * The form-authoring screen: a super administrator changing what a draft
 * cycle asks.
 *
 * Everything here drives the editor the way an officer would — through the
 * cycle's own page — and asserts the server's refusals in the server's own
 * words, because the screen promises to show them verbatim.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PASSWORD,
  SUPER_ADMIN_EMAIL,
  WORKER_URL,
  signIn,
  signUpApplicant,
  uniqueEmail,
} from './support'

/**
 * Creates a draft cycle — and leaves it a draft, which is the whole point:
 * only a draft's questions can be edited. Returns the cycle's id.
 */
const createDraftCycle = async (page: Page, prefix: string): Promise<string> => {
  const code = `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 5)
    .toUpperCase()}`
  await page.goto('/admin/cycles/new')
  await page.getByLabel('Cycle code').fill(code)
  await page.getByLabel('Name', { exact: true }).fill(code)
  await page.getByLabel('Guidance for applicants').fill('Draft under authoring.')
  const local = (value: Date) => value.toISOString().slice(0, 16)
  await page.getByLabel('Applications open').fill(local(new Date(Date.now() - 3_600_000)))
  await page.getByRole('button', { name: 'Create draft cycle' }).click()
  await expect(page).toHaveURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u)
  return page.url().split('/').pop() as string
}

test.describe('authoring a draft cycle’s form', () => {
  test('a stage, a question with presentation, and a structure used by a group', async ({
    page,
  }) => {
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const id = await createDraftCycle(page, 'AUTH')

    // The door is on the cycle's own page, beside the questions it shows.
    await page.getByRole('link', { name: 'Edit the form' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/cycles/${id}/form$`, 'u'))
    await expect(page.getByText('This cycle is still a draft')).toBeVisible()

    // Nothing saves without a reason; one input covers every edit on screen.
    await page
      .getByLabel('Reason for these changes')
      .fill('Authoring the programme year form.')

    // A stage.
    await page.getByRole('button', { name: 'Add a stage' }).click()
    await page.getByLabel('Stage key').fill('EXTRA')
    await page.getByLabel('Heading').fill('Extra details')
    await page.getByRole('button', { name: 'Save stage' }).click()
    await expect(
      page.getByRole('navigation', { name: 'Form sections' }).getByText('Extra details'),
    ).toBeVisible()

    // A question in it, carrying presentation the applicant will see.
    await page
      .getByRole('navigation', { name: 'Form sections' })
      .getByText('Extra details')
      .click()
    await page.getByRole('button', { name: 'Add a question', exact: true }).click()
    await page.getByLabel('Question key').fill('FAVOURITE_COLOUR')
    await page.getByLabel('Label the applicant reads').fill('Favourite colour')
    await page.getByLabel('Ghost text in the empty control').fill('e.g. red')
    await page
      .getByLabel('Inline note under the control (optional)')
      .fill('Any colour is acceptable.')
    await page.getByLabel('Note tone').selectOption('INFO')
    await page.getByRole('button', { name: 'Save question' }).click()
    await expect(page.getByText('Favourite colour')).toBeVisible()
    await expect(page.getByText('FAVOURITE_COLOUR · text')).toBeVisible()

    // A structure: defined once, in the structures panel.
    await page.getByRole('button', { name: 'Structures' }).click()
    await page.getByRole('button', { name: 'Define a structure' }).click()
    await page.getByLabel('Structure key').fill('REFEREE')
    await page.getByLabel('Name', { exact: true }).fill('Referee')
    await page.getByRole('button', { name: 'Add a member' }).click()
    await page.getByLabel('Member key').fill('NAME')
    await page.getByLabel('Label the applicant reads').fill('Referee name')
    /*
     * Bounded, because the whole template must fit the 32 KB answer budget
     * at every group's worst case. Twenty unbounded text entries are what
     * the budget guard exists to refuse.
     */
    await page.getByLabel('Most characters').fill('120')
    await page.getByRole('button', { name: 'Add a member' }).click()
    await page.getByLabel('Member key').fill('PHONE')
    await page.getByLabel('Label the applicant reads').fill('Referee phone')
    await page.getByLabel('Most characters').fill('30')

    /*
     * Reordering members edits the local draft only — the arrows need no
     * change reason, and nothing persists until Save structure. Filtered to
     * this structure's members: other definitions' summary rows share the
     * class and sit above the open editor.
     */
    const memberRows = page
      .locator('[class*="questionRow"]')
      .filter({ hasText: /Referee (name|phone)/u })
    await expect(memberRows.first()).toContainText('Referee name')
    await page.getByRole('button', { name: 'Move Referee phone earlier' }).click()
    await expect(memberRows.first()).toContainText('Referee phone')

    await page.getByRole('button', { name: 'Save structure' }).click()
    await expect(page.getByText('REFEREE · 2 questions · unused')).toBeVisible()

    // The saved order is the array order, so it survives a fresh read.
    await page.reload()
    await expect(page.getByText('This cycle is still a draft')).toBeVisible()
    await page.getByRole('button', { name: 'Structures' }).click()
    await page
      .locator('[class*="questionRow"]')
      .filter({ hasText: 'REFEREE · 2 questions' })
      .getByRole('button', { name: 'Edit' })
      .click()
    // The members come back in the saved order, phone still ahead.
    await expect(memberRows.first()).toContainText('Referee phone')
    await expect(memberRows.nth(1)).toContainText('Referee name')

    // The reload emptied the reason input; later edits still need one.
    await page
      .getByLabel('Reason for these changes')
      .fill('Authoring the programme year form.')

    // Used by a repeated group in the new stage.
    await page
      .getByRole('navigation', { name: 'Form sections' })
      .getByText('Extra details')
      .click()
    await page.getByRole('button', { name: 'Add a question', exact: true }).click()
    await page.getByLabel('Question key').fill('REFEREES')
    await page.getByLabel('Type of answer').selectOption('REPEAT_GROUP')
    await page.getByLabel('Label the applicant reads').fill('Referees')
    await page.getByLabel('Structure').selectOption('REFEREE')
    await page.getByRole('button', { name: 'Save question' }).click()

    /*
     * The expansion's output appears under the group — visibly derived, and
     * not individually editable: the definition is what is edited.
     */
    // The row, not the tag inside it — both carry a "derived" class.
    const derived = page
      .locator('[class*="derived"]')
      .filter({ hasText: 'Referee name' })
      .first()
    await expect(derived.getByText('from structure Referee')).toBeVisible()
    await expect(derived.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await expect(derived.getByRole('button', { name: 'Remove' })).toHaveCount(0)

    /*
     * Reordering questions is a save like any other — it rides on the reason
     * above — and the arrows flip the rows on screen from the server's reply.
     */
    const stageRows = page.locator('[class*="questionRow"]')
    await expect(stageRows.first()).toContainText('Favourite colour')
    await page.getByRole('button', { name: 'Move Referees earlier' }).click()
    await expect(stageRows.first()).toContainText('Referees')

    // Removing a structure still in use is refused in the server's own words.
    await page.getByRole('button', { name: 'Structures' }).click()
    await expect(page.getByText('used by Referees')).toBeVisible()
    await page
      .locator('[class*="questionRow"]')
      .filter({ hasText: 'REFEREE · 2 questions' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click()
    await expect(
      page.getByText('REFEREE is used by REFEREES. Remove those groups first.'),
    ).toBeVisible()

    // Remove the group, and the structure goes quietly.
    await page
      .getByRole('navigation', { name: 'Form sections' })
      .getByText('Extra details')
      .click()
    const groupRow = page
      .locator('[class*="questionRow"]')
      .filter({ hasText: 'REFEREES · repeat group' })
    await groupRow.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('REFEREES · repeat group')).toHaveCount(0)

    await page.getByRole('button', { name: 'Structures' }).click()
    await page
      .locator('[class*="questionRow"]')
      .filter({ hasText: 'REFEREE ·' })
      .getByRole('button', { name: 'Remove' })
      .click()
    await expect(page.getByText('REFEREE · 2 questions')).toHaveCount(0)
  })

  test('an ordinary administrator is shown no editor and refused by the API', async ({
    page,
  }) => {
    // The super administrator prepares a draft and grants ADMIN to a fresh
    // account, through the same access screen an operator would use.
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    const id = await createDraftCycle(page, 'AUTHR')
    const email = uniqueEmail('authoring-admin')
    await page.context().clearCookies()
    await signUpApplicant(page, email)
    await signIn(page, SUPER_ADMIN_EMAIL, PASSWORD)
    await page.goto(`/admin/access?email=${encodeURIComponent(email)}`)
    await page.getByLabel('Role').selectOption('ADMIN')
    await page.getByLabel('Why they should have it').fill('Runs the intake desk.')
    await page.getByLabel('Your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Grant it' }).click()
    await expect(page.getByText('Admin granted.')).toBeVisible()

    await page.context().clearCookies()
    await signIn(page, email)

    // The cycle page shows the questions, but not the door to change them.
    await page.goto(`/admin/cycles/${id}`)
    await expect(page.getByText('Questions this cycle asks')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Edit the form' })).toHaveCount(0)

    // Typing the address is answered with a refusal, not a broken editor.
    await page.goto(`/admin/cycles/${id}/form`)
    await expect(
      page.getByText('You do not have permission to change a cycle’s questions.'),
    ).toBeVisible()

    /*
     * And the API itself refuses — the screen hides nothing the server would
     * allow. One raw mutation, exactly as the Worker receives it.
     */
    const response = await page.request.post(`${WORKER_URL}/graphql`, {
      data: {
        query: `mutation($input: FormStageMutationInput!) {
          admin { formTemplate { addStage(input: $input) { success message } } }
        }`,
        variables: {
          input: {
            scope: {
              programmeCycleId: id,
              expectedVersion: 1,
              reason: 'Should never be recorded.',
            },
            stage: { stageKey: 'BLOCKED', title: 'Blocked' },
          },
        },
      },
      headers: { 'content-type': 'application/json' },
    })
    const body = await response.json()
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    const result = body.data.admin.formTemplate.addStage
    expect(result.success).toBe(false)
    // The capability refusal, verbatim: checked before anything else, so even
    // a stale version cannot change the answer an administrator gets.
    expect(result.message).toBe('You do not have permission to do that.')
  })
})
