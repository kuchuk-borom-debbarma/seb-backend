/**
 * Who may shape the programme itself, as opposed to working its casework.
 *
 * A cycle's policy and form decide who is eligible and for how much — the
 * programme's own rulebook. These tests pin the boundary: an `ADMIN` keeps
 * every casework capability but may not create a cycle or edit its questions;
 * only the super-administrator holds `CYCLE_ADMIN`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { emptyFormTemplate, graphql, signIn, testPolicy } from '../support/api'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const DENIED = 'You do not have permission to do that.'

/** The one envelope message, wherever the single operation put it. */
const messageOf = async (query: string, cookie: string): Promise<string | null> => {
  const result = await graphql<any>(query, {}, cookie)
  expect(result.errors, query).toBeUndefined()
  const found = JSON.stringify(result.data).match(/"message":("[^"]*"|null)/u)
  return found ? (JSON.parse(found[1]) as string | null) : null
}

const CREATE_CYCLE = `mutation($input: ProgrammeCycleInput!) {
  admin { programmeCycle { create(input: $input) {
    success message response { head { id currentVersion } }
  } } }
}`

const cycleInput = () => ({
  cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  displayName: 'Cycle-admin boundary test', cycleYear: 2026,
  policyReference: 'TTAADC/MSEP/2026', applicantGuidance: 'Guide.',
  partnerBankGuidance: 'Roster.',
  opensAt: new Date(Date.now() + 86_400_000).toISOString(),
  closesAt: new Date(Date.now() + 172_800_000).toISOString(),
  policy: testPolicy(),
})

/** A draft cycle only the founder can mint, for probing the form gate. */
const draftCycle = async (): Promise<{ id: string; currentVersion: number }> => {
  const founder = await signIn(['SUPER_ADMIN'])
  const created = await graphql<any>(CREATE_CYCLE, { input: cycleInput() }, founder.cookie)
  const result = created.data.admin.programmeCycle.create
  expect(result.success, result.message ?? '').toBe(true)
  return result.response.head
}

describe('the CYCLE_ADMIN boundary', () => {
  it('refuses an administrator creating a cycle', async () => {
    // The refusal must be the permission message, not a validation one: the
    // gate has to run before the input is even considered.
    const administrator = await signIn(['ADMIN'])
    const created = await graphql<any>(CREATE_CYCLE, { input: cycleInput() }, administrator.cookie)
    expect(created.errors).toBeUndefined()
    expect(created.data.admin.programmeCycle.create.message).toBe(DENIED)
  })

  it('refuses an administrator editing the form of a cycle', async () => {
    const cycle = await draftCycle()
    const administrator = await signIn(['ADMIN'])
    const scope = `scope: {
      programmeCycleId: "${cycle.id}",
      expectedVersion: ${cycle.currentVersion},
      reason: "Probing the gate."
    }`

    // Both the whole-form write and a single-question one: `editTemplate` is
    // the one gate behind every form mutation, and this pins it there.
    expect(await messageOf(`mutation { admin { formTemplate { replace(input: {
      ${scope}, template: ${emptyFormTemplate}
    }) { success message } } } }`, administrator.cookie)).toBe(DENIED)

    expect(await messageOf(`mutation { admin { formTemplate { updateQuestion(input: {
      ${scope}, field: {
        stageKey: "applicant", fieldKey: "full_name",
        fieldType: TEXT, label: "Full name", requirement: REQUIRED
      }
    }) { success message } } } }`, administrator.cookie)).toBe(DENIED)
  })

  it('still lets an administrator past the casework gate', async () => {
    // The application id is invented, so this refuses — but for a business
    // reason, proving ADMIN kept STAFF_WRITE when it lost the cycle powers.
    const administrator = await signIn(['ADMIN'])
    const answer = await messageOf(`mutation { admin { intake { addInternalNote(input: {
      applicationId: "${crypto.randomUUID()}", note: "Probe."
    }) { success message } } } }`, administrator.cookie)
    expect(answer).not.toBe(DENIED)
  })

  it('lets the super-administrator create a cycle', async () => {
    const founder = await signIn(['SUPER_ADMIN'])
    const created = await graphql<any>(CREATE_CYCLE, { input: cycleInput() }, founder.cookie)
    expect(created.errors).toBeUndefined()
    const result = created.data.admin.programmeCycle.create
    expect(result.success, result.message ?? '').toBe(true)
  })
})
