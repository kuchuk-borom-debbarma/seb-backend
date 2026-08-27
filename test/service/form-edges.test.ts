/**
 * The branches of the engine that nothing else reaches.
 *
 * Each one is a rule that only fires under a template or an answer no other
 * suite happens to build — which is exactly the shape of rule that stops being
 * true without anything going red.
 */
import { describe, expect, it } from 'vitest'
import { pruneHidden } from '../../src/services/application/form/answers'
import { coerceAnswer } from '../../src/services/application/form/coerce'
import { visibleFields } from '../../src/services/application/form/conditions'
import { normalizeAnswers } from '../../src/services/application/form/engine'
import { issuePath } from '../../src/services/application/form/codes'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import {
  answersFor, field, roleFields, roleOptions, templateOf, type FieldRow,
} from './support/template'

const NOW = new Date('2026-06-15T12:00:00Z')

const dated = (bound: 'NOT_FUTURE' | 'NOT_PAST') => templateOf([
  field('WHEN', 'DATE', 1, { relativeDateBound: bound }),
])

const dateIssue = (bound: 'NOT_FUTURE' | 'NOT_PAST', when: string) => {
  const template = dated(bound)
  return normalizeAnswers(template, answersFor(template, { WHEN: when }), NOW).issues
    .map((each) => each.code)
}

describe('a date bounded against today rather than a fixed day', () => {
  /*
   * Resolved against the write's own instant, never a `new Date()` read inside
   * the rule. The validator and the write that follows it must agree about
   * what "today" is, or a request straddling midnight validates against one
   * day and stores against another.
   */
  it('accepts today itself under either bound', () => {
    expect(dateIssue('NOT_FUTURE', '2026-06-15')).toEqual([])
    expect(dateIssue('NOT_PAST', '2026-06-15')).toEqual([])
  })

  it('refuses tomorrow where the answer may not be in the future', () => {
    expect(dateIssue('NOT_FUTURE', '2026-06-16')).toEqual(['DATE_TOO_LATE'])
  })

  it('accepts yesterday where the answer may not be in the future', () => {
    expect(dateIssue('NOT_FUTURE', '2026-06-14')).toEqual([])
  })

  it('refuses yesterday where the answer may not be in the past', () => {
    expect(dateIssue('NOT_PAST', '2026-06-14')).toEqual(['DATE_TOO_EARLY'])
  })

  it('accepts tomorrow where the answer may not be in the past', () => {
    expect(dateIssue('NOT_PAST', '2026-06-16')).toEqual([])
  })

  /*
   * "Not in the past" means "not before today", not "not before this instant".
   * A date carries no time, so comparing it against midday would refuse this
   * morning's date for the whole afternoon.
   */
  it('compares against the whole of today, not the moment within it', () => {
    const template = dated('NOT_PAST')
    const lateInTheDay = new Date('2026-06-15T23:59:59Z')
    expect(normalizeAnswers(
      template, answersFor(template, { WHEN: '2026-06-15' }), lateInTheDay,
    ).issues).toEqual([])
  })
})

describe('the coercers that refuse rather than convert', () => {
  const only = (fieldKey: string, fieldType: Parameters<typeof field>[1], extra = {}) =>
    templateOf([field(fieldKey, fieldType, 1, extra)]).byKey.get(fieldKey)!

  it('refuses a choice list containing something that is not a choice', () => {
    const multi = templateOf(
      [field('PICK', 'MULTI_CHOICE', 1)],
      [],
      [{ fieldKey: 'PICK', optionValue: 'A', optionLabel: 'A', sortOrder: 1 }],
    ).byKey.get('PICK')!
    expect(coerceAnswer(multi, [7])).toMatchObject({ ok: false, code: 'INVALID_TYPE' })
    expect(coerceAnswer(multi, ['B'])).toMatchObject({ ok: false, code: 'INVALID_ENUM' })
    expect(coerceAnswer(multi, ['A', 'A']))
      .toMatchObject({ ok: false, code: 'DUPLICATE_SELECTION' })
  })

  /*
   * Both are refusals of last resort — the engine's own loops exclude these
   * types before they reach a coercer. Kept because the coercer is exported
   * and total, and a total function with a hole is worse than one without.
   */
  it('refuses a document answered as though it were a question', () => {
    expect(coerceAnswer(only('DPR', 'FILE', { maxFileBytes: 1024 }), 'bytes'))
      .toMatchObject({ ok: false, code: 'FILE_ANSWER_NOT_ALLOWED' })
  })

  it('refuses a repeated group handed to the single-answer coercer', () => {
    const group = only('PARTNERS', 'REPEAT_GROUP', { repeatMin: 0, repeatMax: 3 })
    expect(coerceAnswer(group, [])).toMatchObject({ ok: false, code: 'INVALID_TYPE' })
  })
})

describe('a question inside a repeated entry that is only sometimes asked', () => {
  /** A group whose second member appears only when the first says so. */
  const template = () => templateOf(
    [
      field('PARTNERS', 'REPEAT_GROUP', 1, { repeatMin: 0, repeatMax: 3 }),
      field('IS_ACTIVE', 'BOOLEAN', 2, { parentFieldKey: 'PARTNERS' }),
      field('ACTIVE_SINCE', 'DATE', 3, { parentFieldKey: 'PARTNERS' }),
    ],
    [{
      fieldKey: 'ACTIVE_SINCE',
      effect: 'VISIBLE_WHEN',
      groupNumber: 1,
      sequenceNumber: 1,
      sourceFieldKey: 'IS_ACTIVE',
      operator: 'EQUALS',
      comparisonValue: 'true',
    }],
  )

  const saved = (entries: unknown[]) => {
    const resolved = template()
    const report = normalizeAnswers(resolved, answersFor(resolved, { PARTNERS: entries }), NOW)
    expect(report.issues).toEqual([])
    return { template: resolved, answers: report.value! }
  }

  /*
   * A sibling is read from its own entry, not from the top level — otherwise
   * one partner's answer would decide what every other partner is asked.
   */
  it('asks it in the entry that says yes and not in the one that says no', () => {
    const { template: resolved, answers } = saved([
      { IS_ACTIVE: true, ACTIVE_SINCE: '2025-01-01' },
      { IS_ACTIVE: false, ACTIVE_SINCE: null },
    ])
    const entries = answers.PARTNERS as { IS_ACTIVE: boolean }[]
    expect(visibleFields(resolved, answers, entries[0]!, 'PARTNERS')).toContain('ACTIVE_SINCE')
    expect(visibleFields(resolved, answers, entries[1]!, 'PARTNERS')).not.toContain('ACTIVE_SINCE')
  })

  it('clears the answer in the entry that stopped asking, and only that one', () => {
    const { template: resolved, answers } = saved([
      { IS_ACTIVE: true, ACTIVE_SINCE: '2025-01-01' },
      { IS_ACTIVE: false, ACTIVE_SINCE: '2024-01-01' },
    ])
    expect(pruneHidden(resolved, answers).PARTNERS).toEqual([
      { IS_ACTIVE: true, ACTIVE_SINCE: '2025-01-01' },
      { IS_ACTIVE: false, ACTIVE_SINCE: null },
    ])
  })

  // A group that is not asked at all takes its entries with it, rather than
  // leaving them to be read back as answers to a question nobody was asked.
  it('empties the whole group when the group itself is not asked', () => {
    const resolved = templateOf(
      [
        field('HAS_PARTNERS', 'BOOLEAN', 1),
        field('PARTNERS', 'REPEAT_GROUP', 2, { repeatMin: 0, repeatMax: 3 }),
        field('PARTNER_NAME', 'TEXT', 3, { parentFieldKey: 'PARTNERS', maxLength: 40 }),
      ],
      [{
        fieldKey: 'PARTNERS',
        effect: 'VISIBLE_WHEN',
        groupNumber: 1,
        sequenceNumber: 1,
        sourceFieldKey: 'HAS_PARTNERS',
        operator: 'EQUALS',
        comparisonValue: 'true',
      }],
    )
    const report = normalizeAnswers(resolved, answersFor(resolved, {
      HAS_PARTNERS: false,
      PARTNERS: [{ PARTNER_NAME: 'Asha' }],
    }), NOW)
    expect(report.issues).toEqual([])
    expect(pruneHidden(resolved, report.value!).PARTNERS).toEqual([])
  })
})

describe('how an issue names what it is about', () => {
  it('names a plain question by its key', () => {
    expect(issuePath('BUSINESS_NAME')).toBe('BUSINESS_NAME')
    expect(issuePath('BUSINESS_NAME', null, null)).toBe('BUSINESS_NAME')
    expect(issuePath('BUSINESS_NAME', 'PARTNERS', null)).toBe('BUSINESS_NAME')
    expect(issuePath('BUSINESS_NAME', null, 0)).toBe('BUSINESS_NAME')
  })

  it('names a member by its group and its entry', () => {
    expect(issuePath('PARTNER_NAME', 'PARTNERS', 0)).toBe('PARTNERS[0].PARTNER_NAME')
    expect(issuePath('PARTNER_NAME', 'PARTNERS', 12)).toBe('PARTNERS[12].PARTNER_NAME')
  })

  /*
   * No trailing dot. The client puts this exact string on a control's `id`, and
   * `PARTNERS[0].` matches nothing on the screen — so an applicant was told an
   * entry was wrong and had nowhere to click.
   */
  it('names the entry itself when no question in it is at fault', () => {
    expect(issuePath('', 'PARTNERS', 0)).toBe('PARTNERS[0]')
  })
})

/**
 * A template the authoring check would have refused, read back anyway.
 *
 * `resolveFormTemplate` is total-or-null and is the one door into the engine.
 * It returns `null` rather than throwing, and `null` means the rows were edited
 * by hand — every path that writes them goes through `formTemplateProblem`
 * first. These are the cases where that assumption has already been broken.
 */
describe('a template the engine cannot make sense of', () => {
  /*
   * Rows rather than `templateOf`, because that helper throws when resolution
   * fails and these cases are about it returning `null`. The role fields are
   * carried anyway: without them nothing resolves, so a test built on a bare
   * field would go green for the wrong reason — which is what the first
   * version of this block did.
   */
  const rows = (fields: FieldRow[]) => ({
    programmeCycleId: 'c1',
    programmeCycleVersion: 1,
    stages: [{ stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 }],
    fields: [...fields, ...roleFields],
    options: roleOptions,
    conditions: [],
  })

  const withPattern = (pattern: string): FieldRow[] => [
    field('CODE', 'TEXT', 1, { pattern, maxLength: 50 }),
  ]

  it('resolves the same template when the pattern is a valid one', () => {
    // The control the four cases below rest on: without it, "returns null"
    // proves nothing about the pattern.
    expect(resolveFormTemplate(rows(withPattern('^[A-Z]{3}$')))).not.toBeNull()
  })

  it('refuses a pattern that is not a valid expression', () => {
    expect(resolveFormTemplate(rows(withPattern('([unclosed')))).toBeNull()
  })

  /*
   * Length-capped before it is compiled, because compiling is itself work and
   * the expression came from a template author rather than from this code.
   */
  it('refuses a pattern past the length a cycle may declare', () => {
    expect(resolveFormTemplate(rows(withPattern(`^${'a'.repeat(200)}$`)))).toBeNull()
  })

  /*
   * Anchoring is not a convenience: `RegExp.test` searches, so an unanchored
   * `\d{6}` accepts "abc123456xyz" — the question would look validated and
   * would not be.
   */
  it('anchors a pattern the cycle wrote unanchored', () => {
    const resolved = resolveFormTemplate(rows(withPattern('\\d{6}')))!
    expect(resolved).not.toBeNull()
    const report = normalizeAnswers(
      resolved, answersFor(resolved, { CODE: 'abc123456xyz' }), NOW,
    )
    expect(report.issues.map((each) => each.code)).toEqual(['PATTERN_MISMATCH'])
    expect(normalizeAnswers(resolved, answersFor(resolved, { CODE: '123456' }), NOW).issues)
      .toEqual([])
  })

  // An alternation anchors as a whole rather than binding `^` to one branch,
  // which is what the non-capturing group around it is for.
  it('anchors an alternation as a whole', () => {
    const resolved = resolveFormTemplate(rows(withPattern('cat|dog')))!
    const refused = normalizeAnswers(resolved, answersFor(resolved, { CODE: 'hotdog' }), NOW)
    expect(refused.issues.map((each) => each.code)).toEqual(['PATTERN_MISMATCH'])
    expect(normalizeAnswers(resolved, answersFor(resolved, { CODE: 'dog' }), NOW).issues)
      .toEqual([])
  })
})
