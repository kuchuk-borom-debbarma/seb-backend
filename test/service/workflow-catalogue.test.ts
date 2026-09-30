/**
 * The workflow catalogue against the code, for what a regex cannot see.
 *
 * `check:workflow-catalog` proves every catalogue entry has registered code and
 * every registration is declared. This proves the registrations *agree* with
 * their declarations: that an effect's parameter schema has exactly the
 * parameters the catalogue lists, with the same optionality, that each
 * registry's keys are its handlers' own keys, and that the GraphQL enums a
 * client reads are the catalogue's sets.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  conditionSources,
  effectCatalogue,
  eligibilityCatalogue,
  inputFieldTypes,
  paramKinds,
} from '../../src/services/catalogue/workflow.generated'
import { eligibilityEvaluators } from '../../src/services/application/eligibility'
import { formRuleEvaluators } from '../../src/services/application/form/cross-field'
import { conditionSourceHandlers } from '../../src/services/pipeline/condition-sources'
import { effectHandlers } from '../../src/services/pipeline/effects'
import { paramKindHandlers } from '../../src/services/pipeline/param-kinds'

/** A strict object schema's keys, and which of them are optional. */
const shapeOf = (schema: z.ZodObject) =>
  Object.fromEntries(
    Object.entries(schema.shape).map(([name, field]) => [name, (field as z.ZodType).safeParse(undefined).success]),
  )

/** The catalogue's parameters in the same form: name → optional. */
const declared = (params: readonly { name: string; required: boolean }[]) =>
  Object.fromEntries(params.map((param) => [param.name, !param.required]))

describe('each registry', () => {
  it('holds each handler under its own key', () => {
    for (const registry of [effectHandlers, formRuleEvaluators, eligibilityEvaluators, paramKindHandlers, conditionSourceHandlers]) {
      for (const [key, handler] of Object.entries(registry)) expect((handler as { key: string }).key, key).toBe(key)
    }
    expect(Object.keys(paramKindHandlers).sort()).toEqual([...paramKinds].sort())
    expect(Object.keys(conditionSourceHandlers).sort()).toEqual([...conditionSources].sort())
  })
})

describe('an effect’s parameters', () => {
  it.each(Object.entries(effectCatalogue))('%s matches its declaration', (key, entry) => {
    const handler = effectHandlers[key as keyof typeof effectHandlers]
    expect(shapeOf(handler.params as unknown as z.ZodObject)).toEqual(declared(entry.params))
  })
})

describe('an eligibility rule’s parameters', () => {
  it.each(Object.entries(eligibilityCatalogue))('%s matches its declaration', (key, entry) => {
    const evaluator = eligibilityEvaluators[key as keyof typeof eligibilityEvaluators]
    expect(shapeOf(evaluator.params as unknown as z.ZodObject)).toEqual(declared(entry.params))
  })
})

describe('the catalogue as the API publishes it', () => {
  const sdl = (() => {
    try {
      return readFileSync('src/graphql/queries/admin/pipeline.graphql', 'utf8')
    } catch {
      return null
    }
  })()
  const enumValues = (name: string) => {
    if (!sdl) return null
    const start = sdl.indexOf(`enum ${name} {`)
    if (start < 0) return null
    return [...sdl.slice(start, sdl.indexOf('}', start)).matchAll(/^\s+([A-Z_]+)$/gmu)].map((match) => match[1]).sort()
  }

  it.each([
    ['PipelineEffectType', Object.keys(effectCatalogue)],
    ['PipelineConditionSource', [...conditionSources]],
    ['PipelineParamKind', [...paramKinds]],
    ['PipelineInputFieldType', [...inputFieldTypes]],
    ['EligibilityRuleType', Object.keys(eligibilityCatalogue)],
    ['FormRuleType', Object.keys(formRuleEvaluators)],
  ])('publishes %s as exactly the catalogue’s set', (name, expected) => {
    expect(enumValues(name as string), `enum ${name} in src/graphql/queries/admin/pipeline.graphql`).toEqual([...(expected as string[])].sort())
  })
})
