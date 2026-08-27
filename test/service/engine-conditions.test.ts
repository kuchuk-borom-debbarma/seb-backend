/**
 * Layer 2: the conditional truth table.
 *
 * Every operator against a matching value, a non-matching value, and no value
 * at all — then the column a naive engine gets wrong: **the controlling
 * question itself hidden.**
 *
 * That last one is the case where both behaviours look defensible. If a hidden
 * question's stored answer is still read, `isVisible` and `pruneHidden`
 * disagree: pruning clears the answer, which changes what is visible, which
 * changes what is pruned. The fixed point oscillates and the form flickers
 * between two shapes. Treating a hidden question as unanswered is what makes
 * the two agree, so it is asserted directly rather than left to follow from
 * the other cases.
 *
 * And the eight-row requirement table, of which exactly one row — required but
 * hidden — must produce no issue. Without that precedence a cycle can author a
 * form nobody can submit: a required question nothing can make visible.
 */
import { describe, expect, it } from 'vitest'
import { isRequiredWhenVisible, visibleFields } from '../../src/services/application/form/conditions'
import { pruneHidden } from '../../src/services/application/form/answers'
import {
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import type { FormTemplateRows } from '../../src/services/application/form/types'
import { answersFor, field, permissivePolicy, templateOf } from './support/template'

const NOW = new Date('2026-06-01T00:00:00Z')

type Operator = FormTemplateRows['conditions'][number]['operator']

/** `TARGET` is asked only when the rule on `SOURCE` holds. */
const gatedOn = (
  operator: Operator,
  sourceType: 'TEXT' | 'INTEGER' | 'BOOLEAN' | 'DATE' | 'MONEY_PAISE',
  comparisonValue: string | null,
  extra: Partial<FormTemplateRows['fields'][number]> = {},
) => templateOf(
  [
    field('SOURCE', sourceType, 1, { maxLength: sourceType === 'TEXT' ? 50 : null, ...extra }),
    field('TARGET', 'TEXT', 2, { maxLength: 50 }),
  ],
  [{
    fieldKey: 'TARGET',
    effect: 'VISIBLE_WHEN',
    groupNumber: 1,
    sequenceNumber: 1,
    sourceFieldKey: 'SOURCE',
    operator,
    comparisonValue,
  }],
)

const asks = (
  template: ReturnType<typeof templateOf>,
  answers: Record<string, unknown>,
): boolean => {
  const normalized = normalizeAnswers(template, answersFor(template, answers), NOW)
  expect(normalized.issues.filter((issue) => issue.field === 'SOURCE')).toEqual([])
  return visibleFields(template, normalized.value!).has('TARGET')
}

/* ------------------------------------------------------- every operator */

/**
 * Each operator with a value that matches, one that does not, and none.
 *
 * "Absent" is the third column throughout because it is the one a rule author
 * never thinks about: `LESS_THAN 10` reads as though an unanswered question
 * satisfies it, and an engine that compares `null` numerically would agree.
 */
const OPERATORS: Array<{
  operator: Operator
  sourceType: 'TEXT' | 'INTEGER' | 'BOOLEAN' | 'DATE' | 'MONEY_PAISE'
  comparisonValue: string | null
  matching: unknown
  notMatching: unknown
}> = [
  {
    operator: 'EQUALS', sourceType: 'TEXT', comparisonValue: 'YES',
    matching: 'YES', notMatching: 'NO',
  },
  {
    operator: 'NOT_EQUALS', sourceType: 'TEXT', comparisonValue: 'YES',
    matching: 'NO', notMatching: 'YES',
  },
  {
    operator: 'GREATER_THAN', sourceType: 'INTEGER', comparisonValue: '10',
    matching: 11, notMatching: 10,
  },
  {
    operator: 'GREATER_OR_EQUAL', sourceType: 'INTEGER', comparisonValue: '10',
    matching: 10, notMatching: 9,
  },
  {
    operator: 'LESS_THAN', sourceType: 'INTEGER', comparisonValue: '10',
    matching: 9, notMatching: 10,
  },
  {
    operator: 'LESS_OR_EQUAL', sourceType: 'INTEGER', comparisonValue: '10',
    matching: 10, notMatching: 11,
  },
  {
    operator: 'IS_PRESENT', sourceType: 'TEXT', comparisonValue: null,
    matching: 'anything', notMatching: null,
  },
  {
    operator: 'IS_ABSENT', sourceType: 'TEXT', comparisonValue: null,
    matching: null, notMatching: 'anything',
  },
]

describe('every condition operator', () => {
  it('is covered by this table', () => {
    const operators: Operator[] = [
      'EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'GREATER_OR_EQUAL',
      'LESS_THAN', 'LESS_OR_EQUAL', 'IS_PRESENT', 'IS_ABSENT',
    ]
    expect(operators.filter((op) => !OPERATORS.some((each) => each.operator === op))).toEqual([])
  })

  it.each(OPERATORS.map((each) => [each.operator, each] as const))(
    '%s asks the question when the answer matches',
    (_operator, entry) => {
      expect(asks(
        gatedOn(entry.operator, entry.sourceType, entry.comparisonValue),
        { SOURCE: entry.matching },
      )).toBe(true)
    },
  )

  it.each(OPERATORS.map((each) => [each.operator, each] as const))(
    '%s does not ask when the answer does not match',
    (_operator, entry) => {
      expect(asks(
        gatedOn(entry.operator, entry.sourceType, entry.comparisonValue),
        { SOURCE: entry.notMatching },
      )).toBe(false)
    },
  )

  /*
   * `IS_ABSENT` is the one operator an unanswered source satisfies, and it is
   * the only one that should. A comparison against nothing is not true — it is
   * unanswerable — so every ordering operator must read an unanswered source
   * as not matching rather than as zero or as the empty string.
   */
  it.each(OPERATORS.map((each) => [each.operator, each] as const))(
    '%s treats an unanswered question as satisfying it only if it is IS_ABSENT',
    (_operator, entry) => {
      expect(asks(
        gatedOn(entry.operator, entry.sourceType, entry.comparisonValue),
        { SOURCE: null },
      )).toBe(entry.operator === 'IS_ABSENT')
    },
  )
})

/* ------------------------------------------------ the hidden source case */

describe('a rule that reads a question which is itself hidden', () => {
  /**
   * `A` gates `B`, and `B` gates `C`.
   *
   * With `A` unanswered, `B` is not asked. `B` has a stored answer — the
   * applicant answered it before changing `A` — and that answer would satisfy
   * `C`'s rule if anything read it.
   */
  const chain = () => templateOf(
    [
      field('A', 'BOOLEAN', 1),
      field('B', 'TEXT', 2, { maxLength: 50 }),
      field('C', 'TEXT', 3, { maxLength: 50 }),
    ],
    [
      {
        fieldKey: 'B', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'A',
        operator: 'EQUALS', comparisonValue: 'true',
      },
      {
        fieldKey: 'C', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'B',
        operator: 'EQUALS', comparisonValue: 'OPEN',
      },
    ],
  )

  const withStaleAnswer = (a: unknown) => {
    const template = chain()
    const answers = normalizeAnswers(
      template, answersFor(template, { A: a, B: 'OPEN', C: 'something' }), NOW,
    ).value!
    return { template, answers }
  }

  it('asks the far question while the whole chain holds', () => {
    const { template, answers } = withStaleAnswer(true)
    expect([...visibleFields(template, answers)]).toContain('C')
  })

  it('stops asking it once the question its rule reads is hidden', () => {
    const { template, answers } = withStaleAnswer(false)
    expect([...visibleFields(template, answers)]).not.toContain('C')
  })

  it('clears the answers to the questions it stopped asking', () => {
    const { template, answers } = withStaleAnswer(false)
    const pruned = pruneHidden(template, answers)
    expect(pruned.B ?? null).toBeNull()
    expect(pruned.C ?? null).toBeNull()
  })
})

/**
 * Pruning settles, and it settles immediately.
 *
 * The loop in `pruneHidden` runs until nothing changes, and the obvious test
 * for it is a chain that needs more than one pass. **No such chain exists**,
 * and that is worth stating rather than working around: because a hidden
 * question's answer already reads as absent, one evaluation of visibility is
 * already the final one. Every template tried here — including the awkward
 * case below, where clearing an answer makes another question *appear* —
 * reaches its fixed point in a single pass.
 *
 * So these tests assert what is actually true: pruning settles, and it does
 * not throw away an answer to a question its own clearing revealed. Both were
 * run against a deliberately single-pass build and both passed, which is why
 * the loop is documented as a bound rather than as a requirement.
 */
describe('pruning settles', () => {
  /*
   * `SHOW_WHEN_BLANK` is asked when `DETAIL` has no answer. Turning `GATE` off
   * hides `DETAIL`, whose answer then reads as absent — which is what makes
   * `SHOW_WHEN_BLANK` appear. An implementation that read the stored answer of
   * a hidden question would hide it instead, and clear something the applicant
   * should still see.
   */
  const appearing = () => templateOf(
    [
      field('GATE', 'BOOLEAN', 1),
      field('DETAIL', 'TEXT', 2, { maxLength: 50 }),
      field('SHOW_WHEN_BLANK', 'TEXT', 3, { maxLength: 50 }),
    ],
    [
      {
        fieldKey: 'DETAIL', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'GATE', operator: 'EQUALS', comparisonValue: 'true',
      },
      {
        fieldKey: 'SHOW_WHEN_BLANK', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'DETAIL', operator: 'IS_ABSENT', comparisonValue: null,
      },
    ],
  )

  const prunedChain = () => {
    const template = appearing()
    const answers = normalizeAnswers(template, answersFor(template, {
      GATE: false, DETAIL: 'filled in earlier', SHOW_WHEN_BLANK: 'still wanted',
    }), NOW).value!
    return { template, answers }
  }

  it('keeps an answer to a question that only appears once another is cleared', () => {
    const { template, answers } = prunedChain()
    const pruned = pruneHidden(template, answers)
    expect(pruned.DETAIL ?? null, 'the hidden question is cleared').toBeNull()
    expect(pruned.SHOW_WHEN_BLANK, 'the question its clearing reveals is kept')
      .toBe('still wanted')
  })

  it('pruning twice is the same as pruning once', () => {
    const { template, answers } = prunedChain()
    const once = pruneHidden(template, answers)
    expect(pruneHidden(template, once)).toEqual(once)
  })
})

describe('whether a question must be answered', () => {
  /**
   * The eight rows, of which exactly one must produce no issue.
   *
   * "Required but hidden" is that row. Without it a cycle can author a form
   * nobody can submit — a required question nothing can make visible — and the
   * applicant is told to answer something that is not on their screen.
   */
  const table: Array<{
    requirement: 'REQUIRED' | 'CONDITIONAL' | 'OPTIONAL'
    gated: boolean
    visible: boolean
    required: boolean
  }> = [
    { requirement: 'REQUIRED', gated: false, visible: true, required: true },
    { requirement: 'REQUIRED', gated: true, visible: true, required: true },
    { requirement: 'REQUIRED', gated: true, visible: false, required: false },
    { requirement: 'CONDITIONAL', gated: true, visible: true, required: true },
    { requirement: 'CONDITIONAL', gated: true, visible: false, required: false },
    { requirement: 'OPTIONAL', gated: false, visible: true, required: false },
    { requirement: 'OPTIONAL', gated: true, visible: true, required: false },
    { requirement: 'OPTIONAL', gated: true, visible: false, required: false },
  ]

  it.each(table.map((row) => [
    `${row.requirement}, ${row.gated ? 'gated' : 'ungated'}, ${row.visible ? 'shown' : 'hidden'}`,
    row,
  ] as const))('%s', (_label, row) => {
    const conditions: FormTemplateRows['conditions'] = row.gated
      ? [{
          fieldKey: 'TARGET',
          effect: row.requirement === 'CONDITIONAL' ? 'REQUIRED_WHEN' : 'VISIBLE_WHEN',
          groupNumber: 1,
          sequenceNumber: 1,
          sourceFieldKey: 'SOURCE',
          operator: 'EQUALS',
          comparisonValue: 'true',
        }]
      : []
    const template = templateOf(
      [
        field('SOURCE', 'BOOLEAN', 1),
        field('TARGET', 'TEXT', 2, { maxLength: 50, requirement: row.requirement }),
      ],
      conditions,
    )
    const answers = normalizeAnswers(
      template, answersFor(template, { SOURCE: row.visible, TARGET: null }), NOW,
    ).value!
    const target = template.fields.find((each) => each.key === 'TARGET')!
    const visible = visibleFields(template, answers)
    const shown = visible.has('TARGET')

    /*
     * A `REQUIRED_WHEN` rule does not hide its question — it is asked either
     * way and only becomes mandatory when the rule holds. `VISIBLE_WHEN` does
     * hide it. The table's `visible` column is the answer to the source, so
     * what "shown" means differs between the two, and both are asserted
     * against the requirement rather than assumed.
     */
    if (row.requirement === 'CONDITIONAL') expect(shown).toBe(true)
    else expect(shown).toBe(row.gated ? row.visible : true)

    expect(shown && isRequiredWhenVisible(template, target, answers, visible))
      .toBe(row.required)

    const report = validateAnswersForSubmission(
      template, answers, new Set(), NOW, permissivePolicy,
    )
    expect(report.issues.some((issue) => issue.field === 'TARGET')).toBe(row.required)
  })

  it('never asks for an answer to a question it is not showing', () => {
    for (const row of table.filter((each) => !each.visible && each.gated)) {
      expect(row.required, `${row.requirement} hidden must not be required`).toBe(false)
    }
  })
})
