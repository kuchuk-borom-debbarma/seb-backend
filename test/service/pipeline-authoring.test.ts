/**
 * Authoring pipelines: the draft, its publishing, and who works each stage.
 *
 * Three properties carry this suite. A published version never changes, so
 * every edit is a draft replaced whole and guarded by its revision. What is
 * published is exactly what was checked. And handing a stage to a role is
 * bounded like an invitation: nobody attaches a role above themselves, or to a
 * stage they do not work.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { graphql, openCycle, permissionsOn, signIn } from '../support/api'
import { examplePipeline } from '../../src/services/pipeline/example'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const DENIED = 'You do not have permission to do that.'
const STALE = 'The record changed. Reload and try again.'

const DETAIL = `success message response {
  id key name currentPublishedVersion retiredAt
  versions { version status revision changeNote }
  draft { version revision definitionJson problems { path message } }
  published { version definitionJson }
  stages { stageKey ownersVersion owners { roleKey } }
}`

const author = () => signIn({ roles: ['SUPER_ADMIN'] })

const create = async (cookie: string, input: Record<string, unknown>) =>
  (await graphql<any>(`mutation($input: CreatePipelineInput!) {
    admin { pipeline { create(input: $input) { ${DETAIL} } } }
  }`, { input }, cookie)).data!.admin.pipeline.create

const save = async (cookie: string, pipelineId: string, expectedRevision: number, definition: unknown) =>
  (await graphql<any>(`mutation($input: SavePipelineDraftInput!) {
    admin { pipeline { saveDraft(input: $input) { ${DETAIL} } } }
  }`, { input: {
    pipelineId,
    expectedRevision,
    definition: typeof definition === 'string' ? definition : JSON.stringify(definition),
  } }, cookie)).data!.admin.pipeline.saveDraft

const publish = async (cookie: string, pipelineId: string, expectedRevision: number) =>
  (await graphql<any>(`mutation($input: PublishPipelineInput!) {
    admin { pipeline { publish(input: $input) { ${DETAIL} } } }
  }`, { input: { pipelineId, expectedRevision, changeNote: 'First route.' } }, cookie)).data!.admin.pipeline.publish

const setOwners = async (
  cookie: string,
  input: { pipelineId: string; stageKey: string; expectedOwnersVersion: number; roleKeys: string[] },
) => (await graphql<any>(`mutation($input: SetPipelineStageOwnersInput!) {
    admin { pipeline { setStageOwners(input: $input) { ${DETAIL} } } }
  }`, { input: { ...input, reason: 'The office named its officers.' } }, cookie)).data!.admin.pipeline.setStageOwners

const auditActions = async (entityId: string): Promise<string[]> =>
  ((await env.DB.prepare(
    'SELECT action FROM core_audit_event WHERE entity_id = ? ORDER BY created_at, action',
  ).bind(entityId).all<{ action: string }>()).results).map((row) => row.action)

const roleKeyOf = async (roleId: string): Promise<string> =>
  (await env.DB.prepare('SELECT key FROM core_role WHERE id = ?').bind(roleId).first<string>('key'))!

/** A pipeline created from the example and published as version 1. */
const publishedExample = async (cookie: string, key = 'MISSION_SEP') => {
  const created = await create(cookie, { key, name: 'Mission SEP', startFromExample: true })
  expect(created.success, created.message).toBe(true)
  const published = await publish(cookie, created.response.id, 1)
  expect(published.success, published.message).toBe(true)
  return published.response
}

describe('a draft', () => {
  it('starts blank, with the problems that stop it being published', async () => {
    const { cookie } = await author()
    const created = await create(cookie, { key: 'BLANK', name: 'Blank route' })
    expect(created.success, created.message).toBe(true)
    expect(created.response.draft).toMatchObject({ version: 1, revision: 1 })
    expect(created.response.draft.problems.length).toBeGreaterThan(0)
    expect(created.response.stages.map((stage: any) => stage.stageKey)).toEqual(['FIRST_STAGE'])
    expect(await auditActions(created.response.id)).toEqual(['SEB.PIPELINE_CREATED'])

    const again = await create(cookie, { key: 'BLANK', name: 'Another' })
    expect(again).toMatchObject({ success: false, message: 'That pipeline key is already in use.' })
  })

  it('is replaced whole, guarded by its revision', async () => {
    const { cookie } = await author()
    const { response } = await create(cookie, { key: 'ROUTE', name: 'Route' })
    const saved = await save(cookie, response.id, 1, examplePipeline)
    expect(saved.success, saved.message).toBe(true)
    expect(saved.response.draft).toMatchObject({ revision: 2, problems: [] })
    // Every stage the document names now has an identity owners can attach to.
    expect(saved.response.stages.map((stage: any) => stage.stageKey).sort())
      .toEqual([...examplePipeline.stages.map((stage) => stage.key), 'FIRST_STAGE'].sort())

    // The second author, still holding revision 1, is told it changed.
    expect(await save(cookie, response.id, 1, examplePipeline)).toMatchObject({ success: false, message: STALE })
    expect(await auditActions(response.id)).toEqual(['SEB.PIPELINE_CREATED', 'SEB.PIPELINE_DRAFT_SAVED'])
  })

  it('refuses a document that is not a pipeline, and keeps one that merely has problems', async () => {
    const { cookie } = await author()
    const { response } = await create(cookie, { key: 'ROUTE', name: 'Route' })
    const notJson = await save(cookie, response.id, 1, '{ not json')
    expect(notJson).toMatchObject({ success: false })
    expect(notJson.message).toContain('not valid JSON')
    const notPipeline = await save(cookie, response.id, 1, { schema: 1 })
    expect(notPipeline.success).toBe(false)
    expect(notPipeline.message).toContain('The pipeline could not be read')

    // A route with a stage nothing leaves still parses, so it is kept.
    const halfBuilt = { ...examplePipeline, stages: examplePipeline.stages.map((stage) => ({ ...stage, actions: [] })) }
    const kept = await save(cookie, response.id, 1, halfBuilt)
    expect(kept.success, kept.message).toBe(true)
    expect(kept.response.draft.problems.length).toBeGreaterThan(0)
  })

  it('is checked without saving', async () => {
    const { cookie } = await author()
    const checked = await graphql<any>(`query($definition: String!) {
      admin { pipeline { validateDraft(definition: $definition) { success response { problems { path message } } } } }
    }`, { definition: JSON.stringify({ ...examplePipeline, initialStageKey: 'NOWHERE' }) }, cookie)
    const problems = checked.data!.admin.pipeline.validateDraft.response.problems
    expect(problems).toContainEqual({ path: 'initialStageKey', message: 'No stage is called NOWHERE.' })

    const clean = await graphql<any>(`query($definition: String!) {
      admin { pipeline { validateDraft(definition: $definition) { response { problems { path } } } } }
    }`, { definition: JSON.stringify(examplePipeline) }, cookie)
    expect(clean.data!.admin.pipeline.validateDraft.response.problems).toEqual([])
  })
})

describe('publishing', () => {
  it('refuses a draft with problems, listing them', async () => {
    const { cookie } = await author()
    const { response } = await create(cookie, { key: 'BLANK', name: 'Blank' })
    const refused = await publish(cookie, response.id, 1)
    expect(refused.success).toBe(false)
    expect(refused.message).toContain('This pipeline cannot be published yet:')
    expect(refused.message).toContain('Nothing moves an application out of FIRST_STAGE.')
  })

  it('freezes the draft, materialises its stages, and starts the next draft on the next save', async () => {
    const { cookie } = await author()
    const published = await publishedExample(cookie)
    expect(published).toMatchObject({ currentPublishedVersion: 1, draft: null })
    expect(published.versions).toEqual([{ version: 1, status: 'PUBLISHED', revision: 1, changeNote: 'First route.' }])
    expect(JSON.parse(published.published.definitionJson)).toEqual(examplePipeline)

    const stages = (await env.DB.prepare(
      'SELECT stage_key, position, is_initial FROM seb_pipeline_version_stage WHERE pipeline_id = ? AND version = 1 ORDER BY position',
    ).bind(published.id).all<{ stage_key: string; position: number; is_initial: boolean }>()).results
    expect(stages.map((stage) => stage.stage_key)).toEqual(examplePipeline.stages.map((stage) => stage.key))
    expect(stages.filter((stage) => stage.is_initial).map((stage) => stage.stage_key)).toEqual([examplePipeline.initialStageKey])

    // Revision 1 no longer names a draft: publishing it again is stale.
    expect(await publish(cookie, published.id, 1)).toMatchObject({ success: false, message: STALE })

    // Revision 0 starts the next draft, numbered one higher.
    const next = await save(cookie, published.id, 0, examplePipeline)
    expect(next.success, next.message).toBe(true)
    expect(next.response.draft).toMatchObject({ version: 2, revision: 1 })
    expect(next.response.currentPublishedVersion).toBe(1)
    // With a draft open, starting another is stale.
    expect(await save(cookie, published.id, 0, examplePipeline)).toMatchObject({ success: false, message: STALE })

    const discarded = await graphql<any>(`mutation($input: DiscardPipelineDraftInput!) {
      admin { pipeline { discardDraft(input: $input) { ${DETAIL} } } }
    }`, { input: { pipelineId: published.id, expectedRevision: 1 } }, cookie)
    expect(discarded.data!.admin.pipeline.discardDraft.response).toMatchObject({ draft: null, currentPublishedVersion: 1 })
    expect(await auditActions(published.id)).toEqual(expect.arrayContaining([
      'SEB.PIPELINE_CREATED', 'SEB.PIPELINE_PUBLISHED', 'SEB.PIPELINE_DRAFT_SAVED', 'SEB.PIPELINE_DRAFT_DISCARDED',
    ]))
  })

  it('retires a pipeline, after which it neither changes nor is offered to cycles', async () => {
    const { cookie } = await author()
    const published = await publishedExample(cookie)
    const retired = await graphql<any>(`mutation($input: RetirePipelineInput!) {
      admin { pipeline { retire(input: $input) { ${DETAIL} } } }
    }`, { input: { pipelineId: published.id, reason: 'Replaced by the 2027 route.' } }, cookie)
    expect(retired.data!.admin.pipeline.retire.response.retiredAt).not.toBeNull()
    expect((await save(cookie, published.id, 0, examplePipeline)).success).toBe(false)

    const choices = await graphql<any>(`query { admin { pipeline { publishedChoices { response { key } } } } }`, {}, cookie)
    expect(choices.data!.admin.pipeline.publishedChoices.response.map((choice: any) => choice.key))
      .not.toContain('MISSION_SEP')
  })
})

describe('the pipeline permissions', () => {
  it('guard each act with its own pair', async () => {
    const { cookie: nobody } = await signIn({ permissions: [['application', 'read']] })
    const list = await graphql<any>(`query { admin { pipeline { list { success message } } } }`, {}, nobody)
    expect(list.data!.admin.pipeline.list).toEqual({ success: false, message: DENIED })

    const { cookie: reader } = await signIn({ permissions: [['pipeline', 'read']] })
    expect(await create(reader, { key: 'ROUTE', name: 'Route' })).toMatchObject({ success: false, message: DENIED })
    const catalogue = await graphql<any>(`query { admin { pipeline { catalogue { success response {
      effects { key permission params { name kind required } } exampleDefinitionJson
    } } } } }`, {}, reader)
    const served = catalogue.data!.admin.pipeline.catalogue.response
    expect(served.effects.map((effect: any) => effect.key)).toContain('MOVE_BY_CHOICE')
    expect(JSON.parse(served.exampleDefinitionJson)).toEqual(examplePipeline)

    const { cookie: drafter } = await signIn({ permissions: [['pipeline', 'create'], ['pipeline', 'update']] })
    const created = await create(drafter, { key: 'ROUTE', name: 'Route', startFromExample: true })
    expect(created.success, created.message).toBe(true)
    // Writing a draft is not publishing it.
    expect(await publish(drafter, created.response.id, 1)).toMatchObject({ success: false, message: DENIED })
  })
})

describe('who works a stage', () => {
  it('changes at once, with history, guarded by the owner list’s version', async () => {
    const { cookie } = await author()
    const pipeline = await publishedExample(cookie)
    const { roleId } = await signIn({ permissions: [['stage', 'read'], ['stage', 'advance']] })
    const ttc = await roleKeyOf(roleId)

    const set = await setOwners(cookie, { pipelineId: pipeline.id, stageKey: 'TTC', expectedOwnersVersion: 0, roleKeys: [ttc] })
    expect(set.success, set.message).toBe(true)
    expect(set.response.stages.find((stage: any) => stage.stageKey === 'TTC'))
      .toEqual({ stageKey: 'TTC', ownersVersion: 1, owners: [{ roleKey: ttc }] })
    expect(await setOwners(cookie, { pipelineId: pipeline.id, stageKey: 'TTC', expectedOwnersVersion: 0, roleKeys: [] }))
      .toMatchObject({ success: false, message: STALE })

    const cleared = await setOwners(cookie, { pipelineId: pipeline.id, stageKey: 'TTC', expectedOwnersVersion: 1, roleKeys: [] })
    expect(cleared.response.stages.find((stage: any) => stage.stageKey === 'TTC').owners).toEqual([])
    // Closed, not deleted: who worked it stays answerable.
    const history = await env.DB.prepare(
      'SELECT removed_at FROM seb_pipeline_stage_owner WHERE pipeline_id = ? AND stage_key = ?',
    ).bind(pipeline.id, 'TTC').all<{ removed_at: unknown }>()
    expect(history.results).toHaveLength(1)
    expect(history.results[0]!.removed_at).not.toBeNull()
    expect(await auditActions(`${pipeline.id}/TTC`)).toEqual([
      'SEB.PIPELINE_STAGE_OWNERS_CHANGED', 'SEB.PIPELINE_STAGE_OWNERS_CHANGED',
    ])
  })

  it('is bounded like an invitation: the stage must be yours and the role within your authority', async () => {
    const { cookie: root } = await author()
    const pipeline = await publishedExample(root)
    const bankPairs = [['stage', 'read'], ['stage', 'advance'], ['stage', 'decide']] as const
    const assigner = await signIn({ permissions: [['pipeline', 'assign'], ...bankPairs] })
    const assignerRole = await roleKeyOf(assigner.roleId)
    const peer = await roleKeyOf((await signIn({ permissions: [...bankPairs] })).roleId)
    const above = await roleKeyOf((await signIn({ permissions: [...bankPairs, ['stage', 'close']] })).roleId)

    // Not the assigner's stage yet.
    expect(await setOwners(assigner.cookie, { pipelineId: pipeline.id, stageKey: 'SBI_BANK', expectedOwnersVersion: 0, roleKeys: [peer] }))
      .toMatchObject({ success: false, message: DENIED })

    await setOwners(root, { pipelineId: pipeline.id, stageKey: 'SBI_BANK', expectedOwnersVersion: 0, roleKeys: [assignerRole] })
    // Now theirs, but a role holding more than they do is beyond them.
    expect(await setOwners(assigner.cookie, {
      pipelineId: pipeline.id, stageKey: 'SBI_BANK', expectedOwnersVersion: 1, roleKeys: [assignerRole, above],
    })).toMatchObject({ success: false, message: DENIED })
    const within = await setOwners(assigner.cookie, {
      pipelineId: pipeline.id, stageKey: 'SBI_BANK', expectedOwnersVersion: 1, roleKeys: [assignerRole, peer],
    })
    expect(within.success, within.message).toBe(true)
    // Still not the other bank's stage.
    expect(await setOwners(assigner.cookie, { pipelineId: pipeline.id, stageKey: 'TGB_BANK', expectedOwnersVersion: 0, roleKeys: [peer] }))
      .toMatchObject({ success: false, message: DENIED })
    expect(await setOwners(root, { pipelineId: pipeline.id, stageKey: 'TGB_BANK', expectedOwnersVersion: 0, roleKeys: ['NO_SUCH_ROLE'] }))
      .toMatchObject({ success: false, message: 'No role is called NO_SUCH_ROLE.' })
  })
})

describe('the invitation ceiling', () => {
  it('offers a role only to somebody who works every stage it works', async () => {
    const { cookie: root } = await author()
    const pipeline = await publishedExample(root)
    const bankPairs = [['stage', 'read'], ['stage', 'advance']] as const
    const sbi = await roleKeyOf((await signIn({ permissions: [...bankPairs] })).roleId)
    const tgb = await roleKeyOf((await signIn({ permissions: [...bankPairs] })).roleId)
    const inviter = await signIn({ permissions: [['role', 'invite'], ...bankPairs] })
    const inviterRole = await roleKeyOf(inviter.roleId)
    await setOwners(root, { pipelineId: pipeline.id, stageKey: 'SBI_BANK', expectedOwnersVersion: 0, roleKeys: [sbi, inviterRole] })
    await setOwners(root, { pipelineId: pipeline.id, stageKey: 'TGB_BANK', expectedOwnersVersion: 0, roleKeys: [tgb] })

    const offered = await graphql<any>(`query { access { invitableRoles { success response { key } } } }`, {}, inviter.cookie)
    const keys = offered.data!.access.invitableRoles.response.map((role: any) => role.key)
    // Identical permissions; only the stage tells them apart.
    expect(keys).toContain(sbi)
    expect(keys).not.toContain(tgb)

    // And the mutation refuses what the list leaves out.
    const { userId: applicant } = await signIn({ roles: ['APPLICANT'] })
    const invite = (roleKey: string) => graphql<any>(`mutation($input: InviteRoleInput!) {
      access { inviteRole(input: $input) { success message } }
    }`, { input: { userId: applicant, roleKey, reason: 'Joining the bank desk.' } }, inviter.cookie)
    expect((await invite(tgb)).data!.access.inviteRole)
      .toEqual({ success: false, message: 'You cannot invite somebody to that role.' })
  })
})

describe('a cycle choosing and pinning a pipeline', () => {
  it('opens only when its questions fit the pipeline, and pins the version it checked', async () => {
    const { cookie } = await author()
    // The example reads the default form's answers, so it fits.
    const fits = await publishedExample(cookie, 'FITS')
    const cycle = await openCycle(cookie, { pipelineId: fits.id })
    const pinned = await env.DB.prepare(
      'SELECT pipeline_version FROM seb_programme_cycle_version WHERE programme_cycle_id = ? AND version = ?',
    ).bind(cycle.id, cycle.currentVersion).first<number>('pipeline_version')
    expect(pinned).toBe(1)

    // A route that reads a question the form does not ask cannot be pinned.
    const misfit = JSON.parse(JSON.stringify(examplePipeline))
    const approve = misfit.stages[1].actions.find((action: any) => action.availableWhen.some((condition: any) => condition.source === 'ANSWER'))
    approve.availableWhen.find((condition: any) => condition.source === 'ANSWER').key = 'NOT_A_QUESTION'
    const created = await create(cookie, { key: 'MISFIT', name: 'Misfit' })
    await save(cookie, created.response.id, 1, misfit)
    expect((await publish(cookie, created.response.id, 2)).success).toBe(true)
    await expect(openCycle(cookie, { pipelineId: created.response.id }))
      .rejects.toThrow('do not fit its pipeline: The form asks no question called NOT_A_QUESTION.')
  })

  it('needs the authority to read pipelines, and a published one', async () => {
    const { cookie: root } = await author()
    const draftOnly = await create(root, { key: 'DRAFT_ONLY', name: 'Draft only', startFromExample: true })
    await expect(openCycle(root, { pipelineId: draftOnly.response.id }))
      .rejects.toThrow('Choose a pipeline that has been published and has not been retired.')

    const { cookie: cycleOnly } = await signIn({ permissions: permissionsOn('programme_cycle') })
    await expect(openCycle(cycleOnly)).rejects.toThrow(DENIED)
  })
})

/*
 * Every refusal an author can meet, each in the words the editor shows. The
 * suites above prove the happy path and the ceilings; these prove that a
 * missing pipeline, a retired one, a stale screen and an out-of-bounds input
 * are each refused before anything is written.
 */
const discard = async (cookie: string, pipelineId: string, expectedRevision: number) =>
  (await graphql<any>(`mutation($input: DiscardPipelineDraftInput!) {
    admin { pipeline { discardDraft(input: $input) { ${DETAIL} } } }
  }`, { input: { pipelineId, expectedRevision } }, cookie)).data!.admin.pipeline.discardDraft

const retire = async (cookie: string, pipelineId: string, reason: string) =>
  (await graphql<any>(`mutation($input: RetirePipelineInput!) {
    admin { pipeline { retire(input: $input) { ${DETAIL} } } }
  }`, { input: { pipelineId, reason } }, cookie)).data!.admin.pipeline.retire

const publishNoted = async (cookie: string, pipelineId: string, expectedRevision: number, changeNote: string) =>
  (await graphql<any>(`mutation($input: PublishPipelineInput!) {
    admin { pipeline { publish(input: $input) { ${DETAIL} } } }
  }`, { input: { pipelineId, expectedRevision, changeNote } }, cookie)).data!.admin.pipeline.publish

const ownersWith = async (cookie: string, input: Record<string, unknown>) =>
  (await graphql<any>(`mutation($input: SetPipelineStageOwnersInput!) {
    admin { pipeline { setStageOwners(input: $input) { ${DETAIL} } } }
  }`, { input }, cookie)).data!.admin.pipeline.setStageOwners

const MISSING = 'That could not be found.'
const NOWHERE = '00000000-0000-4000-8000-000000000000'

describe('the reads, as the editor makes them', () => {
  it('lists every pipeline with its draft, finds one by key, and names a missing one', async () => {
    const { cookie } = await author()
    const published = await publishedExample(cookie)
    await create(cookie, { key: 'SECOND', name: 'Second route' })
    const list = await graphql<any>(`query { admin { pipeline { list { success response { key currentPublishedVersion draftVersion } } } } }`, {}, cookie)
    // The fixture pipeline every suite seeds is listed too.
    expect(list.data!.admin.pipeline.list.response).toEqual(expect.arrayContaining([
      { key: 'MISSION_SEP', currentPublishedVersion: 1, draftVersion: null },
      { key: 'SECOND', currentPublishedVersion: null, draftVersion: 1 },
    ]))

    const byKey = (key: string) => graphql<any>(`query($key: String!) { admin { pipeline { byKey(key: $key) { ${DETAIL} } } } }`, { key }, cookie)
    expect((await byKey('MISSION_SEP')).data!.admin.pipeline.byKey.response).toMatchObject({ id: published.id, published: { version: 1 } })
    expect((await byKey('NOPE')).data!.admin.pipeline.byKey).toMatchObject({ success: false, message: MISSING })

    const choices = await graphql<any>(`query { admin { pipeline { publishedChoices { success response { key } } } } }`, {}, cookie)
    const choiceKeys = choices.data!.admin.pipeline.publishedChoices.response.map((choice: { key: string }) => choice.key)
    expect(choiceKeys).toContain('MISSION_SEP')
    expect(choiceKeys).not.toContain('SECOND')
  })

  it('checks a document that does not parse', async () => {
    const { cookie } = await author()
    const validate = async (definition: string) =>
      (await graphql<any>(`query($definition: String!) { admin { pipeline { validateDraft(definition: $definition) {
        success response { problems { path message } }
      } } } }`, { definition }, cookie)).data!.admin.pipeline.validateDraft.response.problems
    expect(await validate('[')).toEqual([{ path: '(definition)', message: 'The pipeline is not valid JSON.' }])
    expect((await validate('{"schema": 2}')).length).toBeGreaterThan(0)
  })

  it('refuses every read to somebody who cannot read pipelines', async () => {
    const { cookie } = await signIn({ permissions: [['application', 'read']] })
    const queries = [
      'byKey(key: "MISSION_SEP") { success message }',
      'validateDraft(definition: "{}") { success message }',
      'catalogue { success message }',
      'publishedChoices { success message }',
    ]
    for (const query of queries) {
      const answer = await graphql<any>(`query { admin { pipeline { ${query} } } }`, {}, cookie)
      expect(Object.values(answer.data!.admin.pipeline)[0], query).toEqual({ success: false, message: DENIED })
    }
  })
})

describe('creating, saving, publishing and retiring, refused', () => {
  it('refuses a malformed key, a missing name and an overlong description', async () => {
    const { cookie } = await author()
    expect(await create(cookie, { key: 'lower', name: 'Route' }))
      .toMatchObject({ success: false, message: 'A pipeline key is 2–64 capital letters, digits or underscores, starting with a letter.' })
    expect(await create(cookie, { key: 'ROUTE', name: '   ' }))
      .toMatchObject({ success: false, message: 'Name the pipeline, in at most 120 characters.' })
    expect(await create(cookie, { key: 'ROUTE', name: 'Route', description: 'x'.repeat(1001) }))
      .toMatchObject({ success: false, message: 'A description is at most 1000 characters.' })
  })

  it('refuses writes to a pipeline that does not exist', async () => {
    const { cookie } = await author()
    expect(await save(cookie, NOWHERE, 1, examplePipeline)).toMatchObject({ success: false, message: MISSING })
    expect(await publish(cookie, NOWHERE, 1)).toMatchObject({ success: false, message: MISSING })
    expect(await discard(cookie, NOWHERE, 1)).toMatchObject({ success: false, message: MISSING })
    expect(await retire(cookie, NOWHERE, 'Replaced.')).toMatchObject({ success: false, message: MISSING })
    expect(await setOwners(cookie, { pipelineId: NOWHERE, stageKey: 'TTC', expectedOwnersVersion: 0, roleKeys: [] }))
      .toMatchObject({ success: false, message: MISSING })
  })

  it('starts a new draft only when there is none, and publishes only the revision checked', async () => {
    const { cookie } = await author()
    const { response } = await create(cookie, { key: 'ROUTE', name: 'Route', startFromExample: true })
    // Revision 0 means "start the next draft", which is stale while one exists.
    expect(await save(cookie, response.id, 0, examplePipeline)).toMatchObject({ success: false, message: STALE })
    expect(await publish(cookie, response.id, 7)).toMatchObject({ success: false, message: STALE })
    expect(await publishNoted(cookie, response.id, 1, 'x'.repeat(501)))
      .toMatchObject({ success: false, message: 'A change note is at most 500 characters.' })
    const published = await publishNoted(cookie, response.id, 1, 'First route.')
    expect(published.success, published.message).toBe(true)
    // No draft to replace any more; saving at a revision now is stale too.
    expect(await save(cookie, response.id, 1, examplePipeline)).toMatchObject({ success: false, message: STALE })
    expect(await discard(cookie, response.id, 1)).toMatchObject({ success: false, message: STALE })
  })

  it('throws a draft away, keeping what was published', async () => {
    const { cookie } = await author()
    const published = await publishedExample(cookie)
    const next = await save(cookie, published.id, 0, examplePipeline)
    expect(next.response.draft).toMatchObject({ version: 2, revision: 1 })
    expect(await discard(cookie, published.id, 2)).toMatchObject({ success: false, message: STALE })
    const discarded = await discard(cookie, published.id, 1)
    expect(discarded.success, discarded.message).toBe(true)
    expect(discarded.response).toMatchObject({ draft: null, currentPublishedVersion: 1 })
    expect(await auditActions(published.id)).toContain('SEB.PIPELINE_DRAFT_DISCARDED')
  })

  it('refuses a retirement without a reason, a second one, and any change afterwards', async () => {
    const { cookie } = await author()
    const published = await publishedExample(cookie)
    expect(await retire(cookie, published.id, ' ')).toMatchObject({ success: false, message: 'Say why the pipeline is being retired.' })
    expect((await retire(cookie, published.id, 'Replaced by the 2027 route.')).success).toBe(true)
    expect(await retire(cookie, published.id, 'Again.')).toMatchObject({ success: false, message: 'This pipeline is already retired.' })
    const retired = 'This pipeline is retired, so it can no longer change.'
    expect(await save(cookie, published.id, 0, examplePipeline)).toMatchObject({ success: false, message: retired })
    expect(await publish(cookie, published.id, 1)).toMatchObject({ success: false, message: retired })
  })
})

describe('who works a stage, refused', () => {
  it('refuses without a reason, beyond the limit, at a stage that is not there, stale, or unchanged', async () => {
    const { cookie } = await author()
    const pipeline = await publishedExample(cookie)
    const base = { pipelineId: pipeline.id, stageKey: 'TTC', expectedOwnersVersion: 0, roleKeys: [] as string[], reason: 'Why not.' }
    expect(await ownersWith(cookie, { ...base, reason: ' ' }))
      .toMatchObject({ success: false, message: 'Say why who works this stage is changing.' })
    expect(await ownersWith(cookie, { ...base, roleKeys: Array.from({ length: 33 }, (_, index) => `ROLE_${index}`) }))
      .toMatchObject({ success: false, message: 'A stage may be worked by at most 32 roles.' })
    expect(await ownersWith(cookie, { ...base, stageKey: 'NO_SUCH_STAGE' })).toMatchObject({ success: false, message: MISSING })
    expect(await ownersWith(cookie, { ...base, expectedOwnersVersion: 3 })).toMatchObject({ success: false, message: STALE })
    expect(await ownersWith(cookie, base))
      .toMatchObject({ success: false, message: 'Those are already the roles that work this stage.' })
  })

  it('takes a stage away from a role, recording who and why', async () => {
    const { cookie } = await author()
    const pipeline = await publishedExample(cookie)
    const officer = await roleKeyOf((await signIn({ permissions: [['stage', 'read'], ['stage', 'advance']] })).roleId)
    await setOwners(cookie, { pipelineId: pipeline.id, stageKey: 'TTC', expectedOwnersVersion: 0, roleKeys: [officer] })
    const removed = await setOwners(cookie, { pipelineId: pipeline.id, stageKey: 'TTC', expectedOwnersVersion: 1, roleKeys: [] })
    expect(removed.success, removed.message).toBe(true)
    expect(removed.response.stages.find((stage: any) => stage.stageKey === 'TTC')).toMatchObject({ ownersVersion: 2, owners: [] })
  })
})

describe('the authoring writes, each behind its own pair', () => {
  it('refuses a reader every write, and publishes without a change note', async () => {
    const { cookie: root } = await author()
    const { response } = await create(root, { key: 'ROUTE', name: 'Route', startFromExample: true })
    const { cookie: reader } = await signIn({ permissions: [['pipeline', 'read']] })
    expect(await save(reader, response.id, 1, examplePipeline)).toMatchObject({ success: false, message: DENIED })
    expect(await discard(reader, response.id, 1)).toMatchObject({ success: false, message: DENIED })
    expect(await retire(reader, response.id, 'No.')).toMatchObject({ success: false, message: DENIED })
    expect(await setOwners(reader, { pipelineId: response.id, stageKey: 'TTC', expectedOwnersVersion: 0, roleKeys: [] }))
      .toMatchObject({ success: false, message: DENIED })

    const published = await graphql<any>(`mutation($input: PublishPipelineInput!) {
      admin { pipeline { publish(input: $input) { success message response { versions { version changeNote } } } } }
    }`, { input: { pipelineId: response.id, expectedRevision: 1 } }, root)
    expect(published.data!.admin.pipeline.publish).toMatchObject({ success: true, response: { versions: [{ version: 1, changeNote: null }] } })
  })

  it('lists the first problems of a document that does not parse, and says how many more', async () => {
    const { cookie } = await author()
    const { response } = await create(cookie, { key: 'ROUTE', name: 'Route' })
    const refused = await save(cookie, response.id, 1, { schema: 2, initialStageKey: 1, onSubmit: 1, statusFlags: 1, recordedValues: 1, stages: 1 })
    expect(refused.success).toBe(false)
    expect(refused.message).toMatch(/^The pipeline could not be read: .+ \(and \d+ more\)$/u)
  })
})
