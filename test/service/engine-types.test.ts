/**
 * Layer 1: every declared type against every wrong value, and every bound at
 * its edge.
 *
 * Two things this exists to catch that ordinary tests do not.
 *
 * **The boundary trio.** A rule written with `>` where it means `>=` accepts
 * exactly one value it should refuse, and passes every test built from a
 * clearly-valid and a clearly-invalid example. So each bound is asserted three
 * times — one below, exactly at, and one above — and the *exact* case is the
 * one that matters.
 *
 * **The absent / null / empty trio.** A question left blank arrives three ways:
 * the key missing, the key present with `null`, and the key present with `""`.
 * They must reach one verdict, not three. A form that treats `""` as an answer
 * lets an applicant submit a blank required field, and one that treats `null`
 * as absent refuses a draft the applicant deliberately cleared.
 *
 * Generated from a table rather than written out, so adding a field type adds
 * its cases. `it.each` rather than a loop inside one `it`, because at this
 * count the first failure must not hide the rest — the repository had one
 * hand-rolled table loop and that is exactly what it did.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import { coerceAnswer } from '../../src/services/application/form/coerce'
import { formFieldTypes } from '../../src/db/schema/seb/form-template'
import type { ValidationIssueCode } from '../../src/services/application/form/codes'
import {
  answersFor,
  field,
  permissivePolicy,
  templateOf,
  type FieldRow,
} from './support/template'

const NOW = new Date('2026-06-01T00:00:00Z')

/** Runs one answer against a one-field template and returns its issue codes. */
const check = (
  fieldType: FieldRow['fieldType'],
  value: unknown,
  extra: Partial<FieldRow> = {},
  options: { optionValue: string; optionLabel: string; sortOrder: number }[] = [],
): ValidationIssueCode[] => {
  const template = templateOf(
    [field('F', fieldType, 1, extra)],
    [],
    options.map((option) => ({ fieldKey: 'F', ...option })),
  )
  const answers = answersFor(template, { F: value })
  return normalizeAnswers(template, answers, NOW).issues
    .filter((issue) => issue.field === 'F')
    .map((issue) => issue.code)
}

/** The same, returning what was *stored* rather than what was refused. */
const stored = (
  fieldType: FieldRow['fieldType'],
  value: unknown,
  extra: Partial<FieldRow> = {},
): unknown => {
  const template = templateOf([field('F', fieldType, 1, extra)], [], [])
  const report = normalizeAnswers(template, answersFor(template, { F: value }), NOW)
  expect(report.issues, JSON.stringify(report.issues)).toEqual([])
  return report.value!.F
}

const CHOICES = [
  { optionValue: 'ONE', optionLabel: 'One', sortOrder: 1 },
  { optionValue: 'TWO', optionLabel: 'Two', sortOrder: 2 },
  { optionValue: 'THREE', optionLabel: 'Three', sortOrder: 3 },
]

/* ------------------------------------------------------------------ types */

/**
 * One acceptable value per type, and the extras that make it acceptable.
 *
 * `REPEAT_GROUP` and `FILE` are absent deliberately and asserted separately: a
 * group holds entries rather than a value, and a `FILE` question carries
 * evidence rather than an answer.
 */
const TYPES: Array<{
  type: FieldRow['fieldType']
  good: unknown
  extra?: Partial<FieldRow>
  options?: typeof CHOICES
}> = [
  { type: 'TEXT', good: 'Example', extra: { maxLength: 50 } },
  { type: 'LONG_TEXT', good: 'A longer answer.', extra: { maxLength: 500 } },
  { type: 'EMAIL', good: 'rina@example.test', extra: { maxLength: 254 } },
  { type: 'PHONE', good: '+919876543210', extra: { maxLength: 20 } },
  { type: 'DATE', good: '2015-04-01' },
  { type: 'INTEGER', good: 42 },
  { type: 'MONEY_PAISE', good: 500_000, extra: { minValue: 0 } },
  { type: 'BOOLEAN', good: true },
  { type: 'ATTESTATION', good: true },
  { type: 'SINGLE_CHOICE', good: 'TWO', options: CHOICES },
  { type: 'MULTI_CHOICE', good: ['ONE', 'TWO'], options: CHOICES },
]

describe('every declared type', () => {
  /*
   * The table covers every type the schema declares, or a type added later
   * would be exempt from all of this without anybody noticing.
   */
  it('is covered by this file', () => {
    const covered = new Set<string>([
      ...TYPES.map((each) => each.type), 'FILE', 'STATEMENT', 'REPEAT_GROUP',
    ])
    expect([...formFieldTypes].filter((type) => !covered.has(type))).toEqual([])
  })

  it.each(TYPES.map((each) => [each.type, each] as const))(
    '%s accepts a value of its own type',
    (_type, entry) => {
      expect(check(entry.type, entry.good, entry.extra, entry.options)).toEqual([])
    },
  )

  /**
   * Every type against every *other* type's value.
   *
   * Cross-producted rather than hand-listed, so a coercer that quietly accepts
   * something it should not — a number for a date, a string for a boolean —
   * is caught wherever it is, not only where somebody thought to look.
   */
  const crossed = TYPES.flatMap((subject) =>
    TYPES.filter((other) => other.type !== subject.type)
      .map((other) => [subject.type, other.type, subject, other.good] as const),
  )

  it.each(crossed)('%s refuses a %s value', (_type, _otherType, subject, wrong) => {
    const issues = check(subject.type, wrong, subject.extra, subject.options)
    /*
     * Some pairs genuinely overlap and must be allowed to: every text-shaped
     * type accepts a string, and a date *is* a string. What is asserted is
     * that nothing is accepted which the type could not represent — so the
     * check is "either refused, or the value really is of this type".
     */
    const representable = ((): boolean => {
      switch (subject.type) {
        case 'TEXT':
        case 'LONG_TEXT':
          return typeof wrong === 'string'
        case 'EMAIL':
          return typeof wrong === 'string' && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(wrong)
        case 'PHONE':
          return typeof wrong === 'string' && /^\+?\d{8,15}$/u.test(wrong.replace(/[\s()-]/gu, ''))
        case 'DATE':
          return typeof wrong === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(wrong)
        case 'INTEGER':
        case 'MONEY_PAISE':
          return typeof wrong === 'number'
        case 'BOOLEAN':
        case 'ATTESTATION':
          return typeof wrong === 'boolean'
        case 'SINGLE_CHOICE':
          return typeof wrong === 'string' && CHOICES.some((c) => c.optionValue === wrong)
        case 'MULTI_CHOICE':
          return Array.isArray(wrong)
        default:
          return false
      }
    })()
    if (representable) expect(issues).toEqual([])
    else expect(issues.length, `${subject.type} accepted ${JSON.stringify(wrong)}`)
      .toBeGreaterThan(0)
  })
})

/* ----------------------------------------------------------------- blanks */

describe('a question left blank', () => {
  /*
   * Three spellings of the same thing. `undefined` here means the key is
   * present and undefined; a *missing* key is a different case entirely —
   * `MISSING_SNAPSHOT_FIELD` — and is covered where total replacement is.
   */
  const BLANKS: Array<[string, unknown]> = [
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
  ]

  it.each(TYPES.flatMap((entry) => BLANKS.map(
    ([label, blank]) => [entry.type, label, entry, blank] as const,
  )))('%s reads %s as unanswered rather than as a value', (_type, _label, entry, blank) => {
    /*
     * Numbers and booleans have no empty spelling, so `''` is simply the wrong
     * type for them and refusing it is right. What must never happen is the
     * reverse: a blank accepted *as an answer*, which would let a required
     * question pass while holding nothing.
     */
    const result = normalizeAnswers(
      templateOf(
        [field('F', entry.type, 1, entry.extra)],
        [],
        (entry.options ?? []).map((option) => ({ fieldKey: 'F', ...option })),
      ),
      answersFor(templateOf([field('F', entry.type, 1, entry.extra)]), { F: blank }),
      NOW,
    )
    if (result.issues.some((issue) => issue.field === 'F')) return
    /*
     * A multiple choice's empty is the empty list rather than null — nothing
     * selected is still a list of selections. What matters is that it is
     * *empty*, because that is what makes a required one refuse.
     */
    const empty = entry.type === 'MULTI_CHOICE' ? [] : null
    expect(result.value?.F, `${entry.type} kept ${JSON.stringify(blank)} as an answer`)
      .toEqual(empty)
  })

  it('refuses a required multiple choice with nothing selected', () => {
    const template = templateOf(
      [field('F', 'MULTI_CHOICE', 1, { requirement: 'REQUIRED' })],
      [],
      CHOICES.map((option) => ({ fieldKey: 'F', ...option })),
    )
    for (const blank of [null, []]) {
      const answers = answersFor(template, { F: blank })
      const normalized = normalizeAnswers(template, answers, NOW)
      expect(
        validateAnswersForSubmission(
          template, normalized.value!, new Set(), NOW, permissivePolicy,
        ).issues.map((issue) => issue.code),
        JSON.stringify(blank),
      ).toEqual(['REQUIRED'])
    }
  })

  it('reads null and an empty string identically for every text type', () => {
    for (const type of ['TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE'] as const) {
      expect(check(type, null, { maxLength: 254 })).toEqual(check(type, '', { maxLength: 254 }))
    }
  })

  /**
   * What a long answer keeps, and what it is allowed to lose.
   *
   * `LONG_TEXT` shared `TEXT`'s coercer, which collapses every run of
   * whitespace to a single space — so an applicant's business plan came back
   * as one paragraph and nothing anywhere said so. A long answer is the one
   * place in the form where the shape of the text is part of the answer.
   */
  it('keeps the paragraphs of a long answer', () => {
    const written = 'We make bamboo furniture.\n\nThe unit employs six people.'
    expect(stored('LONG_TEXT', written, { maxLength: 500 })).toBe(written)
  })

  it('still tidies a long answer where the whitespace carries nothing', () => {
    // Trailing space goes and four newlines become one blank line. The space
    // that opens the second line stays: an indent is something somebody meant.
    expect(stored('LONG_TEXT', '  We  make\r\n\n\n\n bamboo.  \n ', { maxLength: 500 }))
      .toBe('We make\n\n bamboo.')
  })

  // The short type is unchanged, which is the other half of splitting them.
  it('still collapses the whitespace of a short answer', () => {
    expect(stored('TEXT', 'Sri   Devi\nHandlooms', { maxLength: 100 }))
      .toBe('Sri Devi Handlooms')
  })
})

/* ----------------------------------------------------------------- bounds */

/**
 * Every bound at one below, exactly at, and one above.
 *
 * `atBound` is the case that separates a correct rule from one written with
 * the wrong comparison: a length rule using `>` instead of `>=` accepts a
 * string exactly one character too long, and nothing else in a test suite
 * would ever notice.
 */
const BOUNDS: Array<{
  label: string
  type: FieldRow['fieldType']
  extra: Partial<FieldRow>
  inside: unknown
  atBound: unknown
  outside: unknown
  code: ValidationIssueCode
}> = [
  {
    label: 'a minimum length',
    type: 'TEXT', extra: { minLength: 5, maxLength: 50 },
    inside: 'abcdef', atBound: 'abcde', outside: 'abcd', code: 'TOO_SHORT',
  },
  {
    label: 'a maximum length',
    type: 'TEXT', extra: { maxLength: 5 },
    inside: 'abcd', atBound: 'abcde', outside: 'abcdef', code: 'TOO_LONG',
  },
  {
    label: 'a smallest amount',
    type: 'MONEY_PAISE', extra: { minValue: 1000 },
    inside: 1001, atBound: 1000, outside: 999, code: 'TOO_SMALL',
  },
  {
    label: 'a largest amount',
    type: 'MONEY_PAISE', extra: { minValue: 0, maxValue: 1000 },
    inside: 999, atBound: 1000, outside: 1001, code: 'TOO_LARGE',
  },
  {
    label: 'a smallest whole number',
    type: 'INTEGER', extra: { minValue: 18 },
    inside: 19, atBound: 18, outside: 17, code: 'TOO_SMALL',
  },
  {
    label: 'a largest whole number',
    type: 'INTEGER', extra: { maxValue: 60 },
    inside: 59, atBound: 60, outside: 61, code: 'TOO_LARGE',
  },
  {
    label: 'an earliest date',
    type: 'DATE', extra: { minDate: '2015-04-01' },
    inside: '2015-04-02', atBound: '2015-04-01', outside: '2015-03-31',
    code: 'DATE_TOO_EARLY',
  },
  {
    label: 'a latest date',
    type: 'DATE', extra: { maxDate: '2015-04-01' },
    inside: '2015-03-31', atBound: '2015-04-01', outside: '2015-04-02',
    code: 'DATE_TOO_LATE',
  },
]

describe('a bound the template declares', () => {
  it.each(BOUNDS.map((bound) => [bound.label, bound] as const))(
    '%s accepts a value inside it',
    (_label, bound) => {
      expect(check(bound.type, bound.inside, bound.extra)).toEqual([])
    },
  )

  it.each(BOUNDS.map((bound) => [bound.label, bound] as const))(
    '%s accepts the value exactly at it',
    (_label, bound) => {
      expect(check(bound.type, bound.atBound, bound.extra)).toEqual([])
    },
  )

  it.each(BOUNDS.map((bound) => [bound.label, bound] as const))(
    '%s refuses the value just past it, and says which bound',
    (_label, bound) => {
      expect(check(bound.type, bound.outside, bound.extra)).toEqual([bound.code])
    },
  )
})

/* ---------------------------------------------------------------- choices */

describe('a choice question', () => {
  it('refuses a value the cycle does not offer', () => {
    expect(check('SINGLE_CHOICE', 'FOUR', {}, CHOICES)).toEqual(['INVALID_ENUM'])
  })

  it('refuses a selection the cycle does not offer', () => {
    expect(check('MULTI_CHOICE', ['ONE', 'FOUR'], {}, CHOICES)).toEqual(['INVALID_ENUM'])
  })

  it('refuses the same selection twice', () => {
    expect(check('MULTI_CHOICE', ['ONE', 'ONE'], {}, CHOICES)).toEqual(['DUPLICATE_SELECTION'])
  })

  /*
   * Selection counts, at their edges. The empty list is the case an engine
   * gets wrong by treating "no selections" as "not answered": with a minimum
   * of one they are the same refusal, but with a minimum of zero they are
   * not, and only one of them is an answer.
   */
  /*
   * A selection bound is the length pair read against a list — the same two
   * columns that count characters on a text question. The repeat bounds are a
   * different thing entirely and the schema forbids them here.
   */
  /*
   * The two bounds are enforced in different tiers, and each row says which.
   * Too many is a mistake the applicant made and can undo, so it is refused on
   * the way in; too few is incompleteness, so it waits for submission — a
   * draft has to be savable part-way through choosing.
   */
  it.each([
    ['one below the minimum', ['ONE'], 2, 3, [], ['TOO_FEW_SELECTED']],
    ['exactly the minimum', ['ONE', 'TWO'], 2, 3, [], []],
    ['exactly the maximum', ['ONE', 'TWO', 'THREE'], 1, 3, [], []],
    ['one above the maximum', ['ONE', 'TWO', 'THREE'], 1, 2, ['TOO_MANY_SELECTED'], []],
  ] as const)('counts %s', (_label, value, min, max, onSave, onSubmit) => {
    const extra = { minLength: min, maxLength: max }
    expect(check('MULTI_CHOICE', value, extra, CHOICES), 'on save').toEqual(onSave)

    const template = templateOf(
      [field('F', 'MULTI_CHOICE', 1, extra)],
      [],
      CHOICES.map((option) => ({ fieldKey: 'F', ...option })),
    )
    const normalized = normalizeAnswers(template, answersFor(template, { F: value }), NOW)
    if (normalized.value === null) return
    expect(
      validateAnswersForSubmission(template, normalized.value, new Set(), NOW, permissivePolicy)
        .issues.filter((issue) => issue.field === 'F').map((issue) => issue.code),
      'on submit',
    ).toEqual(onSubmit)
  })
})

/* -------------------------------------------------------------- evidence */

describe('a FILE question', () => {
  /*
   * A `FILE` question carries evidence, which has its own versioned row, its
   * own soft delete and its own scan result. An answer against one would be a
   * second place the same fact lives — so it is refused rather than ignored,
   * because ignoring it would lose whatever the client thought it was saving.
   */
  it('refuses an answer, rather than dropping it', () => {
    expect(check('FILE', 'something.pdf')).toEqual(['FILE_ANSWER_NOT_ALLOWED'])
  })

  it('is not required to be present in the answer set', () => {
    const template = templateOf([field('F', 'FILE', 1, { requirement: 'REQUIRED' })])
    const answers = answersFor(template)
    expect('F' in answers).toBe(false)
    expect(normalizeAnswers(template, answers, NOW).issues).toEqual([])
  })
})

describe('a STATEMENT', () => {
  it('is refused by the coercer directly, not merely skipped', () => {
    // The engine's walk skips statements, so the coercer's own refusal is the
    // backstop for any future caller that reaches it directly.
    const template = templateOf([field('F', 'STATEMENT', 1, { requirement: 'OPTIONAL' })])
    const statement = template.byKey.get('F')!
    expect(coerceAnswer(statement, 'anything')).toMatchObject({
      ok: false,
      code: 'STATEMENT_ANSWER_NOT_ALLOWED',
    })
  })


  /*
   * A statement is read, never answered — the display-only sibling of FILE's
   * rule. Refused rather than dropped for the same reason: silently discarding
   * a value would lose whatever the client thought it was saving.
   */
  it('refuses an answer, rather than dropping it', () => {
    expect(check('STATEMENT', 'I have read this', { requirement: 'OPTIONAL' }))
      .toEqual(['STATEMENT_ANSWER_NOT_ALLOWED'])
  })

  it('asks for nothing at submission', () => {
    const template = templateOf([
      field('F', 'STATEMENT', 1, { requirement: 'OPTIONAL' }),
      field('NAME', 'TEXT', 2, { requirement: 'REQUIRED', maxLength: 50 }),
    ])
    const answers = normalizeAnswers(
      template, answersFor(template, { NAME: 'Rina' }), NOW).value!
    const report = validateAnswersForSubmission(template, answers, new Set(), NOW, permissivePolicy)
    expect(report.issues).toEqual([])
    expect(report.valid).toBe(true)
  })
})

/**
 * A draft saves before it is complete. That is the whole point of a draft.
 *
 * The engine runs in two tiers: a save checks shape and format, and submission
 * adds completeness. A bound on how *many* things must be chosen is a
 * completeness rule — so it belongs to the second tier, and firing it on a
 * save stops the applicant keeping what they have typed so far.
 *
 * This was reachable only after the schema was widened to let a cycle declare
 * a selection bound at all: an unanswered multiple choice normalises to the
 * empty list, and an empty list is a list, so the minimum fired against a
 * question nobody had reached yet.
 */
describe('a selection bound and the two tiers', () => {
  const template = () => templateOf(
    [field('SECTORS', 'MULTI_CHOICE', 1, { minLength: 2, maxLength: 3 })],
    [],
    CHOICES.map((option) => ({ fieldKey: 'SECTORS', ...option })),
  )

  it('lets a draft be saved with the question not yet answered', () => {
    const resolved = template()
    const normalized = normalizeAnswers(resolved, answersFor(resolved, { SECTORS: [] }), NOW)
    expect(normalized.issues).toEqual([])
    expect(normalized.value?.SECTORS).toEqual([])
  })

  it('lets a draft be saved part-way through answering it', () => {
    const resolved = template()
    expect(normalizeAnswers(resolved, answersFor(resolved, { SECTORS: ['ONE'] }), NOW).issues)
      .toEqual([])
  })

  /*
   * And submission is where it is enforced — otherwise moving the check off
   * the save would simply have removed it.
   */
  it('refuses to submit with too few chosen', () => {
    const resolved = template()
    const answers = normalizeAnswers(
      resolved, answersFor(resolved, { SECTORS: ['ONE'] }), NOW,
    ).value!
    expect(
      validateAnswersForSubmission(resolved, answers, new Set(), NOW, permissivePolicy)
        .issues.filter((issue) => issue.field === 'SECTORS').map((issue) => issue.code),
    ).toEqual(['TOO_FEW_SELECTED'])
  })

  /*
   * Too *many* is not a completeness problem — the applicant has chosen
   * something they cannot choose — so it is refused on the way in, where the
   * client can show it against the control they just clicked.
   */
  it('refuses too many on the way in, because that is not incompleteness', () => {
    const resolved = template()
    expect(
      normalizeAnswers(
        resolved, answersFor(resolved, { SECTORS: ['ONE', 'TWO', 'THREE'] }), NOW,
      ).issues.map((issue) => issue.code),
    ).toEqual([])
    expect(
      normalizeAnswers(
        resolved,
        answersFor(resolved, { SECTORS: ['ONE', 'TWO', 'THREE', 'ONE'] }),
        NOW,
      ).issues.length,
    ).toBeGreaterThan(0)
  })
})
