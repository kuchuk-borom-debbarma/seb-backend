/**
 * The pipeline engine and its validator, with no database.
 *
 * Everything a pipeline can be configured to do is decided by pure code — what
 * an action is available for, what permission it needs, where it sends a file,
 * what flags and values it leaves behind — so it is tested exhaustively here,
 * against the worked example and against deliberately broken documents. The
 * database write that carries a plan out is tested in the journey suite.
 */
import { describe, expect, it } from 'vitest'
import type { AnswerValue } from '../../src/services/application/form/types'
import { parseDefinition, type PipelineDefinition } from '../../src/services/pipeline/definition'
import {
  actionIsAvailable,
  awaitsApplicant,
  permissionsFor,
  planAction,
  stageOf,
  type FileState,
} from '../../src/services/pipeline/engine'
import { examplePipeline } from '../../src/services/pipeline/example'
import { validateActionInputs } from '../../src/services/pipeline/inputs'
import { pipelineProblems } from '../../src/services/pipeline/validate'

const clone = (): PipelineDefinition => structuredClone(examplePipeline)

const answers = {
  WANTS_GRANT: true,
  SEED_FUND_REQUESTED_PAISE: 50_000_000,
  WANTS_BANK_LOAN: true,
  LOAN_BANK_FIRST_CHOICE: 'TGB',
  LOAN_AMOUNT_REQUESTED_PAISE: 200_000_000,
}

const at = (stageKey: string, overrides: Partial<FileState> = {}): FileState => ({
  stageKey,
  flags: new Set(['IN_REVIEW']),
  recorded: {},
  trail: [],
  answers,
  ...overrides,
})

const actionOf = (stageKey: string, actionKey: string) => {
  const stage = stageOf(examplePipeline, stageKey)!
  return { stage, action: stage.actions.find((action) => action.key === actionKey)! }
}

const plan = (stageKey: string, actionKey: string, inputs: Record<string, AnswerValue>, state = at(stageKey), ceiling: number | null = null) => {
  const { stage, action } = actionOf(stageKey, actionKey)
  return planAction({ definition: examplePipeline, stage, action, inputs, answers: state.answers, flags: state.flags, recorded: state.recorded, cycleCeilingPaise: ceiling, state })
}

describe('the worked example', () => {
  it('is a valid pipeline', () => {
    expect(pipelineProblems(examplePipeline)).toEqual([])
  })

  it('offers the grant only to an applicant who asked for one, and only once', () => {
    const { action } = actionOf('INDUSTRIES_COMMERCE', 'APPROVE_GRANT')
    expect(actionIsAvailable(examplePipeline, action, at('INDUSTRIES_COMMERCE'))).toBe(true)
    expect(actionIsAvailable(examplePipeline, action, at('INDUSTRIES_COMMERCE', { answers: { ...answers, WANTS_GRANT: false } }))).toBe(false)
    expect(actionIsAvailable(examplePipeline, action, at('INDUSTRIES_COMMERCE', { flags: new Set(['IN_REVIEW', 'GRANT_APPROVED']) }))).toBe(false)
  })

  it('offers the bank to a loan applicant and completion to everybody else', () => {
    const bank = actionOf('INDUSTRIES_COMMERCE', 'SEND_TO_BANK').action
    const complete = actionOf('INDUSTRIES_COMMERCE', 'COMPLETE_WITHOUT_LOAN').action
    const noLoan = at('INDUSTRIES_COMMERCE', { answers: { ...answers, WANTS_BANK_LOAN: false } })
    expect([actionIsAvailable(examplePipeline, bank, at('INDUSTRIES_COMMERCE')), actionIsAvailable(examplePipeline, complete, at('INDUSTRIES_COMMERCE'))]).toEqual([true, false])
    expect([actionIsAvailable(examplePipeline, bank, noLoan), actionIsAvailable(examplePipeline, complete, noLoan)]).toEqual([false, true])
  })

  it('offers nothing while the applicant holds the file', () => {
    const state = at('TTC', { flags: new Set(['IN_REVIEW', 'REVISION_REQUIRED']) })
    expect(awaitsApplicant(examplePipeline, state.flags)).toBe(true)
    for (const action of stageOf(examplePipeline, 'TTC')!.actions) {
      expect(actionIsAvailable(examplePipeline, action, state), action.key).toBe(false)
    }
  })

  it('asks each action for exactly the permissions its effects need', () => {
    expect(permissionsFor(examplePipeline, actionOf('TTC', 'TO_INDUSTRIES_COMMERCE').action)).toEqual(['stage:advance'])
    // An approval is a decision; noting it and recording its amount are too.
    expect(permissionsFor(examplePipeline, actionOf('INDUSTRIES_COMMERCE', 'APPROVE_GRANT').action)).toEqual(['stage:decide'])
    expect(permissionsFor(examplePipeline, actionOf('TTC', 'REJECT').action)).toEqual(['application:note', 'stage:advance', 'stage:close'])
    expect(permissionsFor(examplePipeline, actionOf('INDUSTRIES_COMMERCE', 'SEND_BACK').action)).toEqual(['application:note', 'stage:return'])
  })
})

describe('what an action does', () => {
  it('routes to the bank chosen, and the bank stage brings its presence flag', () => {
    const outcome = plan('INDUSTRIES_COMMERCE', 'SEND_TO_BANK', { BANK: 'SBI' }, at('INDUSTRIES_COMMERCE', { trail: ['TTC'] }))
    expect(outcome).toMatchObject({ ok: true, plan: { toStageKey: 'SBI_BANK', trailOp: 'PUSH', flagsAdded: ['BANKING_STAGE'] } })
  })

  it('returns to where the file came from, and leaving the bank takes the flag away', () => {
    const state = at('SBI_BANK', { trail: ['TTC', 'INDUSTRIES_COMMERCE'], flags: new Set(['IN_REVIEW', 'BANKING_STAGE']) })
    const outcome = plan('SBI_BANK', 'SEND_BACK', { NOTE: 'Wrong branch.' }, state)
    expect(outcome).toMatchObject({
      ok: true,
      plan: { toStageKey: 'INDUSTRIES_COMMERCE', trailOp: 'POP', flagsRemoved: ['BANKING_STAGE'], internalNotes: ['Wrong branch.'] },
    })
  })

  it('refuses to return a file that has nowhere to return to', () => {
    expect(plan('INDUSTRIES_COMMERCE', 'SEND_BACK', { NOTE: 'x' }, at('INDUSTRIES_COMMERCE', { trail: [] })))
      .toMatchObject({ ok: false, refusal: 'This application has no earlier stage to return to.' })
  })

  it('records the grant, and refuses more than was asked for or than the cycle allows', () => {
    expect(plan('INDUSTRIES_COMMERCE', 'APPROVE_GRANT', { AMOUNT: 40_000_000 })).toMatchObject({
      ok: true,
      plan: { toStageKey: 'INDUSTRIES_COMMERCE', flagsAdded: ['GRANT_APPROVED'], recorded: { APPROVED_GRANT_PAISE: 40_000_000 } },
    })
    expect(plan('INDUSTRIES_COMMERCE', 'APPROVE_GRANT', { AMOUNT: 60_000_000 }))
      .toMatchObject({ ok: false, inputKey: 'AMOUNT', refusal: 'This is more than the ₹5,00,000 the applicant asked for.' })
    // Each refusal names its bound, which is what the officer types instead.
    expect(plan('INDUSTRIES_COMMERCE', 'APPROVE_GRANT', { AMOUNT: 40_000_000 }, at('INDUSTRIES_COMMERCE'), 30_000_000))
      .toMatchObject({
        ok: false,
        inputKey: 'AMOUNT',
        refusal: 'This is more than the ₹3,00,000 the cycle allows for one application.',
      })
  })

  it('ends the journey with its terminal flag and no stage', () => {
    const state = at('TGB_BANK', { trail: ['TTC', 'INDUSTRIES_COMMERCE'], flags: new Set(['IN_REVIEW', 'GRANT_APPROVED', 'BANKING_STAGE']) })
    const outcome = plan('TGB_BANK', 'FULFIL_LOAN', { AMOUNT: 150_000_000, REFERENCE: 'TGB/77', SANCTION_DATE: '2026-09-01' }, state)
    expect(outcome).toMatchObject({
      ok: true,
      plan: {
        toStageKey: null,
        ended: 'COMPLETED',
        flags: ['COMPLETED', 'GRANT_APPROVED', 'LOAN_APPROVED'],
        recorded: { FULFILLED_LOAN_PAISE: 150_000_000, LOAN_REFERENCE: 'TGB/77', LOAN_SANCTIONED_ON: '2026-09-01' },
      },
    })
  })

  it('hands the file to the applicant without moving it', () => {
    expect(plan('TTC', 'ASK_REVISION', {})).toMatchObject({
      ok: true,
      plan: { toStageKey: 'TTC', trailOp: 'NONE', revisionFlag: 'REVISION_REQUIRED', flagsAdded: ['REVISION_REQUIRED'] },
    })
  })
})

describe('an action’s inputs', () => {
  it('are validated by the form engine, exactly as an applicant’s answers are', () => {
    const { action } = actionOf('SBI_BANK', 'FULFIL_LOAN')
    const now = new Date('2026-09-30T00:00:00Z')
    // Zero is below the input's own minimum, a future date breaks its bound,
    // and an amount sent as text is refused as the applicant form refuses it.
    expect(validateActionInputs(action, { AMOUNT: 0, REFERENCE: 'X', SANCTION_DATE: '2026-09-01' }, now)).toMatchObject({ ok: false })
    expect(validateActionInputs(action, { AMOUNT: '100', REFERENCE: 'X', SANCTION_DATE: '2026-09-01' }, now)).toMatchObject({ ok: false })
    expect(validateActionInputs(action, { AMOUNT: 100, REFERENCE: 'X', SANCTION_DATE: '2099-01-01' }, now)).toMatchObject({ ok: false })
    expect(validateActionInputs(action, { AMOUNT: 100, REFERENCE: 'SBI/1', SANCTION_DATE: '2026-09-01' }, now))
      .toMatchObject({ ok: true, values: { AMOUNT: 100, REFERENCE: 'SBI/1', SANCTION_DATE: '2026-09-01' } })
  })
})

/** A copy of the example with one deliberate mistake, and the problem it must raise. */
const broken: [string, (definition: PipelineDefinition) => void, RegExp][] = [
  ['an unreachable stage', (d) => { d.stages[0]!.actions[1]!.effects = [{ type: 'MOVE_TO_STAGE', params: { target: 'TGB_BANK' }, when: [] }] }, /No route reaches INDUSTRIES_COMMERCE/u],
  ['an option with no route', (d) => { (d.stages[1]!.actions[2]!.effects[0]!.params as { routes: Record<string, string> }).routes = { SBI: 'SBI_BANK' } }, /Option TGB has no route/u],
  ['two moves in one action', (d) => { d.stages[0]!.actions[1]!.effects.push({ type: 'CLOSE_APPLICATION', params: { flag: 'REJECTED' }, when: [] }) }, /one place at most/u],
  ['a terminal flag added as a status', (d) => { d.stages[1]!.actions[1]!.effects[0]!.params = { flag: 'COMPLETED' } }, /ends the pipeline; use COMPLETE_PIPELINE/u],
  ['an editing flag added as a status', (d) => { d.stages[1]!.actions[1]!.effects[0]!.params = { flag: 'REVISION_REQUIRED' } }, /only REQUEST_REVISION may add it/u],
  ['a return from the entry stage', (d) => { d.stages[0]!.actions.push({ ...d.stages[1]!.actions[0]! }) }, /where files enter/u],
  ['an input deciding availability', (d) => { d.stages[1]!.actions[1]!.availableWhen.push({ group: 1, source: 'INPUT', key: 'AMOUNT', operator: 'IS_PRESENT', value: null, answerType: null }) }, /before the officer fills it in/u],
  ['an action nobody needs permission for', (d) => { d.stages[0]!.actions[0]!.effects = [{ type: 'NOTIFY_APPLICANT', params: { message: 'Hi' }, when: [] }] }, /needs no permission/u],
  ['a stage nothing leaves', (d) => { d.stages[3]!.actions = [d.stages[3]!.actions[1]!].map((action) => ({ ...action, effects: action.effects.filter((effect) => effect.type !== 'COMPLETE_PIPELINE') })) }, /Nothing moves an application out of TGB_BANK/u],
  ['an unknown flag', (d) => { d.onSubmit.addFlags = ['NOPE'] }, /No status flag is called NOPE/u],
  ['a revision flag that does not unlock editing', (d) => { d.stages[0]!.actions[0]!.effects[0]!.params = { flag: 'IN_REVIEW' } }, /must let the applicant edit/u],
  ['a pipeline that never ends', (d) => { for (const stage of d.stages) for (const action of stage.actions) action.effects = action.effects.filter((effect) => effect.type !== 'COMPLETE_PIPELINE' && effect.type !== 'CLOSE_APPLICATION') }, /No application can ever finish/u],
]

describe('a broken pipeline', () => {
  it.each(broken)('is refused for %s', (_name, breakIt, expected) => {
    const definition = clone()
    breakIt(definition)
    expect(pipelineProblems(definition).map((problem) => problem.message).join('\n')).toMatch(expected)
  })

  it('is refused for an effect the catalogue does not have, at load as at save', () => {
    const definition = clone() as unknown as { stages: { actions: { effects: { type: string }[] }[] }[] }
    definition.stages[0]!.actions[0]!.effects[0]!.type = 'TRANSFER_MONEY'
    expect(parseDefinition(definition).ok).toBe(false)
    expect(pipelineProblems(definition).length).toBeGreaterThan(0)
  })

  it('covers every table row', () => {
    expect(broken).toHaveLength(12)
  })
})
