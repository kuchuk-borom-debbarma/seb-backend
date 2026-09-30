/**
 * `resolveFormTemplate` refusing rows that describe no form, and ordering the
 * ones that do.
 *
 * The rows reach it only through an authoring write that already refused an
 * incoherent form, so every refusal here is about rows edited by hand — or by
 * a migration — into something no screen could render. It answers null rather
 * than throwing, and each caller turns that into a sentence, so the test is
 * that each such shape is recognised: a question inside something that is not
 * a group, a rule over a question the form does not ask, two stages with one
 * key. And the order it hands back must not depend on the order rows came out
 * of the database, which is what the ties below pin.
 */
import { describe, expect, it } from 'vitest'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import type { FormTemplateRows } from '../../src/services/application/form/types'
import { field, roleFields } from './support/template'

const stage = (stageKey: string, sortOrder: number) => ({ stageKey, title: stageKey, description: null, sortOrder })

const rowsOf = (overrides: Partial<FormTemplateRows> = {}): FormTemplateRows => ({
  programmeCycleId: 'c1',
  programmeCycleVersion: 1,
  stages: [stage('MAIN', 1)],
  fields: [field('WANTS_GRANT', 'BOOLEAN', 1), field('WANTS_BANK_LOAN', 'BOOLEAN', 2), ...roleFields],
  options: [],
  conditions: [],
  ...overrides,
})

const rule = (overrides: Partial<NonNullable<FormTemplateRows['rules']>[number]> = {}) => ({
  ruleKey: 'GRANT_OR_LOAN',
  ruleType: 'AT_LEAST_ONE_TRUE' as const,
  stageKey: 'MAIN',
  message: 'Ask for a grant, a loan, or both.',
  limitValue: null,
  operandKeys: ['WANTS_GRANT', 'WANTS_BANK_LOAN'],
  ...overrides,
})

describe('rows that describe no form', () => {
  const refused: [string, Partial<FormTemplateRows>][] = [
    ['two stages with one key', { stages: [stage('MAIN', 1), stage('MAIN', 2)] }],
    ['a question on a stage that is not there', { fields: [field('ORPHAN', 'TEXT', 1, { stageKey: 'NOWHERE' }), ...roleFields] }],
    ['a member of something that is not a group', {
      fields: [field('NAME', 'TEXT', 1), field('MEMBER', 'TEXT', 2, { parentFieldKey: 'NAME' }), ...roleFields],
    }],
    ['a member of a group that is not there', {
      fields: [field('MEMBER', 'TEXT', 2, { parentFieldKey: 'GHOST' }), ...roleFields],
    }],
    ['a rule shown on a stage that is not there', { rules: [rule({ stageKey: 'NOWHERE' })] }],
    ['a rule over a question the form does not ask', { rules: [rule({ operandKeys: ['WANTS_GRANT', 'WANTS_A_PONY'] })] }],
    ['a rule over a statement', {
      fields: [field('WANTS_GRANT', 'BOOLEAN', 1), field('NOTICE', 'STATEMENT', 2), ...roleFields],
      rules: [rule({ operandKeys: ['WANTS_GRANT', 'NOTICE'] })],
    }],
    ['a rule over a group member', {
      fields: [
        field('WANTS_GRANT', 'BOOLEAN', 1),
        field('OWNERS', 'REPEAT_GROUP', 2, { repeatMin: 1, repeatMax: 3 }),
        field('OWNER_AGREES', 'BOOLEAN', 3, { parentFieldKey: 'OWNERS' }),
        ...roleFields,
      ],
      rules: [rule({ operandKeys: ['WANTS_GRANT', 'OWNER_AGREES'] })],
    }],
  ]

  it.each(refused)('is refused for %s', (_name, overrides) => {
    expect(resolveFormTemplate(rowsOf(overrides))).toBeNull()
  })

  it('resolves the same rows without the mistake, rules and all', () => {
    const resolved = resolveFormTemplate(rowsOf({ rules: [rule()] }))
    expect(resolved?.rules).toEqual([{
      key: 'GRANT_OR_LOAN',
      type: 'AT_LEAST_ONE_TRUE',
      stageKey: 'MAIN',
      message: 'Ask for a grant, a loan, or both.',
      limit: null,
      operandKeys: ['WANTS_GRANT', 'WANTS_BANK_LOAN'],
    }])
  })
})

describe('the order it hands back', () => {
  it('breaks ties by key, whatever order the rows arrived in', () => {
    const resolved = resolveFormTemplate(rowsOf({
      stages: [stage('ZETA', 2), stage('ALPHA', 1)],
      fields: [
        field('SECOND', 'SINGLE_CHOICE', 1, { stageKey: 'ALPHA' }),
        field('FIRST', 'TEXT', 1, { stageKey: 'ALPHA' }),
        field('LATER', 'TEXT', 1, { stageKey: 'ZETA' }),
        ...roleFields.map((each) => ({ ...each, stageKey: 'ZETA' })),
      ],
      options: [
        { fieldKey: 'SECOND', optionValue: 'TGB', optionLabel: 'TGB', sortOrder: 1 },
        { fieldKey: 'SECOND', optionValue: 'SBI', optionLabel: 'SBI', sortOrder: 1 },
      ],
      rules: [rule({ ruleKey: 'Z_RULE', stageKey: 'ZETA', operandKeys: ['FIRST', 'LATER'], ruleType: 'DIFFERENT_VALUES' }), rule({ ruleKey: 'A_RULE', stageKey: 'ZETA', operandKeys: ['FIRST', 'LATER'], ruleType: 'DIFFERENT_VALUES' })],
    }))
    expect(resolved?.stages.map((each) => each.key)).toEqual(['ALPHA', 'ZETA'])
    // Two stages at one position fall back to their keys.
    const tied = resolveFormTemplate(rowsOf({ stages: [stage('ZETA', 1), stage('MAIN', 1)] }))
    expect(tied?.stages.map((each) => each.key)).toEqual(['MAIN', 'ZETA'])
    expect(resolved?.fields.slice(0, 3).map((each) => each.key)).toEqual(['FIRST', 'SECOND', 'LATER'])
    expect(resolved?.byKey.get('SECOND')?.options.map((option) => option.value)).toEqual(['SBI', 'TGB'])
    expect(resolved?.rules.map((each) => each.key)).toEqual(['A_RULE', 'Z_RULE'])
  })
})
