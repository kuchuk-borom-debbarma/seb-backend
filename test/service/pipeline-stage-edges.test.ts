/**
 * The stage operations at their edges: nobody signed in, an action already
 * spent, a queue longer than one page, and a pinned pipeline document a later
 * build can no longer read.
 *
 * The last is the one worth a suite of its own. A published version never
 * changes, but the code that reads it does, and a version stored under an
 * older build may one day fail today's schema. When it does, every screen
 * must still open — naming stages by their keys rather than their names —
 * and every write must refuse in words the office can act on, rather than one
 * file taking the queue down with it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createEnterprise, graphql, openCycle, signIn, startApplication, submittedApplication } from '../support/api'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { TEST_PIPELINE_ID } from '../support/pipeline'
import { examplePipeline } from '../../src/services/pipeline/example'
import { env } from '../support/worker'
import { act, advance, loanAnswers, officer, readStage } from './support/stage'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const NOT_PERMITTED = 'You do not have permission to do that.'
const UNREADABLE = 'This application’s pipeline can no longer be read. Tell the programme office.'

const myStages = async (cookie: string | undefined) =>
  (await graphql<any>(`query { admin { stage { myStages { success message response { stageKey stageName waiting } } } } }`, {}, cookie))
    .data.admin.stage.myStages

const queue = async (cookie: string | undefined, input: Record<string, unknown>) =>
  (await graphql<any>(`query($input: AdminStageQueueInput!) {
    admin { stage { queue(input: $input) { success message response {
      nodes { id flags { key label } recordedValues { key } }
      pageInfo { totalCount hasNextPage endCursor }
    } } } }
  }`, { input: { pipelineId: TEST_PIPELINE_ID, ...input } }, cookie)).data.admin.stage.queue

/** What the applicant is shown about where their file is. */
const journeyOf = async (cookie: string, id: string) =>
  (await graphql<any>(`query($id: ID!) { seb { application { byId(id: $id) { success response { journey { stageLabel ended } } } } } }`, { id }, cookie))
    .data.seb.application.byId.response.journey

const withdraw = async (cookie: string | undefined, input: Record<string, unknown>) =>
  (await graphql<any>(`mutation($input: WithdrawRevisionInput!) {
    admin { stage { withdrawRevision(input: $input) { success message } } }
  }`, { input }, cookie)).data.admin.stage.withdrawRevision

/** Files submitted into the fixture pipeline, all waiting at TTC. */
const filesAtTtc = async (count: number) => {
  const admin = await signIn({ roles: ['SUPER_ADMIN'] })
  const cycle = await openCycle(admin.cookie)
  const ids: string[] = []
  const applicants: string[] = []
  for (let index = 0; index < count; index += 1) {
    const applicant = await signIn({ roles: ['APPLICANT'] })
    applicants.push(applicant.cookie)
    ids.push((await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: loanAnswers() })).applicationId)
  }
  return { admin, ids, applicants, cycle }
}

describe('somebody not signed in', () => {
  it('is refused every stage read and write', async () => {
    const quote = { applicationId: '00000000-0000-4000-8000-000000000000', expectedStatusVersion: 1 }
    expect(await myStages(undefined)).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect(await queue(undefined, { stageKey: 'TTC' })).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect(await readStage('', quote.applicationId)).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect(await act('', { ...quote, stageKey: 'TTC', actionKey: 'REJECT' })).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect(await withdraw(undefined, { ...quote, revisionRequestId: quote.applicationId, reason: 'No.' }))
      .toMatchObject({ success: false, message: NOT_PERMITTED })
  })
})

describe('a stage queue', () => {
  it('pages oldest first, carrying on from where the last page ended', async () => {
    const { ids } = await filesAtTtc(3)
    const ttc = await officer(['TTC'])
    const first = await queue(ttc.cookie, { stageKey: 'TTC', first: 2 })
    expect(first.response.nodes.map((node: { id: string }) => node.id)).toEqual(ids.slice(0, 2))
    expect(first.response.pageInfo).toMatchObject({ totalCount: 3, hasNextPage: true })
    const second = await queue(ttc.cookie, { stageKey: 'TTC', first: 2, after: first.response.pageInfo.endCursor })
    expect(second.response.nodes.map((node: { id: string }) => node.id)).toEqual(ids.slice(2))
    expect(second.response.pageInfo.hasNextPage).toBe(false)
    // A stage nobody is waiting at has an empty page with nowhere to go on to.
    expect((await queue(ttc.cookie, { stageKey: 'TTC', flags: ['BANKING_STAGE'] })).response)
      .toEqual({ nodes: [], pageInfo: { totalCount: 0, hasNextPage: false, endCursor: null } })
  })
})

describe('an action already spent', () => {
  it('is refused when it is no longer offered, whatever the screen still shows', async () => {
    const { admin, ids } = await filesAtTtc(1)
    await advance(admin.cookie, ids[0]!, 'TO_INDUSTRIES_COMMERCE')
    await advance(admin.cookie, ids[0]!, 'APPROVE_GRANT', { inputs: { AMOUNT: 5_000_000 } })
    const panel = await readStage(admin.cookie, ids[0]!)
    expect(panel.response.actions.map((each: { key: string }) => each.key)).not.toContain('APPROVE_GRANT')
    expect(await act(admin.cookie, {
      applicationId: ids[0]!,
      expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'INDUSTRIES_COMMERCE',
      actionKey: 'APPROVE_GRANT',
      inputs: { AMOUNT: 5_000_000 },
    })).toMatchObject({ success: false, message: 'That action is not available for this application now.' })
  })
})

describe('a pinned pipeline this build can no longer read', () => {
  it('still lists and queues its files by their keys, and refuses to work them', async () => {
    const { admin, ids, applicants } = await filesAtTtc(1)
    expect(await journeyOf(applicants[0]!, ids[0]!)).toMatchObject({ stageLabel: 'Under first review', ended: null })
    await advance(admin.cookie, ids[0]!, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'Please restate the grant.' }],
    })
    const panel = await readStage(admin.cookie, ids[0]!)
    // The stored document stops parsing: a shape an older build wrote.
    await env.DB.prepare(`UPDATE seb_pipeline_version SET definition = '{"schema": 1}'::jsonb WHERE pipeline_id = ?`)
      .bind(TEST_PIPELINE_ID).run()

    const stages = await myStages(admin.cookie)
    expect(stages.success).toBe(true)
    expect(stages.response).toEqual(expect.arrayContaining([{ stageKey: 'TTC', stageName: 'TTC', waiting: 1 }]))

    const waiting = await queue(admin.cookie, { stageKey: 'TTC' })
    expect(waiting.response.nodes).toEqual([{
      id: ids[0],
      flags: expect.arrayContaining([{ key: 'IN_REVIEW', label: 'IN_REVIEW' }]),
      recordedValues: [],
    }])

    expect(await readStage(admin.cookie, ids[0]!)).toMatchObject({ success: false, message: UNREADABLE })
    // The applicant is shown no stage rather than a wrong one.
    expect(await journeyOf(applicants[0]!, ids[0]!)).toBeNull()
    expect(await act(admin.cookie, {
      applicationId: ids[0]!,
      expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'TTC',
      actionKey: 'REJECT',
      inputs: { REASON: 'No.' },
    })).toMatchObject({ success: false, message: UNREADABLE })
    expect(await withdraw(admin.cookie, {
      applicationId: ids[0]!,
      expectedStatusVersion: panel.response.statusVersion,
      revisionRequestId: panel.response.openRevisions[0].id,
      reason: 'Asked in error.',
    })).toMatchObject({ success: false, message: UNREADABLE })
  })
})

describe('a pinned pipeline that no longer declares what a file holds', () => {
  it('shows the keys it cannot name, rather than failing the panel', async () => {
    const { admin, ids } = await filesAtTtc(1)
    await advance(admin.cookie, ids[0]!, 'TO_INDUSTRIES_COMMERCE')
    // Still a document this build reads, but without the stage the file came
    // from or the flag it was given on submission.
    const drifted = structuredClone(examplePipeline)
    drifted.stages = drifted.stages.filter((stage) => stage.key !== 'TTC')
    drifted.statusFlags = drifted.statusFlags.filter((flag) => flag.key !== 'IN_REVIEW')
    await env.DB.prepare('UPDATE seb_pipeline_version SET definition = ?::jsonb WHERE pipeline_id = ?')
      .bind(JSON.stringify(drifted), TEST_PIPELINE_ID).run()

    const panel = await readStage(admin.cookie, ids[0]!)
    expect(panel.success, panel.message ?? '').toBe(true)
    expect(panel.response.trail).toEqual([{ key: 'TTC', name: 'TTC' }])
    expect(panel.response.flags).toEqual([{ key: 'IN_REVIEW', label: 'IN_REVIEW', terminal: false }])
    expect(panel.response.history[0]).toMatchObject({ actionKey: 'TO_INDUSTRIES_COMMERCE', actionLabel: 'TO_INDUSTRIES_COMMERCE', stageKey: 'TTC' })
  })
})

describe('an officer who works no stage yet', () => {
  it('has nothing waiting, and cannot open a file at a stage they do not work', async () => {
    const { ids } = await filesAtTtc(1)
    const newcomer = await officer([])
    expect(await myStages(newcomer.cookie)).toEqual({ success: true, message: null, response: [] })
    expect(await queue(newcomer.cookie, { stageKey: 'TTC' })).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect(await readStage(newcomer.cookie, ids[0]!)).toMatchObject({ success: false })
  })
})

describe('a draft', () => {
  it('has no journey to show until it is submitted', async () => {
    const { cycle } = await filesAtTtc(0)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const draft = await startApplication(applicant.cookie, await createEnterprise(applicant.cookie), cycle.id)
    expect(await journeyOf(applicant.cookie, draft)).toBeNull()
  })
})
