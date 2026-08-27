/**
 * What a cycle's template decides is asked, and what it decides must be
 * answered.
 *
 * These are the rules a hand-written validator used to state one question at a
 * time and the engine now states once for every question, so they are the ones
 * worth pinning down hardest. Each case names the wrong behaviour it excludes.
 */
import { describe, expect, it } from 'vitest'
import {
  isRequiredWhenVisible,
  visibleFields,
} from '../../src/services/application/form/conditions'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import type { FormTemplateRows } from '../../src/services/application/form/types'

type FieldRow = FormTemplateRows['fields'][number]

const field = (
  fieldKey: string,
  fieldType: FieldRow['fieldType'],
  sortOrder: number,
  extra: Partial<FieldRow> = {},
): FieldRow => ({
  stageKey: 'MAIN',
  fieldKey,
  fieldType,
  role: null,
  label: fieldKey,
  helpText: null,
  requirement: 'OPTIONAL',
  source: 'APPLICANT',
  sortOrder,
  parentFieldKey: null,
  repeatMin: null,
  repeatMax: null,
  minLength: null,
  maxLength: null,
  pattern: null,
  patternMessage: null,
  minValue: null,
  maxValue: null,
  minDate: null,
  maxDate: null,
  relativeDateBound: null,
  maxFileBytes: null,
  ...extra,
})

/**
 * The two role bindings every cycle must carry before it can be opened.
 *
 * Present in each fixture because `resolveFormTemplate` refuses a template with
 * a role unbound — the decision bound and the age rule resolve their inputs
 * through those roles, so a template without them describes a form no staff
 * screen could read.
 */
const roleFields: FieldRow[] = [
  field('DATE_OF_BIRTH', 'DATE', 94, { role: 'APPLICANT_DATE_OF_BIRTH' }),
  field('SEED_FUND_REQUESTED_PAISE', 'MONEY_PAISE', 95, {
    role: 'SEED_FUND_REQUESTED_PAISE',
    minValue: 0,
  }),
]

const roleOptions: FormTemplateRows['options'] = []

const templateOf = (
  fields: FieldRow[],
  conditions: FormTemplateRows['conditions'] = [],
  options: FormTemplateRows['options'] = [],
) =>
  resolveFormTemplate({
    programmeCycleId: 'c1',
    programmeCycleVersion: 1,
    stages: [{ stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 }],
    fields: [...fields, ...roleFields],
    options: [...options, ...roleOptions],
    conditions,
  })

/** A → B → C: answering A hides B, and C is only asked once B is answered. */
const chainTemplate = () =>
  templateOf(
    [
      field('A_FLAG', 'BOOLEAN', 1),
      field('B_TEXT', 'TEXT', 2, { maxLength: 200 }),
      field('C_TEXT', 'TEXT', 3, { maxLength: 200, requirement: 'CONDITIONAL' }),
    ],
    [
      {
        fieldKey: 'B_TEXT', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'A_FLAG', operator: 'EQUALS', comparisonValue: 'true',
      },
      {
        fieldKey: 'C_TEXT', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'B_TEXT', operator: 'IS_PRESENT', comparisonValue: null,
      },
      {
        fieldKey: 'C_TEXT', effect: 'REQUIRED_WHEN', groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'B_TEXT', operator: 'IS_PRESENT', comparisonValue: null,
      },
    ],
  )

describe('which questions a template asks', () => {
  it('asks a conditional question once its condition holds', () => {
    const template = chainTemplate()!
    const visible = visibleFields(template, { A_FLAG: true, B_TEXT: 'a name', C_TEXT: null })
    expect(visible.has('B_TEXT')).toBe(true)
    expect(visible.has('C_TEXT')).toBe(true)
  })

  it('does not ask a question whose condition does not hold', () => {
    const template = chainTemplate()!
    expect(visibleFields(template, { A_FLAG: false, B_TEXT: null, C_TEXT: null }).has('B_TEXT'))
      .toBe(false)
  })

  it('treats an unanswered controlling question as not satisfying its condition', () => {
    const template = chainTemplate()!
    expect(visibleFields(template, { A_FLAG: null, B_TEXT: null, C_TEXT: null }).has('B_TEXT'))
      .toBe(false)
  })

  /*
   * The case a single-pass evaluator gets wrong.
   *
   * B still holds a stale answer from before A was changed, so anything reading
   * the raw answer map sees B as answered and keeps C on the screen. C must go
   * too, because a question reached only through a question nobody was asked is
   * itself a question nobody was asked.
   */
  it('stops asking a question whose controlling question has itself stopped being asked', () => {
    const template = chainTemplate()!
    const stale = { A_FLAG: false, B_TEXT: 'left over from before', C_TEXT: null }
    const visible = visibleFields(template, stale)
    expect(visible.has('B_TEXT')).toBe(false)
    expect(visible.has('C_TEXT')).toBe(false)
  })
})

describe('which questions must be answered', () => {
  it('requires a conditional question when its rule holds', () => {
    const template = chainTemplate()!
    const answers = { A_FLAG: true, B_TEXT: 'a name', C_TEXT: null }
    const visible = visibleFields(template, answers)
    expect(isRequiredWhenVisible(template, template.byKey.get('C_TEXT')!, answers, visible))
      .toBe(true)
  })

  /*
   * Without this precedence a template can deadlock a form: a question that
   * must be answered and cannot be shown blocks submission with an issue
   * pointing at a control that is not on the screen.
   */
  it('never requires a question it is not asking', () => {
    const template = chainTemplate()!
    const answers = { A_FLAG: false, B_TEXT: 'left over from before', C_TEXT: null }
    const visible = visibleFields(template, answers)
    expect(visible.has('C_TEXT')).toBe(false)
    expect(isRequiredWhenVisible(template, template.byKey.get('C_TEXT')!, answers, visible))
      .toBe(false)
  })
})

describe('templates a request must never accept', () => {
  it('refuses a template whose questions depend on each other in a circle', () => {
    const cyclic = templateOf(
      [field('B_TEXT', 'TEXT', 2, { maxLength: 200 }), field('C_TEXT', 'TEXT', 3, { maxLength: 200 })],
      [
        {
          fieldKey: 'B_TEXT', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
          sourceFieldKey: 'C_TEXT', operator: 'IS_PRESENT', comparisonValue: null,
        },
        {
          fieldKey: 'C_TEXT', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
          sourceFieldKey: 'B_TEXT', operator: 'IS_PRESENT', comparisonValue: null,
        },
      ],
    )
    expect(cyclic).toBeNull()
  })

  it('refuses a template that leaves a role unbound', () => {
    const missingRole = resolveFormTemplate({
      programmeCycleId: 'c1',
      programmeCycleVersion: 1,
      stages: [{ stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 }],
      fields: roleFields.filter((f) => f.fieldKey !== 'SEED_FUND_REQUESTED_PAISE'),
      options: roleOptions,
      conditions: [],
    })
    expect(missingRole).toBeNull()
  })

  it('refuses a condition naming a question the template does not declare', () => {
    const dangling = templateOf(
      [field('B_TEXT', 'TEXT', 2, { maxLength: 200 })],
      [
        {
          fieldKey: 'B_TEXT', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
          sourceFieldKey: 'NO_SUCH_FIELD', operator: 'IS_PRESENT', comparisonValue: null,
        },
      ],
    )
    expect(dangling).toBeNull()
  })
})

describe('combining several conditions on one question', () => {
  const twoRules = (groupNumbers: [number, number]) =>
    templateOf(
      [
        field('A_FLAG', 'BOOLEAN', 1),
        field('B_FLAG', 'BOOLEAN', 2),
        field('TARGET', 'TEXT', 3, { maxLength: 200 }),
      ],
      [
        {
          fieldKey: 'TARGET', effect: 'VISIBLE_WHEN', groupNumber: groupNumbers[0], sequenceNumber: 1,
          sourceFieldKey: 'A_FLAG', operator: 'EQUALS', comparisonValue: 'true',
        },
        {
          fieldKey: 'TARGET', effect: 'VISIBLE_WHEN', groupNumber: groupNumbers[1], sequenceNumber: 2,
          sourceFieldKey: 'B_FLAG', operator: 'EQUALS', comparisonValue: 'true',
        },
      ],
    )

  it('requires every condition in one group to hold', () => {
    const template = twoRules([1, 1])!
    expect(visibleFields(template, { A_FLAG: true, B_FLAG: false, TARGET: null }).has('TARGET'))
      .toBe(false)
    expect(visibleFields(template, { A_FLAG: true, B_FLAG: true, TARGET: null }).has('TARGET'))
      .toBe(true)
  })

  it('treats separate groups as alternatives', () => {
    const template = twoRules([1, 2])!
    expect(visibleFields(template, { A_FLAG: true, B_FLAG: false, TARGET: null }).has('TARGET'))
      .toBe(true)
    expect(visibleFields(template, { A_FLAG: false, B_FLAG: false, TARGET: null }).has('TARGET'))
      .toBe(false)
  })
})
