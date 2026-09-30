/**
 * What an officer enters and what a pipeline records, shown back — to the
 * office on the stage panel, to the history in the audit row, and to the
 * applicant on their own screen — whatever types the pipeline configures.
 *
 * The worked example only records money, text and a date, so this publishes a
 * pipeline that asks for everything else an input can be: several choices at
 * once, a whole number, yes or no, a date, a long line of text. It records a
 * value the applicant must not see, pre-fills a later input from it, and ends
 * one journey with a flag the applicant is not shown. Each of those is a
 * different way for a screen or the history to show the wrong thing, or
 * something it should not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { graphql, openCycle, signIn, submittedApplication } from '../support/api'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import type { PipelineDefinition } from '../../src/services/pipeline/definition'
import { examplePipeline } from '../../src/services/pipeline/example'
import { advance, loanAnswers, readStage } from './support/stage'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

/** The example, with an assessment at TTC, a follow-up at I&C, and a quiet ending. */
const richPipeline = (): PipelineDefinition => {
  const definition = structuredClone(examplePipeline)
  definition.statusFlags.push({
    key: 'WITHDRAWN', label: 'Withdrawn', applicantLabel: 'Withdrawn', explanation: null,
    applicantVisible: false, kind: 'OUTCOME', terminal: true, applicantEdit: 'NONE',
  })
  definition.recordedValues.push({ key: 'SCORE', label: 'Assessment score', type: 'INTEGER', applicantVisible: false })
  const input = (key: string, type: PipelineDefinition['stages'][number]['actions'][number]['inputs'][number]['type'], extra: Record<string, unknown> = {}) =>
    ({ key, type, label: key.toLowerCase(), helpText: null, requirement: 'REQUIRED' as const, minLength: null, maxLength: null,
      minValue: null, maxValue: null, minDate: null, maxDate: null, relativeDateBound: null, options: [], visibleWhen: [], defaultFrom: null, ...extra })
  definition.stages[0]!.actions.push({
    key: 'ASSESS',
    label: 'Record the assessment',
    description: null,
    confirmation: null,
    availableWhen: [],
    inputs: [
      input('SECTORS', 'MULTI_CHOICE', { options: [{ value: 'AGRI', label: 'Agriculture' }, { value: 'CRAFT', label: 'Handicraft' }] }),
      input('SCORE', 'INTEGER'),
      input('VERIFIED', 'BOOLEAN'),
      input('VISITED_ON', 'DATE'),
      input('SUMMARY', 'TEXT', { maxLength: 400 }),
    ],
    effects: [{ type: 'SET_RECORDED_VALUE', params: { input: 'SCORE', target: 'SCORE' }, when: [] }],
  })
  definition.stages[1]!.actions.push(
    {
      key: 'RESCORE',
      label: 'Revise the score',
      description: null,
      confirmation: null,
      availableWhen: [],
      inputs: [input('SCORE', 'INTEGER', { defaultFrom: { source: 'RECORDED_VALUE', key: 'SCORE' } })],
      effects: [{ type: 'SET_RECORDED_VALUE', params: { input: 'SCORE', target: 'SCORE' }, when: [] }],
    },
    {
      key: 'WITHDRAW',
      label: 'Withdraw at the applicant’s request',
      description: null,
      confirmation: null,
      availableWhen: [],
      inputs: [],
      effects: [{ type: 'CLOSE_APPLICATION', params: { flag: 'WITHDRAWN' }, when: [] }],
    },
  )
  return definition
}

const publishRich = async (cookie: string) => {
  const call = async (mutation: string, type: string, input: Record<string, unknown>) =>
    (await graphql<any>(`mutation($input: ${type}!) { admin { pipeline { ${mutation}(input: $input) { success message response { id } } } } }`, { input }, cookie))
      .data.admin.pipeline[mutation]
  const created = await call('create', 'CreatePipelineInput', { key: 'RICH', name: 'Rich route' })
  const saved = await call('saveDraft', 'SavePipelineDraftInput', { pipelineId: created.response.id, expectedRevision: 1, definition: JSON.stringify(richPipeline()) })
  expect(saved.success, saved.message).toBe(true)
  const published = await call('publish', 'PublishPipelineInput', { pipelineId: created.response.id, expectedRevision: 2 })
  expect(published.success, published.message).toBe(true)
  return created.response.id as string
}

describe('configured values, shown back', () => {
  it('labels every kind of input on the panel and in the history, and keeps hidden ones from the applicant', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie, { pipelineId: await publishRich(admin.cookie) })
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const { applicationId } = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: loanAnswers() })

    const summary = 'A long account of the visit. '.repeat(10).trim()
    const assessed = await advance(admin.cookie, applicationId, 'ASSESS', {
      inputs: { SECTORS: ['AGRI', 'CRAFT'], SCORE: 7, VERIFIED: true, VISITED_ON: '2026-01-15', SUMMARY: summary },
    })
    expect(assessed.stageKey).toBe('TTC')

    const panel = await readStage(admin.cookie, applicationId)
    expect(panel.response.history[0].inputs).toEqual([
      { key: 'SECTORS', label: 'sectors', value: 'Agriculture, Handicraft' },
      { key: 'SCORE', label: 'score', value: '7' },
      { key: 'VERIFIED', label: 'verified', value: 'true' },
      { key: 'VISITED_ON', label: 'visited_on', value: '2026-01-15' },
      { key: 'SUMMARY', label: 'summary', value: summary },
    ])
    expect(panel.response.recordedValues).toContainEqual({ key: 'SCORE', label: 'Assessment score', type: 'INTEGER', value: '7' })

    // The history keeps each as a labelled value of its kind, and bounds the long one.
    const audit = await env.DB.prepare(
      `SELECT payload FROM core_audit_event WHERE action = 'SEB.STAGE_ACTION_TAKEN' AND application_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(applicationId).first<{ payload: { inputs: { label: string; kind: string; value: string }[] } }>()
    const kinds = Object.fromEntries(audit!.payload.inputs.map((each) => [each.label, each.kind]))
    expect(kinds).toEqual({ sectors: 'TEXT', score: 'COUNT', verified: 'BOOLEAN', visited_on: 'DATE', summary: 'TEXT' })
    expect(audit!.payload.inputs.find((each) => each.label === 'summary')!.value).toMatch(/^.{199}…$/u)

    // A later input starts from the recorded value.
    await advance(admin.cookie, applicationId, 'TO_INDUSTRIES_COMMERCE')
    const atIc = await readStage(admin.cookie, applicationId)
    expect(atIc.response.actions.find((each: { key: string }) => each.key === 'RESCORE').defaults).toEqual({ SCORE: 7 })

    // The applicant sees neither the score nor the name of an ending they are not shown.
    await advance(admin.cookie, applicationId, 'WITHDRAW')
    const mine = (await graphql<any>(`query($id: ID!) { seb { application { byId(id: $id) { response {
      journey { ended stageLabel recordedValues { key } flags { key } }
    } } } } }`, { id: applicationId }, applicant.cookie)).data.seb.application.byId.response.journey
    expect(mine).toMatchObject({ ended: 'Finished', stageLabel: null, recordedValues: [] })
    expect(mine.flags.map((flag: { key: string }) => flag.key)).not.toContain('WITHDRAWN')
  })
})
