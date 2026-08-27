/**
 * What the engine accepts and what it refuses, per declared type.
 *
 * The old validator stated one rule per question and could be read in full. The
 * engine states each rule once for every question, so it can be wrong in more
 * ways and each way is quieter — the failure mode is a bad application accepted
 * rather than an exception. These tests are the replacement for reading it.
 *
 * `it.each` is introduced here deliberately, and this repository had none. Its
 * one hand-rolled table loop puts every row inside a single `it`, so the first
 * failing row hides the rest and the report names none of them. At this many
 * rows that is not a usable failure; a row in the test title is.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import { pruneHidden, answersEqual, changedStageKeys } from '../../src/services/application/form/answers'
import {
  answersFor,
  field,
  permissivePolicy,
  templateOf,
} from './support/template'

const NOW = new Date('2026-01-15T12:00:00Z')
const NO_DOCUMENTS = new Set<string>()

/** Normalizes a complete answer set with one field overridden. */
const normalizeWith = (
  extraFields: Parameters<typeof templateOf>[0],
  overrides: Record<string, unknown>,
) => {
  const template = templateOf(extraFields)
  return {
    template,
    result: normalizeAnswers(template, answersFor(template, overrides), NOW),
  }
}

const codesOf = (result: { issues: readonly { code: string }[] }) =>
  result.issues.map((i) => i.code)

describe('reading an answer of each declared type', () => {
  const cases: [string, Parameters<typeof templateOf>[0], unknown, string | null][] = [
    ['TEXT accepts text', [field('F', 'TEXT', 1, { maxLength: 50 })], 'hello', null],
    ['TEXT refuses a number', [field('F', 'TEXT', 1, { maxLength: 50 })], 42, 'INVALID_TYPE'],
    ['TEXT refuses a list', [field('F', 'TEXT', 1, { maxLength: 50 })], ['a'], 'INVALID_TYPE'],
    ['INTEGER accepts a whole number', [field('F', 'INTEGER', 1)], 7, null],
    ['INTEGER refuses text', [field('F', 'INTEGER', 1)], '7', 'INVALID_INTEGER'],
    ['INTEGER refuses a fraction', [field('F', 'INTEGER', 1)], 7.5, 'INVALID_INTEGER'],
    ['INTEGER refuses infinity', [field('F', 'INTEGER', 1)], Number.POSITIVE_INFINITY, 'INVALID_INTEGER'],
    ['MONEY accepts paise', [field('F', 'MONEY_PAISE', 1, { minValue: 0 })], 100_00, null],
    ['MONEY refuses a negative amount', [field('F', 'MONEY_PAISE', 1, { minValue: 0 })], -1, 'INVALID_MONEY'],
    ['MONEY refuses a fraction of a paisa', [field('F', 'MONEY_PAISE', 1, { minValue: 0 })], 10.5, 'INVALID_MONEY'],
    ['BOOLEAN accepts yes', [field('F', 'BOOLEAN', 1)], true, null],
    ['BOOLEAN refuses the string "true"', [field('F', 'BOOLEAN', 1)], 'true', 'INVALID_BOOLEAN'],
    ['DATE accepts a calendar day', [field('F', 'DATE', 1)], '2024-02-29', null],
    ['DATE refuses a day that does not exist', [field('F', 'DATE', 1)], '2025-02-31', 'INVALID_DATE'],
    ['DATE refuses a timestamp', [field('F', 'DATE', 1)], '2025-01-01T00:00:00Z', 'INVALID_DATE'],
    ['SINGLE_CHOICE refuses a value not offered', [field('F', 'SINGLE_CHOICE', 1)], 'NOPE', 'INVALID_ENUM'],
    ['MULTI_CHOICE refuses a value not offered', [field('F', 'MULTI_CHOICE', 1)], ['NOPE'], 'INVALID_ENUM'],
    ['MULTI_CHOICE refuses the same choice twice', [field('F', 'MULTI_CHOICE', 1)], ['A', 'A'], 'DUPLICATE_SELECTION'],
    ['FILE refuses being answered at all', [field('F', 'FILE', 1, { maxFileBytes: 1000 })], 'x', 'FILE_ANSWER_NOT_ALLOWED'],
  ]

  it.each(cases)('%s', (_label, fields, value, expectedCode) => {
    const options =
      fields?.some((f) => f.fieldType === 'SINGLE_CHOICE' || f.fieldType === 'MULTI_CHOICE')
        ? [{ fieldKey: 'F', optionValue: 'A', optionLabel: 'A', sortOrder: 1 }]
        : []
    const template = templateOf(fields, [], options)
    const answers = answersFor(template, { F: value })
    const result = normalizeAnswers(template, answers, NOW)
    if (expectedCode === null) {
      expect(result.issues).toEqual([])
      expect(result.value).not.toBeNull()
    } else {
      expect(codesOf(result)).toContain(expectedCode)
    }
  })

  // A table that silently generated no rows would look identical to one that
  // generated many and passed. Assert the count so a collapsed table is red.
  it('runs every case in the table', () => {
    expect(cases).toHaveLength(19)
  })
})

describe('bounds at their exact edge', () => {
  /*
   * The boundary trio is the point of this block. An engine that used `>` where
   * it meant `>=` passes every test that only tries a clearly-valid and a
   * clearly-invalid value.
   */
  const lengthCases: [number, string | null][] = [
    [4, 'TOO_SHORT'],
    [5, null],
    [10, null],
    [11, 'TOO_LONG'],
  ]
  it.each(lengthCases)('a %i-character answer against a 5..10 range', (length, expected) => {
    const { result } = normalizeWith(
      [field('F', 'TEXT', 1, { minLength: 5, maxLength: 10 })],
      { F: 'x'.repeat(length) },
    )
    if (expected === null) expect(result.issues).toEqual([])
    else expect(codesOf(result)).toContain(expected)
  })

  const amountCases: [number, string | null][] = [
    [99, 'TOO_SMALL'],
    [100, null],
    [500, null],
    [501, 'TOO_LARGE'],
  ]
  it.each(amountCases)('an amount of %i against a 100..500 range', (amount, expected) => {
    const { result } = normalizeWith(
      [field('F', 'MONEY_PAISE', 1, { minValue: 100, maxValue: 500 })],
      { F: amount },
    )
    if (expected === null) expect(result.issues).toEqual([])
    else expect(codesOf(result)).toContain(expected)
  })
})

describe('patterns a cycle declares', () => {
  const patterned = [
    field('F', 'TEXT', 1, {
      maxLength: 6,
      pattern: '\\d{6}',
      patternMessage: 'Enter six digits.',
    }),
  ]

  it('accepts a value the pattern matches', () => {
    const { result } = normalizeWith(patterned, { F: '799001' })
    expect(result.issues).toEqual([])
  })

  /*
   * `RegExp.test` searches rather than matching whole, so an unanchored pattern
   * accepts anything containing a match. The field would look validated and
   * would not be.
   */
  it('refuses a value that merely contains a match', () => {
    const { result } = normalizeWith(
      [field('F', 'TEXT', 1, { maxLength: 20, pattern: '\\d{6}', patternMessage: 'Six digits.' })],
      { F: 'abc799001xyz' },
    )
    expect(codesOf(result)).toContain('PATTERN_MISMATCH')
  })

  it("shows the cycle's own wording rather than the expression", () => {
    const { result } = normalizeWith(patterned, { F: 'abcdef' })
    const failure = result.issues.find((i) => i.code === 'PATTERN_MISMATCH')
    expect(failure?.message).toBe('Enter six digits.')
    // The expression is authoring detail and means nothing to an applicant.
    expect(failure?.message).not.toContain('\\d')
  })
})

describe('the replacement contract', () => {
  it('refuses a key the template does not declare', () => {
    const template = templateOf()
    const result = normalizeAnswers(
      template,
      { ...answersFor(template), FAVOURITE_COLOUR: 'blue' },
      NOW,
    )
    expect(codesOf(result)).toContain('UNKNOWN_FIELD')
    // Refused, never quietly dropped: a client holding an older form would
    // otherwise be told it saved and watch the answer disappear.
    expect(result.value).toBeNull()
  })

  it('refuses an answer set that leaves a declared question out', () => {
    const template = templateOf([field('F', 'TEXT', 1, { maxLength: 20 })])
    const { F, ...missing } = answersFor(template, { F: 'x' })
    expect(codesOf(normalizeAnswers(template, missing, NOW))).toContain('MISSING_SNAPSHOT_FIELD')
  })

  it('accepts an explicit null as a cleared answer', () => {
    const { result } = normalizeWith([field('F', 'TEXT', 1, { maxLength: 20 })], { F: null })
    expect(result.issues).toEqual([])
    expect(result.value?.F).toBeNull()
  })

  it('refuses answers that are not an object at all', () => {
    const template = templateOf()
    expect(codesOf(normalizeAnswers(template, [], NOW))).toContain('MALFORMED_ANSWERS')
    expect(codesOf(normalizeAnswers(template, 'nope', NOW))).toContain('MALFORMED_ANSWERS')
    expect(codesOf(normalizeAnswers(template, null, NOW))).toContain('MALFORMED_ANSWERS')
  })

  /*
   * A prototype-polluting key would otherwise be spread into objects
   * downstream. It is refused as an unknown field, which is what it is.
   */
  it('refuses __proto__ as an answer key', () => {
    const template = templateOf()
    const answers = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    const result = normalizeAnswers(template, { ...answersFor(template), ...answers }, NOW)
    expect(result.value).toBeNull()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('answers to questions nobody was asked', () => {
  const conditional = () =>
    templateOf(
      [field('FLAG', 'BOOLEAN', 1), field('DETAIL', 'TEXT', 2, { maxLength: 50 })],
      [
        {
          fieldKey: 'DETAIL', effect: 'VISIBLE_WHEN', groupNumber: 1, sequenceNumber: 1,
          sourceFieldKey: 'FLAG', operator: 'EQUALS', comparisonValue: 'true',
        },
      ],
    )

  it('refuses submission while a hidden question still carries an answer', () => {
    const template = conditional()
    const answers = answersFor(template, { FLAG: false, DETAIL: 'left behind' })
    const report = validateAnswersForSubmission(
      template, answers as never, NO_DOCUMENTS, NOW, permissivePolicy,
    )
    expect(report.valid).toBe(false)
    const stray = report.issues.find((i) => i.code === 'CONDITIONAL_FIELDS')
    // Reported against the question that put it away, which is the control the
    // applicant can actually see and act on.
    expect(stray?.field).toBe('FLAG')
  })

  it('clears the stray answer when pruned', () => {
    const template = conditional()
    const pruned = pruneHidden(template, answersFor(template, { FLAG: false, DETAIL: 'left behind' }) as never)
    expect(pruned.DETAIL).toBeNull()
  })

  it('leaves a visible answer alone', () => {
    const template = conditional()
    const pruned = pruneHidden(template, answersFor(template, { FLAG: true, DETAIL: 'kept' }) as never)
    expect(pruned.DETAIL).toBe('kept')
  })

  /*
   * Clearing A hides B, and B was hiding C. A single-pass prune leaves C's
   * answer behind: the form looks right and the draft is wrong, and nothing
   * downstream notices.
   */
  it('reaches the third answer in a chain', () => {
    const template = templateOf(
      [
        field('A_FLAG', 'BOOLEAN', 1),
        field('B_TEXT', 'TEXT', 2, { maxLength: 50 }),
        field('C_TEXT', 'TEXT', 3, { maxLength: 50 }),
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
      ],
    )
    const pruned = pruneHidden(
      template,
      answersFor(template, { A_FLAG: false, B_TEXT: 'stale', C_TEXT: 'also stale' }) as never,
    )
    expect(pruned.B_TEXT).toBeNull()
    expect(pruned.C_TEXT).toBeNull()
  })

  it('is idempotent: pruning twice changes nothing more', () => {
    const template = conditional()
    const answers = answersFor(template, { FLAG: false, DETAIL: 'left behind' }) as never
    const once = pruneHidden(template, answers)
    const twice = pruneHidden(template, once)
    expect(answersEqual(template, once, twice)).toBe(true)
  })
})

describe('completeness at submission', () => {
  it('refuses when a required question is unanswered', () => {
    const template = templateOf([field('F', 'TEXT', 1, { maxLength: 20, requirement: 'REQUIRED' })])
    const report = validateAnswersForSubmission(
      template, answersFor(template, { F: null }) as never, NO_DOCUMENTS, NOW, permissivePolicy,
    )
    expect(codesOf(report)).toContain('REQUIRED')
  })

  /*
   * The money rule. The committee's decision is bounded by this amount, read
   * straight off the submission. If a template could leave it optional, an
   * approval could be compared against nothing at all — so the requirement
   * follows the role, not the flag.
   */
  it('requires a role-bound amount even when the template marks it optional', () => {
    const template = templateOf()
    expect(template.byKey.get('SEED_FUND_REQUESTED_PAISE')?.requirement).toBe('OPTIONAL')
    const report = validateAnswersForSubmission(
      template,
      answersFor(template, { SEED_FUND_REQUESTED_PAISE: null }) as never,
      NO_DOCUMENTS, NOW, permissivePolicy,
    )
    expect(codesOf(report)).toContain('REQUIRED')
  })

  it('refuses a role-bound amount of zero', () => {
    const template = templateOf()
    const report = validateAnswersForSubmission(
      template,
      answersFor(template, { SEED_FUND_REQUESTED_PAISE: 0 }) as never,
      NO_DOCUMENTS, NOW, permissivePolicy,
    )
    expect(codesOf(report)).toContain('TOO_SMALL')
  })

  it('names a required document that has not been uploaded', () => {
    const template = templateOf([
      field('PROOF', 'FILE', 1, { maxFileBytes: 1024, requirement: 'REQUIRED' }),
    ])
    const report = validateAnswersForSubmission(
      template, answersFor(template) as never, NO_DOCUMENTS, NOW, permissivePolicy,
    )
    const missing = report.issues.find((i) => i.code === 'DOCUMENT_REQUIRED')
    expect(missing?.field).toBe('PROOF')
  })

  it('accepts once the document is there', () => {
    const template = templateOf([
      field('PROOF', 'FILE', 1, { maxFileBytes: 1024, requirement: 'REQUIRED' }),
    ])
    const report = validateAnswersForSubmission(
      template, answersFor(template) as never, new Set(['PROOF']), NOW, permissivePolicy,
    )
    expect(report.valid).toBe(true)
  })
})

describe('programme policy, which is the cycle’s and not the template’s', () => {
  it('refuses an applicant outside the age band', () => {
    const template = templateOf()
    const report = validateAnswersForSubmission(
      template, answersFor(template) as never, NO_DOCUMENTS, NOW,
      { ...permissivePolicy, minimumApplicantAge: 18, maximumApplicantAge: 30 },
    )
    // Born 1990-06-15, so 35 at the fixture's instant.
    expect(codesOf(report)).toContain('AGE_INELIGIBLE')
  })

  it('refuses a request above the ceiling for one application', () => {
    const template = templateOf()
    const report = validateAnswersForSubmission(
      template, answersFor(template) as never, NO_DOCUMENTS, NOW,
      {
        ...permissivePolicy,
        fundingCeilingState: 'RESOLVED',
        fundingCeilingScope: 'APPLICATION',
        fundingCeilingAmountPaise: 10_000_00,
      },
    )
    expect(codesOf(report)).toContain('FUNDING_CEILING_EXCEEDED')
  })
})

describe('the change summary', () => {
  it('names only the stage whose answer moved', () => {
    const template = templateOf(
      [field('OTHER', 'TEXT', 1, { maxLength: 20, stageKey: 'SECOND' })],
      [],
      [],
      [
        { stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 },
        { stageKey: 'SECOND', title: 'Second', description: null, sortOrder: 2 },
      ],
    )
    const before = answersFor(template, { OTHER: 'a' }) as never
    const after = answersFor(template, { OTHER: 'b' }) as never
    expect(changedStageKeys(template, before, after)).toEqual(['SECOND'])
  })

  it('reports nothing when the answers are the same', () => {
    const template = templateOf([field('OTHER', 'TEXT', 1, { maxLength: 20 })])
    const answers = answersFor(template, { OTHER: 'same' }) as never
    expect(changedStageKeys(template, answers, answers)).toEqual([])
    expect(answersEqual(template, answers, answers)).toBe(true)
  })

  it('agrees with the equality check by construction', () => {
    const template = templateOf([field('OTHER', 'TEXT', 1, { maxLength: 20 })])
    const before = answersFor(template, { OTHER: 'a' }) as never
    const after = answersFor(template, { OTHER: 'b' }) as never
    expect(answersEqual(template, before, after)).toBe(
      changedStageKeys(template, before, after).length === 0,
    )
  })
})

describe('how much answer one application may carry', () => {
  /*
   * The budget is a byte budget, and that is not the same as a character
   * budget. `String.length` counts UTF-16 code units, so a form answered in
   * Bengali or Kokborok — which this programme's applicants write in — would be
   * counted at roughly a third of what it actually costs. An applicant writing
   * in their own script would get three times the allowance of one writing in
   * English, and the request would then be refused further up by a limit that
   * does count bytes.
   */
  const answerOf = (character: string, count: number) => {
    const template = templateOf([field('LONG', 'LONG_TEXT', 1, { maxLength: 100_000 })])
    return normalizeAnswers(
      template,
      answersFor(template, { LONG: character.repeat(count) }),
      NOW,
    )
  }

  it('refuses an oversized answer written in Latin script', () => {
    // 40,000 characters is 40,000 bytes: over by either reckoning.
    expect(codesOf(answerOf('a', 40_000))).toContain('ANSWERS_TOO_LARGE')
  })

  /*
   * The discriminating case, and the reason the fix mattered.
   *
   * 20,000 Bengali characters are 20,000 UTF-16 code units — comfortably under
   * a character-counted budget — and 60,000 bytes, nearly twice a byte-counted
   * one. Counting characters would have let this through.
   */
  it('refuses an answer that is oversized in bytes but not in characters', () => {
    expect(codesOf(answerOf('অ', 20_000))).toContain('ANSWERS_TOO_LARGE')
  })

  it('accepts an answer comfortably inside the budget', () => {
    const template = templateOf([field('LONG', 'LONG_TEXT', 1, { maxLength: 100_000 })])
    const result = normalizeAnswers(
      template,
      answersFor(template, { LONG: 'অ'.repeat(1_000) }),
      NOW,
    )
    expect(result.issues).toEqual([])
  })
})

/**
 * A typed field constrains its type.
 *
 * `EMAIL` and `PHONE` exist as types rather than as patterns a cycle authors,
 * so that the server owns what they mean — and `INVALID_EMAIL` and
 * `INVALID_PHONE` were in the closed code set from the start. Nothing emitted
 * them: both types normalised their input and accepted whatever was left, so a
 * question labelled "Contact email" took `not-an-email` and stored it, and the
 * applicant found out when nobody could reach them.
 */
describe('a typed field constrains its type', () => {
  const of = (type: 'EMAIL' | 'PHONE', value: unknown) => {
    const template = templateOf([field('F', type, 1, { maxLength: 254 })])
    return normalizeAnswers(template, answersFor(template, { F: value }), new Date('2026-06-01'))
  }

  it.each([
    ['plain text', 'not-an-email'],
    ['no domain', 'rina@'],
    ['no local part', '@example.test'],
    ['a bare domain', 'example.test'],
    ['two at signs', 'rina@@example.test'],
    ['an inner space', 'rina debbarma@example.test'],
    ['a domain with no dot', 'rina@example'],
  ])('refuses an email that is %s', (_label, value) => {
    expect(of('EMAIL', value).issues.map((issue) => issue.code)).toEqual(['INVALID_EMAIL'])
  })

  it.each([
    ['an ordinary address', 'rina@example.test'],
    ['a subdomain', 'rina@mail.example.test'],
    ['a plus tag', 'rina+sep@example.test'],
    // Normalised, not refused — the same address in two spellings must compare
    // equal, which is the reason this is a type rather than a pattern.
    ['mixed case', 'Rina@Example.Test'],
  ])('accepts %s', (_label, value) => {
    expect(of('EMAIL', value).issues).toEqual([])
  })

  it.each([
    ['letters', 'ring-me'],
    ['too few digits', '+9112'],
    ['too many digits', '+9198765432101234'],
  ])('refuses a phone number that is %s', (_label, value) => {
    const issues = of('PHONE', value).issues.map((issue) => issue.code)
    expect(issues.length === 0 ? ['ACCEPTED'] : issues).toEqual(['INVALID_PHONE'])
  })

  /*
   * Separators and nothing else is *unanswered*, not invalid. Stripping them
   * leaves an empty string, and an empty string is how this form says a
   * question was left blank — refusing it would tell an applicant their empty
   * field is wrong rather than incomplete, which is a different sentence.
   */
  it('reads a string of separators as no answer at all', () => {
    const result = of('PHONE', '- - -')
    expect(result.issues).toEqual([])
    expect(result.value?.F).toBeNull()
  })

  it.each([
    ['an Indian mobile', '+919876543210'],
    ['spaced and bracketed', '+91 (987) 654-3210'],
    ['a local number', '03812345678'],
  ])('accepts %s', (_label, value) => {
    expect(of('PHONE', value).issues).toEqual([])
  })
})
