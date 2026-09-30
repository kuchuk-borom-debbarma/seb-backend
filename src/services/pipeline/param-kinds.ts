/**
 * How each kind of parameter is checked when a pipeline or a cycle's
 * eligibility rules are validated.
 *
 * A parameter's *shape* is its handler's schema; its *meaning* is here — that a
 * STAGE_KEY names a stage of this pipeline, that a STATUS_FLAG_KEY names a flag
 * it declares. ANSWER_KEY and APPLICATION_KIND_KEY are checked only for form
 * here, because what they refer to belongs to a cycle, and are checked for
 * meaning when a cycle pins the pipeline or saves its kinds.
 */
import { z } from 'zod'
import { TEMPLATE_KEY_PATTERN } from '../../db/schema'
import type { ParamKind } from '../catalogue/workflow.generated'
import { defineParamKind, type ParamKindHandler } from './registry'

const key = z.string().regex(new RegExp(TEMPLATE_KEY_PATTERN, 'u'))

const stageKey = defineParamKind('STAGE_KEY', {
  schema: key,
  problem: (value, { definition }) =>
    definition && !definition.stages.some((stage) => stage.key === value) ? `No stage is called ${String(value)}.` : null,
})

const statusFlagKey = defineParamKind('STATUS_FLAG_KEY', {
  schema: key,
  problem: (value, { definition }) =>
    definition && !definition.statusFlags.some((flag) => flag.key === value) ? `No status flag is called ${String(value)}.` : null,
})

const inputKey = defineParamKind('INPUT_KEY', {
  schema: key,
  problem: (value, { action }) =>
    action && !action.inputs.some((input) => input.key === value) ? `This action has no input called ${String(value)}.` : null,
})

const answerKey = defineParamKind('ANSWER_KEY', {
  schema: key,
  // Which forms will pin this pipeline is not known yet; `pipelinePinProblem`
  // checks the key against each cycle's frozen form when the cycle opens.
  problem: () => null,
})

const recordedValueKey = defineParamKind('RECORDED_VALUE_KEY', {
  schema: key,
  problem: (value, { definition }) =>
    definition && !definition.recordedValues.some((recorded) => recorded.key === value)
      ? `No recorded value is called ${String(value)}.`
      : null,
})

const choiceRoutes = defineParamKind('CHOICE_ROUTES', {
  schema: z.record(key, key),
  problem: (value, { definition }) => {
    if (!definition) return null
    const unknown = Object.values(value as Record<string, string>).filter(
      (target) => !definition.stages.some((stage) => stage.key === target),
    )
    return unknown.length ? `A route goes to ${unknown.join(', ')}, which is not a stage.` : null
  },
})

const fixedText = defineParamKind('TEXT', { schema: z.string().trim().min(1).max(500), problem: () => null })
const fixedBoolean = defineParamKind('BOOLEAN', { schema: z.boolean(), problem: () => null })
const count = defineParamKind('COUNT', { schema: z.number().int().min(0).max(10_000), problem: () => null })
const money = defineParamKind('MONEY_PAISE', {
  schema: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  problem: () => null,
})

const applicationKindKey = defineParamKind('APPLICATION_KIND_KEY', {
  schema: key,
  problem: (value, { applicationKinds }) =>
    applicationKinds && !applicationKinds.has(value as string) ? `The cycle declares no application kind called ${String(value)}.` : null,
})

const pipelineKey = defineParamKind('PIPELINE_KEY', {
  schema: key,
  // Any pipeline, including one retired since: eligibility may look back at
  // applications worked under a pipeline nobody authors any more.
  problem: () => null,
})

export const paramKindHandlers = {
  STAGE_KEY: stageKey,
  STATUS_FLAG_KEY: statusFlagKey,
  INPUT_KEY: inputKey,
  ANSWER_KEY: answerKey,
  RECORDED_VALUE_KEY: recordedValueKey,
  CHOICE_ROUTES: choiceRoutes,
  TEXT: fixedText,
  BOOLEAN: fixedBoolean,
  COUNT: count,
  MONEY_PAISE: money,
  APPLICATION_KIND_KEY: applicationKindKey,
  PIPELINE_KEY: pipelineKey,
} satisfies Record<ParamKind, ParamKindHandler>
