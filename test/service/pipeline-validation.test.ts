/**
 * Every refusal the pipeline validator, the pin check and the effect planners
 * can give, one deliberate mistake at a time.
 *
 * `pipeline-engine.test.ts` proves the worked example and the headline
 * refusals the pipeline guide lists. This covers the rest of the table: the
 * mistakes an author makes on the way to a valid document — a duplicated key,
 * a reference to something that is not there, a parameter of the wrong shape,
 * an effect aimed at the wrong kind of flag or input — and the refusals the
 * planner gives at the moment an officer acts, which no static check can see.
 * Each case asserts the sentence an author reads, because that sentence is the
 * whole of what the editor can show them.
 */
import { describe, expect, it } from 'vitest'
import type { AnswerValue } from '../../src/services/application/form/types'
import { parseDefinition, type PipelineAction, type PipelineDefinition } from '../../src/services/pipeline/definition'
import { actionIsAvailable, conditionsHold, planAction, stageOf, type FileState } from '../../src/services/pipeline/engine'
import { examplePipeline } from '../../src/services/pipeline/example'
import { validateActionInputs } from '../../src/services/pipeline/inputs'
import { paramKindHandlers } from '../../src/services/pipeline/param-kinds'
import { holdsEvery } from '../../src/services/pipeline/permissions'
import { pipelinePinProblems, pipelineProblems } from '../../src/services/pipeline/validate'
import { field, templateOf } from './support/template'

const clone = (): PipelineDefinition => structuredClone(examplePipeline)

/** The four stages of the example, by name, so a mutation reads as what it breaks. */
const stages = (d: PipelineDefinition) => ({
  ttc: d.stages[0]!,
  ic: d.stages[1]!,
  sbi: d.stages[2]!,
})
const action = (d: PipelineDefinition, stageKey: string, actionKey: string): PipelineAction =>
  stageOf(d, stageKey)!.actions.find((candidate) => candidate.key === actionKey)!

const messagesOf = (definition: unknown) => pipelineProblems(definition).map((problem) => problem.message).join('\n')

/** An input the tests add to an action, shaped like the example's. */
const input = (key: string, type: PipelineAction['inputs'][number]['type'], extra: Partial<PipelineAction['inputs'][number]> = {}) => ({
  key,
  type,
  label: key,
  helpText: null,
  requirement: 'OPTIONAL' as const,
  minLength: null,
  maxLength: null,
  minValue: null,
  maxValue: null,
  minDate: null,
  maxDate: null,
  relativeDateBound: null,
  options: [],
  visibleWhen: [],
  defaultFrom: null,
  ...extra,
})

const mistakes: [string, (d: PipelineDefinition) => void, RegExp][] = [
  ['two stages with one key', (d) => { d.stages.push({ ...stages(d).sbi }) }, /Two stages are called SBI_BANK/u],
  ['two flags with one key', (d) => { d.statusFlags.push({ ...d.statusFlags[0]! }) }, /Two flags are called IN_REVIEW/u],
  ['two recorded values with one key', (d) => { d.recordedValues.push({ ...d.recordedValues[0]! }) }, /Two recorded values are called APPROVED_GRANT_PAISE/u],
  ['two actions with one key', (d) => { stages(d).ttc.actions.push({ ...stages(d).ttc.actions[1]! }) }, /Two actions are called TO_INDUSTRIES_COMMERCE/u],
  ['two inputs with one key', (d) => { action(d, 'SBI_BANK', 'FULFIL_LOAN').inputs.push(input('AMOUNT', 'MONEY_PAISE')) }, /Two inputs are called AMOUNT/u],
  ['an entry stage that does not exist', (d) => { d.initialStageKey = 'NOWHERE' }, /No stage is called NOWHERE/u],
  ['a terminal flag held from submission', (d) => { d.onSubmit.addFlags = ['COMPLETED'] }, /COMPLETED ends the pipeline, so it cannot be held/u],
  ['an editing flag held from submission', (d) => { d.onSubmit.addFlags = ['REVISION_REQUIRED'] }, /REVISION_REQUIRED lets the applicant edit, so only a revision request may add it/u],
  ['a presence flag nobody declared', (d) => { stages(d).sbi.presenceFlags = ['AT_THE_BANK'] }, /No status flag is called AT_THE_BANK/u],
  ['a choice with no options', (d) => { action(d, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK').inputs[0]!.options = [] }, /BANK offers no options/u],
  ['inputs that do not form a form', (d) => {
    action(d, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK').inputs[0]!.visibleWhen = [{ group: 1, source: 'INPUT', key: 'BANK', operator: 'IS_PRESENT', value: null, answerType: null }]
  }, /These inputs do not form a valid form/u],
  ['a default from a value nobody records', (d) => { action(d, 'SBI_BANK', 'FULFIL_LOAN').inputs[0]!.defaultFrom = { source: 'RECORDED_VALUE', key: 'NOTHING' } }, /No recorded value is called NOTHING/u],
  ['an input shown by an input that is not there', (d) => {
    action(d, 'SBI_BANK', 'FULFIL_LOAN').inputs[1]!.visibleWhen = [{ group: 1, source: 'INPUT', key: 'GHOST', operator: 'IS_PRESENT', value: null, answerType: null }]
  }, /This action has no input called GHOST/u],
  ['an availability over an undeclared flag', (d) => {
    action(d, 'TTC', 'REJECT').availableWhen = [{ group: 1, source: 'STATUS_FLAG', key: 'VIP', operator: 'IS_PRESENT', value: null, answerType: null }]
  }, /No status flag is called VIP/u],
  ['an availability over an undeclared value', (d) => {
    action(d, 'TTC', 'REJECT').availableWhen = [{ group: 1, source: 'RECORDED_VALUE', key: 'SCORE', operator: 'IS_PRESENT', value: null, answerType: null }]
  }, /No recorded value is called SCORE/u],
  ['an answer compared without its type', (d) => {
    action(d, 'TTC', 'REJECT').availableWhen = [{ group: 1, source: 'ANSWER', key: 'WANTS_GRANT', operator: 'EQUALS', value: 'true', answerType: null }]
  }, /Say what type the answer is/u],
  ['an effect missing a parameter', (d) => { action(d, 'TTC', 'TO_INDUSTRIES_COMMERCE').effects[0]!.params = {} }, /expected string/u],
  ['a parameter of the wrong shape', (d) => { action(d, 'TTC', 'TO_INDUSTRIES_COMMERCE').effects[0]!.params = { target: 'lower case' } }, /Invalid string/u],
  ['a move to a stage that does not exist', (d) => { action(d, 'TTC', 'TO_INDUSTRIES_COMMERCE').effects[0]!.params = { target: 'NOWHERE' } }, /No stage is called NOWHERE/u],
  ['a move to the stage it leaves', (d) => { action(d, 'TTC', 'TO_INDUSTRIES_COMMERCE').effects[0]!.params = { target: 'TTC' } }, /from TTC to itself would change nothing/u],
  ['two revisions in one action', (d) => { action(d, 'TTC', 'ASK_REVISION').effects.push({ type: 'REQUEST_REVISION', params: { flag: 'REVISION_REQUIRED' }, when: [] }) }, /one revision at most/u],
  ['a move and a revision in one action', (d) => { action(d, 'TTC', 'ASK_REVISION').effects.push({ type: 'MOVE_TO_STAGE', params: { target: 'INDUSTRIES_COMMERCE' }, when: [] }) }, /both move the application and hand it back/u],
  ['a revision under an undeclared flag', (d) => { action(d, 'TTC', 'ASK_REVISION').effects[0]!.params = { flag: 'FIX_IT' } }, /No status flag is called FIX_IT/u],
  ['a status nobody declared', (d) => { action(d, 'INDUSTRIES_COMMERCE', 'APPROVE_GRANT').effects[0]!.params = { flag: 'SHINY' } }, /No status flag is called SHINY/u],
  ['an editing flag removed by hand', (d) => { action(d, 'TTC', 'REJECT').effects.push({ type: 'REMOVE_STATUS', params: { flag: 'REVISION_REQUIRED' }, when: [] }) }, /removed when the applicant resubmits/u],
  ['a completion under an ordinary flag', (d) => { action(d, 'INDUSTRIES_COMMERCE', 'COMPLETE_WITHOUT_LOAN').effects[0]!.params = { flag: 'IN_REVIEW' } }, /does not end the pipeline, so it cannot complete it/u],
  ['a closure under an ordinary flag', (d) => { action(d, 'TTC', 'REJECT').effects[0]!.params = { flag: 'IN_REVIEW' } }, /does not end the pipeline, so it cannot close/u],
  ['a note kept from a short text', (d) => { action(d, 'TTC', 'REJECT').inputs[0]!.type = 'TEXT' }, /REASON must be LONG_TEXT to be kept as a note/u],
  ['a text kept as an amount', (d) => {
    action(d, 'SBI_BANK', 'FULFIL_LOAN').effects[2]!.params = { input: 'REFERENCE', target: 'FULFILLED_LOAN_PAISE' }
  }, /REFERENCE is TEXT, which FULFILLED_LOAN_PAISE \(MONEY_PAISE\) cannot hold/u],
  ['a bound on something that is not an amount', (d) => {
    action(d, 'SBI_BANK', 'FULFIL_LOAN').effects[2]!.params = { input: 'REFERENCE', target: 'LOAN_REFERENCE', atMostCycleCeiling: true }
  }, /LOAN_REFERENCE is not an amount, so it cannot be bounded/u],
  ['a route chosen by something that is not a choice', (d) => {
    action(d, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK').inputs[0]!.type = 'TEXT'
    action(d, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK').inputs[0]!.options = []
  }, /BANK must be SINGLE_CHOICE to choose a stage/u],
  ['a route for an option nobody offers', (d) => {
    (action(d, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK').effects[0]!.params as { routes: Record<string, string> }).routes.HDFC = 'SBI_BANK'
  }, /A route is given for HDFC, which BANK does not offer/u],
  ['a route back to the same stage', (d) => {
    (action(d, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK').effects[0]!.params as { routes: Record<string, string> }).routes.SBI = 'INDUSTRIES_COMMERCE'
  }, /routes INDUSTRIES_COMMERCE to itself/u],
  ['a route to a stage that does not exist', (d) => {
    (action(d, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK').effects[0]!.params as { routes: Record<string, string> }).routes.SBI = 'HQ'
  }, /A route goes to HQ, which is not a stage/u],
]

describe('an author’s mistakes', () => {
  it.each(mistakes)('refuses %s, saying what is wrong', (_name, breakIt, expected) => {
    const definition = clone()
    breakIt(definition)
    expect(messagesOf(definition)).toMatch(expected)
  })

  it('names the whole document when it is not a document at all', () => {
    expect(pipelineProblems(null)).toEqual([expect.objectContaining({ path: '(definition)' })])
    expect(parseDefinition('not a pipeline')).toMatchObject({ ok: false })
  })
})

describe('each parameter kind, asked directly', () => {
  const definition = clone()
  it('reads meaning only where there is something to check against', () => {
    // No pipeline in scope — an eligibility rule's parameters — reads as fine.
    for (const kind of ['STAGE_KEY', 'STATUS_FLAG_KEY', 'RECORDED_VALUE_KEY', 'CHOICE_ROUTES', 'INPUT_KEY', 'APPLICATION_KIND_KEY'] as const) {
      expect(paramKindHandlers[kind].problem(kind === 'CHOICE_ROUTES' ? { A: 'NOWHERE' } : 'NOWHERE', {}), kind).toBeNull()
    }
    expect(paramKindHandlers.STAGE_KEY.problem('TTC', { definition })).toBeNull()
    expect(paramKindHandlers.RECORDED_VALUE_KEY.problem('SCORE', { definition })).toBe('No recorded value is called SCORE.')
  })

  it('checks an application kind against the cycle’s own kinds', () => {
    const kinds = new Set(['INITIAL', 'EXPANSION'])
    expect(paramKindHandlers.APPLICATION_KIND_KEY.problem('EXPANSION', { applicationKinds: kinds })).toBeNull()
    expect(paramKindHandlers.APPLICATION_KIND_KEY.problem('RENEWAL', { applicationKinds: kinds }))
      .toBe('The cycle declares no application kind called RENEWAL.')
  })

  it('takes fixed values on their shape alone', () => {
    const accepts = (kind: keyof typeof paramKindHandlers, value: unknown) =>
      paramKindHandlers[kind].schema.safeParse(value).success && paramKindHandlers[kind].problem(value, {}) === null
    expect([accepts('COUNT', 12), accepts('COUNT', -1), accepts('COUNT', 1.5)]).toEqual([true, false, false])
    expect([accepts('MONEY_PAISE', 50_000_00), accepts('MONEY_PAISE', -1)]).toEqual([true, false])
    expect([accepts('TEXT', 'Hello'), accepts('TEXT', '   ')]).toEqual([true, false])
    expect([accepts('BOOLEAN', true), accepts('BOOLEAN', 'yes')]).toEqual([true, false])
    expect([accepts('PIPELINE_KEY', 'MISSION_SEP'), accepts('PIPELINE_KEY', 'mission')]).toEqual([true, false])
    expect([accepts('ANSWER_KEY', 'WANTS_GRANT'), accepts('ANSWER_KEY', '')]).toEqual([true, false])
  })
})

describe('a cycle’s form, against the pipeline it pins', () => {
  const choice = (key: string, sortOrder: number) => field(key, 'SINGLE_CHOICE', sortOrder)
  const options = (key: string, values: string[]) =>
    values.map((optionValue, sortOrder) => ({ fieldKey: key, optionValue, optionLabel: optionValue, sortOrder }))
  const pins = (fields: Parameters<typeof templateOf>[0], extraOptions: ReturnType<typeof options> = []) =>
    pipelinePinProblems(examplePipeline, templateOf(fields, [], extraOptions)).map((problem) => problem.message)

  const everything = [
    field('WANTS_GRANT', 'BOOLEAN', 1),
    field('WANTS_BANK_LOAN', 'BOOLEAN', 2),
    choice('LOAN_BANK_FIRST_CHOICE', 3),
    field('LOAN_AMOUNT_REQUESTED_PAISE', 'MONEY_PAISE', 4),
  ]

  it('fits a form that asks every answer it reads, of the right type', () => {
    expect(pins(everything, options('LOAN_BANK_FIRST_CHOICE', ['SBI', 'TGB']))).toEqual([])
  })

  it('names an answer the form does not ask', () => {
    expect(pins(everything.slice(1), options('LOAN_BANK_FIRST_CHOICE', ['SBI', 'TGB']))).toContain('The form asks no question called WANTS_GRANT.')
  })

  it('names an answer of another type', () => {
    const asText = [field('WANTS_GRANT', 'TEXT', 1), ...everything.slice(1)]
    expect(pins(asText, options('LOAN_BANK_FIRST_CHOICE', ['SBI', 'TGB']))).toContain('WANTS_GRANT is TEXT on this form, not BOOLEAN.')
  })

  it('names a bound that is not an amount', () => {
    const asText = [...everything.slice(0, 3), field('LOAN_AMOUNT_REQUESTED_PAISE', 'TEXT', 4)]
    expect(pins(asText, options('LOAN_BANK_FIRST_CHOICE', ['SBI', 'TGB'])))
      .toContain('LOAN_AMOUNT_REQUESTED_PAISE is not an amount, so nothing can be bounded by it.')
  })

  it('names a pre-filled choice that can arrive with an option the input lacks', () => {
    expect(pins(everything, options('LOAN_BANK_FIRST_CHOICE', ['SBI', 'TGB', 'HDFC'])))
      .toContain('LOAN_BANK_FIRST_CHOICE can be answered HDFC, which this input does not offer.')
  })

  it('names an answer inside a repeated group, which has no single answer', () => {
    const grouped = [
      ...everything.slice(1),
      field('OWNERS', 'REPEAT_GROUP', 5, { repeatMin: 1, repeatMax: 3 }),
      field('WANTS_GRANT', 'BOOLEAN', 6, { parentFieldKey: 'OWNERS' }),
    ]
    expect(pins(grouped, options('LOAN_BANK_FIRST_CHOICE', ['SBI', 'TGB']))).toContain('WANTS_GRANT is inside a repeated group, so it has no single answer.')
  })
})

const answers = { WANTS_GRANT: true, SEED_FUND_REQUESTED_PAISE: 500, WANTS_BANK_LOAN: true, LOAN_AMOUNT_REQUESTED_PAISE: 1_000 }
const state = (stageKey: string | null, overrides: Partial<FileState> = {}): FileState => ({
  stageKey,
  flags: new Set(['IN_REVIEW']),
  recorded: {},
  trail: [],
  answers,
  ...overrides,
})
const planWith = (definition: PipelineDefinition, stageKey: string, actionKey: string, inputs: Record<string, AnswerValue>, file = state(stageKey), ceiling: number | null = null) =>
  planAction({
    definition,
    stage: stageOf(definition, stageKey)!,
    action: action(definition, stageKey, actionKey),
    inputs,
    answers: file.answers,
    flags: file.flags,
    recorded: file.recorded,
    cycleCeilingPaise: ceiling,
    state: file,
  })

describe('what the planner refuses when an officer acts', () => {
  it('offers nothing to a file whose journey has ended', () => {
    expect(actionIsAvailable(examplePipeline, action(examplePipeline, 'TTC', 'REJECT'), state(null))).toBe(false)
  })

  it('refuses a choice that routes nowhere', () => {
    expect(planWith(examplePipeline, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK', {})).toEqual({ ok: false, refusal: 'Choose where to send it.', inputKey: 'BANK' })
  })

  it('refuses a return with nowhere to go', () => {
    expect(planWith(examplePipeline, 'SBI_BANK', 'SEND_BACK', { NOTE: 'Look again.' })).toMatchObject({ ok: false, refusal: 'This application has no earlier stage to return to.' })
  })

  it('refuses a bound whose answer the applicant never gave', () => {
    const noLoanAmount = state('SBI_BANK', { answers: { ...answers, LOAN_AMOUNT_REQUESTED_PAISE: null }, trail: ['INDUSTRIES_COMMERCE'] })
    expect(planWith(examplePipeline, 'SBI_BANK', 'FULFIL_LOAN', { AMOUNT: 10, REFERENCE: 'R', SANCTION_DATE: '2026-01-01' }, noLoanAmount))
      .toMatchObject({ ok: false, refusal: 'The applicant did not give the amount this is bounded by.', inputKey: 'AMOUNT' })
  })

  it('keeps nothing for an optional value left empty, and nothing for a blank note', () => {
    const definition = clone()
    const reject = action(definition, 'TTC', 'REJECT')
    reject.inputs[0]!.requirement = 'OPTIONAL'
    reject.effects.push({ type: 'SET_RECORDED_VALUE', params: { input: 'REASON', target: 'LOAN_REFERENCE' }, when: [] })
    const planned = planWith(definition, 'TTC', 'REJECT', { REASON: '' })
    expect(planned).toMatchObject({ ok: true, plan: { recorded: {}, internalNotes: [] } })
  })

  it('skips an effect whose condition does not hold, reading the officer’s own input', () => {
    const definition = clone()
    const approve = action(definition, 'INDUSTRIES_COMMERCE', 'APPROVE_GRANT')
    approve.inputs.push(input('CONFIRM', 'BOOLEAN'))
    approve.effects[2]!.when = [{ group: 1, source: 'INPUT', key: 'CONFIRM', operator: 'EQUALS', value: 'true', answerType: null }]
    const silent = planWith(definition, 'INDUSTRIES_COMMERCE', 'APPROVE_GRANT', { AMOUNT: 100, CONFIRM: false })
    const loud = planWith(definition, 'INDUSTRIES_COMMERCE', 'APPROVE_GRANT', { AMOUNT: 100, CONFIRM: true })
    expect(silent).toMatchObject({ ok: true, plan: { notifications: [] } })
    expect(loud).toMatchObject({ ok: true, plan: { notifications: [expect.objectContaining({ email: true })] } })
  })

  it('refuses two moves that fired together, whatever validation saw', () => {
    const definition = clone()
    action(definition, 'TTC', 'TO_INDUSTRIES_COMMERCE').effects.push({ type: 'CLOSE_APPLICATION', params: { flag: 'REJECTED' }, when: [] })
    expect(planWith(definition, 'TTC', 'TO_INDUSTRIES_COMMERCE', {})).toMatchObject({ ok: false, refusal: 'This action is configured to do two incompatible things at once.' })
  })

  it('reads a recorded value, and an undeclared one as never true', () => {
    const scope = { definition: examplePipeline, answers, flags: new Set<string>(), inputs: {}, action: null }
    const over = [{ group: 1, source: 'RECORDED_VALUE' as const, key: 'APPROVED_GRANT_PAISE', operator: 'GREATER_THAN' as const, value: '100', answerType: null }]
    expect(conditionsHold(over, { ...scope, recorded: { APPROVED_GRANT_PAISE: 500 } })).toBe(true)
    expect(conditionsHold(over, { ...scope, recorded: { APPROVED_GRANT_PAISE: 50 } })).toBe(false)
    expect(conditionsHold([{ ...over[0]!, key: 'NOTHING' }], { ...scope, recorded: { NOTHING: 500 } })).toBe(false)
    expect(conditionsHold([{ ...over[0]!, source: 'INPUT', key: 'AMOUNT' }], { ...scope, recorded: {}, inputs: { AMOUNT: 500 } })).toBe(false)
  })
})

describe('an action’s inputs, refused', () => {
  const now = new Date('2026-09-30T00:00:00Z')

  it('refuses an action whose stored inputs no longer form a form', () => {
    // An input shown only when it is itself answered: a cycle no order can resolve.
    const broken = structuredClone(action(examplePipeline, 'INDUSTRIES_COMMERCE', 'SEND_TO_BANK'))
    broken.inputs[0]!.visibleWhen = [{ group: 1, source: 'INPUT', key: 'BANK', operator: 'IS_PRESENT', value: null, answerType: null }]
    expect(validateActionInputs(broken, { BANK: 'SBI' }, now)).toEqual({
      ok: false,
      issues: [expect.objectContaining({ message: 'This action can no longer be taken.' })],
    })
  })

  it('refuses a key the action does not ask for, before anything else', () => {
    expect(validateActionInputs(action(examplePipeline, 'TTC', 'REJECT'), { REASON: 'No.', EXTRA: 1 }, now)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'UNKNOWN_FIELD' })],
    })
  })

  it('asks an input only when the input it depends on says so, and refuses an answer to one it did not ask', () => {
    const shaped = structuredClone(action(examplePipeline, 'TTC', 'REJECT'))
    shaped.inputs.unshift(input('EXPLAIN', 'BOOLEAN'))
    shaped.inputs[1]!.requirement = 'OPTIONAL'
    shaped.inputs[1]!.visibleWhen = [{ group: 1, source: 'INPUT', key: 'EXPLAIN', operator: 'EQUALS', value: 'true', answerType: null }]
    expect(validateActionInputs(shaped, { EXPLAIN: false, REASON: null }, now)).toEqual({ ok: true, values: { EXPLAIN: false, REASON: null } })
    expect(validateActionInputs(shaped, { EXPLAIN: true, REASON: 'Shown.' }, now)).toEqual({ ok: true, values: { EXPLAIN: true, REASON: 'Shown.' } })
    expect(validateActionInputs(shaped, { EXPLAIN: false, REASON: 'Hidden.' }, now)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'CONDITIONAL_FIELDS' })],
    })
  })
})

describe('the stage permission table', () => {
  it('answers each pair an effect can need, and holds nothing it does not know', () => {
    const holding = (...pairs: string[]) => ({
      permissions: pairs.map((pair) => {
        const [resource, act] = pair.split(':')
        return { resource, action: act }
      }),
    }) as never
    const every = ['stage:advance', 'stage:return', 'stage:request_revision', 'stage:decide', 'stage:close', 'application:note'] as const
    expect(holdsEvery(holding(...every), every)).toBe(true)
    expect(holdsEvery(holding(...every), ['stage:transfer' as never])).toBe(false)
    expect(holdsEvery(holding('stage:advance'), ['stage:advance', 'stage:close'])).toBe(false)
  })
})

describe('what an author may do', () => {
  it('keeps a long text as a text value, and offers an action by what an earlier one recorded', () => {
    const definition = clone()
    const reject = action(definition, 'TTC', 'REJECT')
    reject.effects.push({ type: 'SET_RECORDED_VALUE', params: { input: 'REASON', target: 'LOAN_REFERENCE' }, when: [] })
    action(definition, 'INDUSTRIES_COMMERCE', 'COMPLETE_WITHOUT_LOAN').availableWhen.push(
      { group: 2, source: 'RECORDED_VALUE', key: 'APPROVED_GRANT_PAISE', operator: 'IS_PRESENT', value: null, answerType: null },
    )
    expect(pipelineProblems(definition)).toEqual([])
  })
})
