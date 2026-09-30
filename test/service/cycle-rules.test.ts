/**
 * A cycle's configurable rules, written and applied: the rules its form states
 * about several answers at once, and the kinds of application it accepts with
 * their eligibility rules.
 *
 * Both are configuration the office authors, so both are held to the workflow
 * catalogue when a cycle is saved — a rule that could never hold or never fail
 * is refused with its key named, before any applicant meets it — and both are
 * read back exactly as written. The form rules are then applied the one place
 * they bite: an application that breaks one cannot be submitted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { completeAnswers, defaultTemplate } from '../support/form'
import {
  attachEvidence,
  createEnterprise,
  graphql,
  openCycle,
  saveAnswers,
  seedPolicyDocument,
  signIn,
  startApplication,
  submitApplication,
  submittedApplication,
  testPolicy,
} from '../support/api'
import { TEST_PIPELINE_ID } from '../support/pipeline'
import { env } from '../support/worker'
import { advance } from './support/stage'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

type Template = ReturnType<typeof defaultTemplate>
type Rule = NonNullable<Template['rules']>[number]

const CREATE = `mutation($input: ProgrammeCycleInput!) {
  admin { programmeCycle { create(input: $input) { success message response { head { id } } } } }
}`

const create = async (cookie: string, policy: Record<string, unknown>) => {
  const input = {
    cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    displayName: 'Rules test cycle',
    cycleYear: 2026,
    applicantGuidance: 'Guide.',
    opensAt: new Date(Date.now() + 86_400_000).toISOString(),
    closesAt: new Date(Date.now() + 172_800_000).toISOString(),
    policy: { ...testPolicy(), ...policy },
  }
  return (await graphql<any>(CREATE, { input }, cookie)).data.admin.programmeCycle.create as {
    success: boolean
    message: string | null
    response: { head: { id: string } } | null
  }
}

/** The fixture form with its first rule replaced, the way a mistaken author would. */
const withFirstRule = (change: (rule: Rule) => Rule) =>
  ({ formTemplate: defaultTemplate((template) => ({ ...template, rules: [change(template.rules![0]!), template.rules![1]!] })) })

const kinds = (...list: { kindKey: string; rules: { ruleType: string; paramsJson: string }[] }[]) =>
  ({ applicationKinds: list.map((kind) => ({ label: kind.kindKey, description: null, ...kind })) })

describe('a form’s rules about several answers, refused when authored wrongly', () => {
  const refusals: [string, Record<string, unknown>, string][] = [
    ['more than twenty', { formTemplate: defaultTemplate((template) => ({
      ...template,
      rules: Array.from({ length: 21 }, (_, index) => ({ ...template.rules![0]!, ruleKey: `RULE_${index}` })),
    })) }, 'A form may declare at most 20 rules about several answers.'],
    ['a malformed key', withFirstRule((rule) => ({ ...rule, ruleKey: 'grant-or-loan' })), 'grant-or-loan is not a valid rule key.'],
    ['a stage the form does not have', withFirstRule((rule) => ({ ...rule, stageKey: 'NOWHERE' })),
      'GRANT_OR_LOAN is shown on NOWHERE, which this form does not have.'],
    ['no message', withFirstRule((rule) => ({ ...rule, message: '  ' })), 'GRANT_OR_LOAN needs a message of at most 300 characters.'],
    ['too few questions', withFirstRule((rule) => ({ ...rule, operands: rule.operands.slice(0, 1) })),
      'GRANT_OR_LOAN reads 1 questions; AT_LEAST_ONE_TRUE reads 2 to 8.'],
    ['the same question twice', withFirstRule((rule) => ({ ...rule, operands: [rule.operands[0]!, rule.operands[0]!] })),
      'GRANT_OR_LOAN names the same question twice.'],
    ['a question the form does not ask', withFirstRule((rule) => ({
      ...rule, operands: [rule.operands[0]!, { fieldKey: 'WANTS_A_PONY', fieldType: 'BOOLEAN' }],
    })), 'GRANT_OR_LOAN reads WANTS_A_PONY, which this form does not ask.'],
    ['a question of a type it cannot read', withFirstRule((rule) => ({
      ...rule, operands: [rule.operands[0]!, { fieldKey: 'SEED_FUND_REQUESTED_PAISE', fieldType: 'MONEY_PAISE' }],
    })), 'GRANT_OR_LOAN cannot read SEED_FUND_REQUESTED_PAISE: AT_LEAST_ONE_TRUE reads BOOLEAN, ATTESTATION questions.'],
    ['a question answered inside a group', withFirstRule((rule) => ({
      ...rule,
      ruleType: 'DIFFERENT_VALUES',
      operands: [{ fieldKey: 'LOAN_BANK_FIRST_CHOICE', fieldType: 'SINGLE_CHOICE' }, { fieldKey: 'NAME', fieldType: 'TEXT' }],
    })), 'GRANT_OR_LOAN reads NAME, which is answered inside a group.'],
    ['a limit where none is taken', withFirstRule((rule) => ({ ...rule, limitValue: 5 })), 'GRANT_OR_LOAN takes no limit.'],
    ['a sum with no limit', withFirstRule((rule) => ({
      ...rule,
      ruleType: 'SUM_AT_MOST',
      operands: [{ fieldKey: 'SEED_FUND_REQUESTED_PAISE', fieldType: 'MONEY_PAISE' }],
    })), 'GRANT_OR_LOAN needs a limit of zero or more.'],
  ]

  it.each(refusals)('refuses %s', async (_name, policy, message) => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    expect(await create(cookie, policy)).toMatchObject({ success: false, message })
  })
})

describe('a cycle’s kinds of application, refused when authored wrongly', () => {
  const refusals: [string, Record<string, unknown>, string][] = [
    ['more than ten kinds', kinds(...Array.from({ length: 11 }, (_, index) => ({ kindKey: `KIND_${index}`, rules: [] }))),
      'A cycle may accept at most 10 kinds of application.'],
    ['settings that are not JSON', kinds({ kindKey: 'INITIAL', rules: [{ ruleType: 'MAX_APPLICATIONS_OF_KIND', paramsJson: '{max' }] }),
      'INITIAL: the MAX_APPLICATIONS_OF_KIND rule’s settings are incomplete or invalid.'],
    ['settings that are a list', kinds({ kindKey: 'INITIAL', rules: [{ ruleType: 'MAX_APPLICATIONS_OF_KIND', paramsJson: '[1]' }] }),
      'INITIAL: the MAX_APPLICATIONS_OF_KIND rule’s settings are incomplete or invalid.'],
    ['settings past what is read at all', kinds({ kindKey: 'INITIAL', rules: [{
      ruleType: 'MAX_APPLICATIONS_OF_KIND', paramsJson: `{"kind":"INITIAL","max":1,"pad":"${'x'.repeat(9000)}"}`,
    }] }), 'INITIAL: the MAX_APPLICATIONS_OF_KIND rule’s settings are incomplete or invalid.'],
    ['a rule naming a kind the cycle does not accept', kinds({ kindKey: 'INITIAL', rules: [{
      ruleType: 'NO_OPEN_APPLICATION_OF_KIND', paramsJson: JSON.stringify({ kind: 'EXPANSION' }),
    }] }), 'INITIAL: the NO_OPEN_APPLICATION_OF_KIND rule names EXPANSION, which this cycle does not accept.'],
    ['settings larger than a rule may keep', kinds({ kindKey: 'INITIAL', rules: [{
      ruleType: 'PRIOR_APPLICATION_HAS_FLAG', paramsJson: JSON.stringify({ flag: 'F'.repeat(5000) }),
    }] }), 'INITIAL: the PRIOR_APPLICATION_HAS_FLAG rule’s settings are too large.'],
    ['no pipeline', { pipelineId: ' ' }, 'Choose the pipeline this cycle’s applications are worked in.'],
  ]

  it.each(refusals)('refuses %s', async (_name, policy, message) => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    expect(await create(cookie, policy)).toMatchObject({ success: false, message })
  })
})

describe('the rules, read back', () => {
  it('returns the form’s rules with their operands in order, and each kind with its rules', async () => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    const created = await create(cookie, kinds(
      { kindKey: 'INITIAL', rules: [{ ruleType: 'NO_OPEN_APPLICATION_OF_KIND', paramsJson: JSON.stringify({ kind: 'INITIAL' }) }] },
      { kindKey: 'EXPANSION', rules: [
        { ruleType: 'PRIOR_APPLICATION_HAS_FLAG', paramsJson: JSON.stringify({ flag: 'COMPLETED', minMonthsSinceFlag: 12 }) },
        { ruleType: 'MAX_APPLICATIONS_OF_KIND', paramsJson: JSON.stringify({ kind: 'EXPANSION', max: 1 }) },
      ] },
    ))
    expect(created.success, created.message ?? '').toBe(true)
    const read = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) { success response {
      formRules { ruleKey ruleType stageKey message operands { fieldKey fieldType } }
      applicationKinds { kindKey rules { ruleType paramsJson } }
      formTemplate { rules { key type operandKeys } }
    } } } } }`, { id: created.response!.head.id }, cookie)
    const cycle = read.data.admin.programmeCycle.byId.response
    expect(cycle.formRules.map((rule: { ruleKey: string }) => rule.ruleKey)).toEqual(['DIFFERENT_BANKS', 'GRANT_OR_LOAN'])
    expect(cycle.formRules[1].operands).toEqual([
      { fieldKey: 'WANTS_GRANT', fieldType: 'BOOLEAN' },
      { fieldKey: 'WANTS_BANK_LOAN', fieldType: 'BOOLEAN' },
    ])
    expect(cycle.formTemplate.rules).toContainEqual({ key: 'GRANT_OR_LOAN', type: 'AT_LEAST_ONE_TRUE', operandKeys: ['WANTS_GRANT', 'WANTS_BANK_LOAN'] })
    const expansion = cycle.applicationKinds.find((kind: { kindKey: string }) => kind.kindKey === 'EXPANSION')
    expect(expansion.rules.map((rule: { paramsJson: string }) => JSON.parse(rule.paramsJson))).toEqual([
      { flag: 'COMPLETED', minMonthsSinceFlag: 12 },
      { kind: 'EXPANSION', max: 1 },
    ])
  })
})

describe('a form with no rules about several answers', () => {
  it('saves and reads back with none', async () => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    const { rules: _dropped, ...withoutRules } = defaultTemplate()
    const created = await create(cookie, { formTemplate: withoutRules })
    expect(created.success, created.message ?? '').toBe(true)
    const read = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) { response {
      formRules { ruleKey } formTemplate { rules { key } }
    } } } } }`, { id: created.response!.head.id }, cookie)
    expect(read.data.admin.programmeCycle.byId.response).toEqual({ formRules: [], formTemplate: { rules: [] } })
  })
})

describe('an application that breaks one', () => {
  const issuesFor = async (answers: Record<string, unknown>) => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const enterpriseId = await createEnterprise(applicant.cookie)
    const applicationId = await startApplication(applicant.cookie, enterpriseId, cycle.id)
    // A save keeps it: such a rule cannot hold part way through a form.
    await saveAnswers(applicant.cookie, applicationId, answers)
    const report = await graphql<any>(`query($id: ID!) { seb { application { validate(applicationId: $id) {
      success response { valid issues { stageKey field code message } }
    } } } }`, { id: applicationId }, applicant.cookie)
    return report.data.seb.application.validate.response.issues.filter((issue: { code: string }) => issue.code === 'FORM_RULE_VIOLATED')
  }

  it('is told to ask for a grant, a loan, or both, against the first question', async () => {
    expect(await issuesFor(completeAnswers({ WANTS_GRANT: false, SEED_FUND_REQUESTED_PAISE: null }))).toEqual([{
      stageKey: 'FINANCIAL', field: 'WANTS_GRANT', code: 'FORM_RULE_VIOLATED', message: 'Ask for a grant, a bank loan, or both.',
    }])
  })

  it('is told to choose two different banks, and only when a loan is asked for', async () => {
    const sameBank = { WANTS_BANK_LOAN: true, LOAN_BANK_FIRST_CHOICE: 'SBI', LOAN_BANK_SECOND_CHOICE: 'SBI', LOAN_AMOUNT_REQUESTED_PAISE: 50_000_000 }
    expect(await issuesFor(completeAnswers(sameBank))).toEqual([
      expect.objectContaining({ field: 'LOAN_BANK_FIRST_CHOICE', message: 'Choose two different banks.' }),
    ])
    expect(await issuesFor(completeAnswers({ ...sameBank, LOAN_BANK_SECOND_CHOICE: 'TGB' }))).toEqual([])
  })
})

describe('a cycle’s kinds of application, applied', () => {
  const START = `mutation($input: StartApplicationInput!) {
    seb { application { start(input: $input) { success message response { id phaseNumber applicationKind } } } }
  }`

  it('offers each kind with its reasons, starts only what is open, and numbers a later kind after the earlier', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie, kinds(
      { kindKey: 'INITIAL', rules: [{ ruleType: 'NO_OPEN_APPLICATION_OF_KIND', paramsJson: JSON.stringify({ kind: 'INITIAL' }) }] },
      { kindKey: 'EXPANSION', rules: [{ ruleType: 'PRIOR_APPLICATION_HAS_FLAG', paramsJson: JSON.stringify({ flag: 'COMPLETED' }) }] },
    ))
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const enterpriseId = await createEnterprise(applicant.cookie)
    const offered = async () => (await graphql<any>(`query($enterpriseId: ID!, $cycleId: ID!) {
      seb { application { applicationKinds(enterpriseId: $enterpriseId, programmeCycleId: $cycleId) {
        success response { kinds { kindKey eligible reasons } }
      } } }
    }`, { enterpriseId, cycleId: cycle.id }, applicant.cookie)).data.seb.application.applicationKinds.response.kinds
    const start = async (applicationKind: string) =>
      (await graphql<any>(START, { input: { enterpriseId, programmeCycleId: cycle.id, applicationKind } }, applicant.cookie))
        .data.seb.application.start

    expect(await offered()).toEqual([
      { kindKey: 'INITIAL', eligible: true, reasons: [] },
      { kindKey: 'EXPANSION', eligible: false, reasons: ['This needs an earlier application that reached the required outcome.'] },
    ])
    expect(await start('RENEWAL')).toMatchObject({ success: false, message: 'Select a kind of application this programme cycle offers.' })
    expect(await start('EXPANSION')).toMatchObject({ success: false, message: 'This needs an earlier application that reached the required outcome.' })

    const first = await start('INITIAL')
    expect(first).toMatchObject({ success: true, response: { phaseNumber: 1, applicationKind: 'INITIAL' } })
    // One open first application at a time.
    expect(await start('INITIAL')).toMatchObject({ success: false, message: 'You already have an application of this kind in progress.' })

    // Worked to completion, the first opens the second kind.
    const saved = await saveAnswers(applicant.cookie, first.response.id)
    await attachEvidence(first.response.id, applicant.userId)
    await submitApplication(applicant.cookie, first.response.id, { version: saved.currentVersion, statusVersion: saved.statusVersion })
    await advance(admin.cookie, first.response.id, 'TO_INDUSTRIES_COMMERCE')
    await advance(admin.cookie, first.response.id, 'COMPLETE_WITHOUT_LOAN')
    expect((await offered()).find((kind: { kindKey: string }) => kind.kindKey === 'EXPANSION')).toMatchObject({ eligible: true })
    expect(await start('EXPANSION')).toMatchObject({ success: true, response: { phaseNumber: 2, applicationKind: 'EXPANSION' } })
  })
})

describe('a kind’s rules, asked again when the history has moved', () => {
  const MAX_ONE = kinds({ kindKey: 'INITIAL', rules: [{ ruleType: 'MAX_APPLICATIONS_OF_KIND', paramsJson: JSON.stringify({ kind: 'INITIAL', max: 1 }) }] })
  const VERSIONS = 'success message response { id currentVersion statusVersion }'
  const submit = async (cookie: string, applicationId: string, saved: { currentVersion: number; statusVersion: number }) =>
    (await graphql<any>(`mutation($input: ApplicationVersionInput!) { seb { application { submit(input: $input) { ${VERSIONS} } } } }`, {
      input: { applicationId, expectedVersion: saved.currentVersion, expectedStatusVersion: saved.statusVersion },
    }, cookie)).data.seb.application.submit

  it('refuses to submit a draft whose kind the enterprise has since used up, and a second submission', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycleOne = await openCycle(admin.cookie, MAX_ONE)
    const cycleTwo = await openCycle(admin.cookie, MAX_ONE)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const enterpriseId = await createEnterprise(applicant.cookie)
    // Drafts are not counted, so both may be started.
    const first = await startApplication(applicant.cookie, enterpriseId, cycleOne.id)
    const second = await startApplication(applicant.cookie, enterpriseId, cycleTwo.id)
    const firstSaved = await saveAnswers(applicant.cookie, first)
    await attachEvidence(first, applicant.userId)
    const secondSaved = await saveAnswers(applicant.cookie, second)
    await attachEvidence(second, applicant.userId)

    const landed = await submit(applicant.cookie, first, firstSaved)
    expect(landed.success, landed.message ?? '').toBe(true)
    expect(await submit(applicant.cookie, first, landed.response))
      .toMatchObject({ success: false, message: 'The application changed or cannot be submitted in its current status.' })
    expect(await submit(applicant.cookie, second, secondSaved)).toMatchObject({
      success: false,
      message: 'Your enterprise has already made as many applications of this kind as the programme allows.',
    })
  })

  it('refuses to put back a removed draft once another of its kind is open, or once its cycle has closed', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const laterCycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const enterpriseId = await createEnterprise(applicant.cookie)
    const draft = await startApplication(applicant.cookie, enterpriseId, cycle.id)
    const removed = (await graphql<any>(`mutation($input: ApplicationDeletionInput!) { seb { application { softDeleteDraft(input: $input) { ${VERSIONS} } } } }`, {
      input: { applicationId: draft, expectedVersion: 1, expectedStatusVersion: 1, reason: 'Started by mistake.' },
    }, applicant.cookie)).data.seb.application.softDeleteDraft
    expect(removed.success, removed.message ?? '').toBe(true)
    const restore = async () => (await graphql<any>(`mutation($input: ApplicationVersionInput!) { seb { application { restoreDraft(input: $input) { ${VERSIONS} } } } }`, {
      input: { applicationId: draft, expectedVersion: removed.response.currentVersion, expectedStatusVersion: removed.response.statusVersion },
    }, applicant.cookie)).data.seb.application.restoreDraft

    // The removed draft still holds its place in its own cycle, so starting
    // again there is refused by the write rather than by a rule.
    await expect(startApplication(applicant.cookie, enterpriseId, cycle.id))
      .rejects.toThrow('already has an application in this programme cycle')
    // A removed draft is not open, so one may be started elsewhere — after
    // which the removed one cannot come back.
    await startApplication(applicant.cookie, enterpriseId, laterCycle.id)
    expect(await restore()).toMatchObject({ success: false, message: 'You already have an application of this kind in progress.' })

    await env.DB.prepare(`UPDATE seb_programme_cycle SET status = 'CLOSED', closes_at = ? WHERE id = ?`).bind(Date.now() - 1, cycle.id).run()
    expect(await restore()).toMatchObject({ success: false, message: 'The programme cycle is no longer open.' })
  })
})

describe('opening and archiving a cycle, refused', () => {
  const transition = async (cookie: string, verb: 'open' | 'close' | 'archive', input: Record<string, unknown>) =>
    (await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { ${verb}(input: $input) { success message response { head { currentVersion } } } } }
    }`, { input }, cookie)).data.admin.programmeCycle[verb]

  const draftReadyToOpen = async (cookie: string) => {
    const created = await create(cookie, {})
    expect(created.success, created.message ?? '').toBe(true)
    await seedPolicyDocument(created.response!.head.id)
    return created.response!.head.id
  }

  it('asks for a reason, and refuses a stale version', async () => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    const id = await draftReadyToOpen(cookie)
    expect(await transition(cookie, 'open', { id, expectedVersion: 1, reason: ' ' }))
      .toMatchObject({ success: false, message: 'Enter an opening reason.' })
    expect(await transition(cookie, 'open', { id, expectedVersion: 9, reason: 'Publish' }))
      .toMatchObject({ success: false, message: 'The record changed. Reload and try again.' })
  })

  it('refuses a closing time already past, and a pipeline this build can no longer read', async () => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    const id = await draftReadyToOpen(cookie)
    await env.DB.prepare('UPDATE seb_programme_cycle_version SET opens_at = ?, closes_at = ? WHERE programme_cycle_id = ?').bind(Date.now() - 2_000, Date.now() - 1_000, id).run()
    expect((await transition(cookie, 'open', { id, expectedVersion: 1, reason: 'Publish' })).message)
      .toMatch(/closing time has already passed/u)

    const second = await draftReadyToOpen(cookie)
    await env.DB.prepare(`UPDATE seb_pipeline_version SET definition = '{"schema": 1}'::jsonb WHERE pipeline_id = ?`).bind(TEST_PIPELINE_ID).run()
    expect(await transition(cookie, 'open', { id: second, expectedVersion: 1, reason: 'Publish' })).toMatchObject({
      success: false,
      message: 'The cycle’s pipeline no longer matches what this system can run. Publish it again.',
    })
  })

  it('refuses a form this build can no longer read', async () => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    const id = await draftReadyToOpen(cookie)
    await env.DB.prepare(`UPDATE seb_programme_cycle_form_field SET pattern = '(' WHERE programme_cycle_id = ? AND field_key = 'NAME'`).bind(id).run()
    expect(await transition(cookie, 'open', { id, expectedVersion: 1, reason: 'Publish' }))
      .toMatchObject({ success: false, message: 'The cycle’s questions cannot be read. Fix them before opening.' })
  })

  it('refuses to archive a cycle with a draft still in it', async () => {
    const { cookie } = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    await startApplication(applicant.cookie, await createEnterprise(applicant.cookie), cycle.id)
    const closed = await transition(cookie, 'close', { id: cycle.id, expectedVersion: cycle.currentVersion, reason: 'Window over.' })
    expect(closed.success, closed.message ?? '').toBe(true)
    expect(await transition(cookie, 'archive', { id: cycle.id, expectedVersion: closed.response.head.currentVersion, reason: 'Done.' }))
      .toMatchObject({ success: false, message: 'Finish the cycle’s active applications before archiving it.' })
  })
})

describe('a stored form this build can no longer read', () => {
  it('refuses the form, an upload and a new start in words', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const draft = await startApplication(applicant.cookie, await createEnterprise(applicant.cookie), cycle.id)
    // A pattern no engine can compile: rows a later build no longer accepts.
    await env.DB.prepare(`UPDATE seb_programme_cycle_form_field SET pattern = '(' WHERE programme_cycle_id = ? AND field_key = 'NAME'`)
      .bind(cycle.id).run()

    const UNREADABLE = 'The form this application was filled against could not be read.'
    const seb = async (operation: string, variables: Record<string, unknown>) =>
      (await graphql<any>(operation, variables, applicant.cookie)).data.seb.application
    expect((await seb(`query($id: ID!) { seb { application { formTemplate(applicationId: $id) { success message } } } }`, { id: draft })).formTemplate)
      .toEqual({ success: false, message: UNREADABLE })
    expect((await seb(`mutation($input: IssueDocumentUploadInput!) { seb { application { issueDocumentUpload(input: $input) { success message } } } }`, {
      input: {
        applicationId: draft, fieldKey: 'DPR', expectedDocumentVersion: 0, originalFilename: 'dpr.pdf',
        contentType: 'application/pdf', sizeBytes: 10, checksumSha256: 'A'.repeat(43) + '=',
      },
    })).issueDocumentUpload).toEqual({ success: false, message: 'This application’s form is unavailable.' })

    // And nobody new can start against it.
    const other = await signIn({ roles: ['APPLICANT'] })
    await expect(startApplication(other.cookie, await createEnterprise(other.cookie), cycle.id))
      .rejects.toThrow('This programme cycle has no application form yet.')
  })
})

describe('an application the caller does not own', () => {
  it('refuses another applicant’s form, and a copy to somebody not signed in', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const owner = await signIn({ roles: ['APPLICANT'] })
    const draft = await startApplication(owner.cookie, await createEnterprise(owner.cookie), cycle.id)
    const stranger = await signIn({ roles: ['APPLICANT'] })
    const form = await graphql<any>(`query($id: ID!) { seb { application { formTemplate(applicationId: $id) { success message } } } }`, { id: draft }, stranger.cookie)
    expect(form.data.seb.application.formTemplate).toMatchObject({ success: false })
    const copy = await graphql<any>(`query($id: ID!) { seb { application { submittedCopy(applicationId: $id) { success message } } } }`, { id: draft })
    expect(copy.data.seb.application.submittedCopy).toMatchObject({ success: false })
  })
})

describe('a submitted file whose stored form this build can no longer read', () => {
  it('still opens for the office, without the answers it cannot decode', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const { applicationId } = await submittedApplication(applicant.cookie, applicant.userId, cycle.id)
    await env.DB.prepare(`UPDATE seb_programme_cycle_form_field SET pattern = '(' WHERE programme_cycle_id = ? AND field_key = 'NAME'`)
      .bind(cycle.id).run()
    const body = await graphql<any>(`query($id: ID!) { admin { intake { workspace(applicationId: $id) {
      success message response { formTemplate { stages { key } } submissionChanges { toSubmissionNumber } documents { id } }
    } } } }`, { id: applicationId }, admin.cookie)
    const workspace = body.data.admin.intake.workspace
    expect(workspace.success, workspace.message ?? '').toBe(true)
    expect(workspace.response).toMatchObject({ formTemplate: null, submissionChanges: [] })
    expect(workspace.response.documents.length).toBeGreaterThan(0)
  })
})

describe('the grant ceiling on the applicant’s form', () => {
  const ceilingOf = async (policy: Record<string, unknown>) => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie, policy)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const draft = await startApplication(applicant.cookie, await createEnterprise(applicant.cookie), cycle.id)
    const body = await graphql<any>(`query($id: ID!) { seb { application { formTemplate(applicationId: $id) {
      success response { grantCeilingPaise }
    } } } }`, { id: draft }, applicant.cookie)
    return body.data.seb.application.formTemplate.response.grantCeilingPaise
  }

  it('states a per-application ceiling, the one validation refuses above', async () => {
    expect(await ceilingOf({
      fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '20000000', fundingCeilingScope: 'APPLICATION',
    })).toBe('20000000')
  })

  it('states none while the ceiling is unresolved, or when it caps something other than one application', async () => {
    expect(await ceilingOf({})).toBeNull()
    expect(await ceilingOf({
      fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '20000000', fundingCeilingScope: 'ENTERPRISE',
    })).toBeNull()
  })
})
