/**
 * Whether a pipeline document makes sense as a whole, and whether a cycle's
 * form can carry it.
 *
 * `definition.ts` is the syntax; this is the meaning. Every problem is returned
 * at its path, all at once, the way `formTemplateProblem` reports a form: an
 * author fixing one mistake at a time against a validator that stops at the
 * first is an author who gives up.
 *
 * The rules that protect people rather than tidiness are the ones that loosen
 * nothing:
 *
 * - only `REQUEST_REVISION` may give the applicant back their pen, and only
 *   resubmission takes it away (the effects enforce their half);
 * - a flag that ends the pipeline is added only by an effect that ends it;
 * - every action needs at least one permission, so no configured button is
 *   open to anybody who can see the file.
 */
import type { ResolvedFormTemplate } from '../application/form/types'
import { effectCatalogue } from '../catalogue/workflow.generated'
import {
  parseDefinition,
  type PipelineAction,
  type PipelineCondition,
  type PipelineDefinition,
  type PipelineStage,
} from './definition'
import { effectHandler } from './effects'
import { permissionsFor } from './engine'
import { actionInputTemplate } from './inputs'
import { paramKindHandlers } from './param-kinds'

export type PipelineProblem = { readonly path: string; readonly message: string }

const duplicates = (keys: readonly string[]): string[] =>
  [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))]

/** Checks a condition's key against what its source can read. */
const conditionProblems = (
  conditions: readonly PipelineCondition[],
  path: string,
  definition: PipelineDefinition,
  action: PipelineAction | null,
  allowInputs: boolean,
): PipelineProblem[] =>
  conditions.flatMap((condition, index): PipelineProblem[] => {
    const at = `${path}.${index}`
    switch (condition.source) {
      case 'INPUT':
        if (!allowInputs) return [{ path: at, message: 'An input cannot decide whether an action is offered before the officer fills it in.' }]
        return action?.inputs.some((input) => input.key === condition.key)
          ? []
          : [{ path: at, message: `This action has no input called ${condition.key}.` }]
      case 'STATUS_FLAG':
        return definition.statusFlags.some((flag) => flag.key === condition.key)
          ? []
          : [{ path: at, message: `No status flag is called ${condition.key}.` }]
      case 'RECORDED_VALUE':
        return definition.recordedValues.some((recorded) => recorded.key === condition.key)
          ? []
          : [{ path: at, message: `No recorded value is called ${condition.key}.` }]
      case 'ANSWER':
        return condition.answerType
          ? []
          : [{ path: at, message: 'Say what type the answer is, so it can be compared and checked against a cycle.' }]
    }
  })

/** Everything wrong with one action, at its path. */
const actionProblems = (
  definition: PipelineDefinition,
  stage: PipelineStage,
  action: PipelineAction,
  path: string,
): PipelineProblem[] => {
  const problems: PipelineProblem[] = []
  for (const key of duplicates(action.inputs.map((input) => input.key))) {
    problems.push({ path: `${path}.inputs`, message: `Two inputs are called ${key}.` })
  }
  if (actionInputTemplate(action) === null) {
    problems.push({ path: `${path}.inputs`, message: 'These inputs do not form a valid form: check choices have options and conditions point at earlier inputs.' })
  }
  action.inputs.forEach((input, index) => {
    if ((input.type === 'SINGLE_CHOICE' || input.type === 'MULTI_CHOICE') && input.options.length === 0) {
      problems.push({ path: `${path}.inputs.${index}.options`, message: `${input.key} offers no options.` })
    }
    if (input.defaultFrom?.source === 'RECORDED_VALUE' && !definition.recordedValues.some((value) => value.key === input.defaultFrom?.key)) {
      problems.push({ path: `${path}.inputs.${index}.defaultFrom`, message: `No recorded value is called ${input.defaultFrom.key}.` })
    }
    problems.push(...conditionProblems(input.visibleWhen, `${path}.inputs.${index}.visibleWhen`, definition, action, true))
  })
  problems.push(...conditionProblems(action.availableWhen, `${path}.availableWhen`, definition, action, false))

  let stageEffects = 0
  let lifecycleEffects = 0
  action.effects.forEach((effect, index) => {
    const at = `${path}.effects.${index}`
    const entry = effectCatalogue[effect.type]
    if (entry.exclusive === 'STAGE') stageEffects += 1
    if (entry.exclusive === 'LIFECYCLE') lifecycleEffects += 1
    problems.push(...conditionProblems(effect.when, `${at}.when`, definition, action, true))

    const handler = effectHandler(effect.type)
    const parsed = handler.params.safeParse(effect.params)
    if (!parsed.success) {
      problems.push(...parsed.error.issues.map((issue) => ({ path: `${at}.params.${issue.path.join('.')}`, message: issue.message })))
      return
    }
    // Each declared parameter checked for meaning by its kind, then the
    // effect's own document-level rules.
    for (const declared of entry.params) {
      const value = (parsed.data as Record<string, unknown>)[declared.name]
      if (value === undefined) continue
      const kind = paramKindHandlers[declared.kind]
      const shaped = kind.schema.safeParse(value)
      const problem = shaped.success
        ? kind.problem(value, { definition, action })
        : shaped.error.issues[0]?.message ?? 'Not a valid value.'
      if (problem) problems.push({ path: `${at}.params.${declared.name}`, message: problem })
    }
    for (const message of handler.validate?.(parsed.data, { definition, stage, action }) ?? []) {
      problems.push({ path: at, message })
    }
  })
  if (stageEffects > 1) problems.push({ path: `${path}.effects`, message: 'An action can move the application to one place at most.' })
  if (lifecycleEffects > 1) problems.push({ path: `${path}.effects`, message: 'An action can ask for one revision at most.' })
  if (stageEffects > 0 && lifecycleEffects > 0) {
    problems.push({ path: `${path}.effects`, message: 'An action cannot both move the application and hand it back to the applicant.' })
  }
  if (problems.length === 0 && permissionsFor(definition, action).length === 0) {
    problems.push({ path: `${path}.effects`, message: 'This action needs no permission, so anybody who can see the file could take it.' })
  }
  return problems
}

/** The stages one effect can send a file to: a fixed target, or every routed choice. */
const moveTargets = (effect: PipelineDefinition['stages'][number]['actions'][number]['effects'][number]): unknown[] => {
  const params = effect.params as Record<string, unknown>
  if (effect.type === 'MOVE_TO_STAGE') return [params.target]
  if (effect.type === 'MOVE_BY_CHOICE') return Object.values((params.routes ?? {}) as Record<string, unknown>)
  return []
}

/** Stages a file can reach from where it enters, by the moves configured. */
const reachableStages = (definition: PipelineDefinition): Set<string> => {
  const reached = new Set([definition.initialStageKey])
  const queue = [definition.initialStageKey]
  while (queue.length > 0) {
    const next = queue.shift()
    const stage = definition.stages.find((candidate) => candidate.key === next)
    const targets = (stage?.actions ?? []).flatMap((action) => action.effects.flatMap(moveTargets))
    for (const target of targets) {
      if (typeof target !== 'string' || reached.has(target)) continue
      reached.add(target)
      queue.push(target)
    }
  }
  return reached
}

/**
 * Everything wrong with a pipeline document, or nothing.
 *
 * Takes unparsed JSON on purpose: this is the one door a stored or submitted
 * document comes through before it may be published.
 */
export const pipelineProblems = (value: unknown): PipelineProblem[] => {
  const parsed = parseDefinition(value)
  if (!parsed.ok) return [...parsed.problems]
  const definition = parsed.definition
  const problems: PipelineProblem[] = []

  for (const key of duplicates(definition.stages.map((stage) => stage.key))) problems.push({ path: 'stages', message: `Two stages are called ${key}.` })
  for (const key of duplicates(definition.statusFlags.map((flag) => flag.key))) problems.push({ path: 'statusFlags', message: `Two flags are called ${key}.` })
  for (const key of duplicates(definition.recordedValues.map((value) => value.key))) problems.push({ path: 'recordedValues', message: `Two recorded values are called ${key}.` })

  if (!definition.stages.some((stage) => stage.key === definition.initialStageKey)) {
    problems.push({ path: 'initialStageKey', message: `No stage is called ${definition.initialStageKey}.` })
  }
  const ordinary = (key: string) => {
    const flag = definition.statusFlags.find((candidate) => candidate.key === key)
    if (!flag) return `No status flag is called ${key}.`
    if (flag.terminal) return `${key} ends the pipeline, so it cannot be held while the file is still being worked.`
    if (flag.applicantEdit !== 'NONE') return `${key} lets the applicant edit, so only a revision request may add it.`
    return null
  }
  definition.onSubmit.addFlags.forEach((key, index) => {
    const problem = ordinary(key)
    if (problem) problems.push({ path: `onSubmit.addFlags.${index}`, message: problem })
  })

  definition.stages.forEach((stage, stageIndex) => {
    const path = `stages.${stageIndex}`
    for (const key of duplicates(stage.actions.map((action) => action.key))) problems.push({ path: `${path}.actions`, message: `Two actions are called ${key}.` })
    stage.presenceFlags.forEach((key, index) => {
      const problem = ordinary(key)
      if (problem) problems.push({ path: `${path}.presenceFlags.${index}`, message: problem })
    })
    // A stage nobody can move a file out of is a place files go to stay.
    const leaves = stage.actions.some((action) => action.effects.some((effect) => effectCatalogue[effect.type].exclusive === 'STAGE'))
    if (!leaves) problems.push({ path: `${path}.actions`, message: `Nothing moves an application out of ${stage.key}.` })
    stage.actions.forEach((action, actionIndex) => {
      problems.push(...actionProblems(definition, stage, action, `${path}.actions.${actionIndex}`))
    })
  })

  const reached = reachableStages(definition)
  definition.stages.forEach((stage, index) => {
    if (!reached.has(stage.key)) problems.push({ path: `stages.${index}`, message: `No route reaches ${stage.key} from ${definition.initialStageKey}.` })
  })
  const ends = definition.stages
    .filter((stage) => reached.has(stage.key))
    .some((stage) => stage.actions.some((action) => action.effects.some((effect) => effectCatalogue[effect.type].terminal)))
  if (!ends) problems.push({ path: 'stages', message: 'No application can ever finish: add a stage action that completes or closes it.' })

  return problems
}

/** Every answer a pipeline reads, with the type it expects, and where. */
type AnswerReference = {
  key: string
  type: string | null
  path: string
  moneyBound: boolean
  /** For a pre-filled choice, the options the input offers. */
  options: readonly string[] | null
}

const answerReferences = (definition: PipelineDefinition): AnswerReference[] => {
  const found: AnswerReference[] = []
  const conditions = (list: readonly PipelineCondition[], path: string) =>
    list.forEach((condition, index) => {
      if (condition.source === 'ANSWER') found.push({ key: condition.key, type: condition.answerType, path: `${path}.${index}`, moneyBound: false, options: null })
    })
  definition.stages.forEach((stage, stageIndex) =>
    stage.actions.forEach((action, actionIndex) => {
      const path = `stages.${stageIndex}.actions.${actionIndex}`
      conditions(action.availableWhen, `${path}.availableWhen`)
      action.inputs.forEach((input, inputIndex) => {
        if (input.defaultFrom?.source === 'ANSWER') {
          found.push({
            key: input.defaultFrom.key,
            type: input.type,
            path: `${path}.inputs.${inputIndex}.defaultFrom`,
            moneyBound: false,
            options: input.options.length > 0 ? input.options.map((option) => option.value) : null,
          })
        }
      })
      action.effects.forEach((effect, effectIndex) => {
        conditions(effect.when, `${path}.effects.${effectIndex}.when`)
        const bound = (effect.params as Record<string, unknown>).atMostAnswer
        if (effect.type === 'SET_RECORDED_VALUE' && typeof bound === 'string') {
          found.push({ key: bound, type: null, path: `${path}.effects.${effectIndex}.params.atMostAnswer`, moneyBound: true, options: null })
        }
      })
    }),
  )
  return found
}

/**
 * Whether a cycle's frozen form can carry a pipeline.
 *
 * The two are authored apart, so this is checked when a cycle opens: every
 * answer the pipeline reads must be a top-level question of the form, of the
 * type the pipeline expects, and a pre-filled choice may only offer what the
 * input offers. Without it the mismatch would surface as a condition that is
 * silently never true, on the first file that reached it.
 */
export const pipelinePinProblems = (
  definition: PipelineDefinition,
  template: ResolvedFormTemplate,
): PipelineProblem[] =>
  answerReferences(definition).flatMap(({ key, type, path, moneyBound, options }): PipelineProblem[] => {
    const field = template.byKey.get(key)
    if (!field) return [{ path, message: `The form asks no question called ${key}.` }]
    if (field.repeatGroupKey !== null) return [{ path, message: `${key} is inside a repeated group, so it has no single answer.` }]
    if (moneyBound && field.type !== 'MONEY_PAISE' && field.type !== 'INTEGER') {
      return [{ path, message: `${key} is not an amount, so nothing can be bounded by it.` }]
    }
    if (type !== null && field.type !== type) return [{ path, message: `${key} is ${field.type} on this form, not ${type}.` }]
    // A pre-filled choice the input cannot offer would arrive as an answer
    // the officer is then refused for.
    const extra = options ? field.options.map((option) => option.value).filter((value) => !options.includes(value)) : []
    return extra.length ? [{ path, message: `${key} can be answered ${extra.join(', ')}, which this input does not offer.` }] : []
  })
