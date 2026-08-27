/**
 * Answers belonging to different snapshots must never be merged.
 *
 * `findAnswerRows` deliberately reads many application versions at once — the
 * administrative workspace shows every submission an application has made. If
 * the function that folds rows into an answer map ignores which version a row
 * came from, one applicant's answers appear inside another's form: last row
 * wins for a scalar, selections concatenate, and every value is a plausible
 * value, so nothing downstream can notice.
 *
 * These pin the grouping. They came out of a security review of this change.
 */
import { describe, expect, it } from 'vitest'
import {
  answersByVersion,
  answersFromRows,
  answersToRows,
  type StoredAnswerRow,
} from '../../src/services/application/queries/form-template'
import { normalizeAnswers } from '../../src/services/application/form/engine'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import { answersFor, field, roleFields, roleOptions, templateOf } from './support/template'

const NOW = new Date('2026-01-15T12:00:00Z')

const rowsFor = (
  template: ReturnType<typeof templateOf>,
  applicationVersionId: string,
  overrides: Record<string, unknown>,
): StoredAnswerRow[] => {
  const normalized = normalizeAnswers(template, answersFor(template, overrides), NOW)
  expect(normalized.issues).toEqual([])
  return answersToRows(template, normalized.value!).map((row) => ({
    ...row,
    applicationVersionId,
  }))
}

describe('two applicants’ answers in one read', () => {
  const template = templateOf([field('NOTE', 'TEXT', 1, { maxLength: 100 })])
  const victim = rowsFor(template, 'av-victim', {
    SEED_FUND_REQUESTED_PAISE: 111_00,
    NOTE: 'private to the victim',
  })
  const attacker = rowsFor(template, 'av-attacker', {
    SEED_FUND_REQUESTED_PAISE: 999_00,
    NOTE: 'attacker note',
  })
  const mixed = [...victim, ...attacker]

  it('keeps each version’s answers to itself when read one at a time', () => {
    expect(answersFromRows(template, 'av-victim', mixed).NOTE).toBe('private to the victim')
    expect(answersFromRows(template, 'av-attacker', mixed).NOTE).toBe('attacker note')
  })

  it('never lets the other applicant’s value through', () => {
    const forVictim = answersFromRows(template, 'av-victim', mixed)
    expect(forVictim.SEED_FUND_REQUESTED_PAISE).toBe(111_00)
    expect(forVictim.NOTE).not.toBe('attacker note')
  })

  it('groups a multi-version read rather than folding it flat', () => {
    const grouped = answersByVersion(template, mixed)
    expect([...grouped.keys()].sort()).toEqual(['av-attacker', 'av-victim'])
    expect(grouped.get('av-victim')?.NOTE).toBe('private to the victim')
    expect(grouped.get('av-attacker')?.NOTE).toBe('attacker note')
  })

  it('reads a version with no rows as a wholly unanswered form', () => {
    const empty = answersFromRows(template, 'av-nobody', mixed)
    expect(empty.NOTE).toBeNull()
    expect(empty.SEED_FUND_REQUESTED_PAISE).toBeNull()
  })
})

describe('facts the programme office owns', () => {
  /*
   * A server-derived field is computed from the award and the ledger. An
   * applicant asserting one could understate their own prior funding to clear
   * an eligibility rule or a ceiling.
   *
   * The engine strips them at the top level; these check the group path, where
   * the guard was originally missing — a boundary that held at two of three
   * entry points is one maintained by vigilance rather than by structure.
   */
  it('refuses a template that hides a server-derived field inside a group', () => {
    expect(() =>
      templateOf([
        field('GRANTS', 'REPEAT_GROUP', 1, { repeatMin: 0, repeatMax: 5 }),
        field('GRANT_AMOUNT', 'MONEY_PAISE', 2, {
          parentFieldKey: 'GRANTS',
          minValue: 0,
          source: 'SERVER_DERIVED',
        }),
      ]),
    ).toThrow()
  })

  /*
   * Built from scratch rather than with `templateOf`, which already binds every
   * role at the top level — adding a second copy inside a group would be
   * refused as a duplicate key, and the test would pass without ever exercising
   * the rule it names. Here the role is bound *only* inside the group, so the
   * group rule is the one thing that can refuse it.
   */
  it('refuses a template that binds a role only inside a group', () => {
    const withRoleInGroup = resolveFormTemplate({
      programmeCycleId: 'c1',
      programmeCycleVersion: 1,
      stages: [{ stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 }],
      fields: [
        ...roleFields.filter((f) => f.fieldKey !== 'SEED_FUND_REQUESTED_PAISE'),
        field('GRANTS', 'REPEAT_GROUP', 1, { repeatMin: 0, repeatMax: 5 }),
        field('SEED_FUND_REQUESTED_PAISE', 'MONEY_PAISE', 2, {
          parentFieldKey: 'GRANTS',
          minValue: 0,
          role: 'SEED_FUND_REQUESTED_PAISE',
        }),
      ],
      options: roleOptions,
      conditions: [],
    })
    expect(withRoleInGroup).toBeNull()
  })
})

describe('several selections inside a repeated group', () => {
  /*
   * One row per selection, so a map keyed by field alone keeps only the last
   * and hands back a bare string where a list is expected. Covered at the top
   * level and for groups with scalar members, but the combination is where it
   * broke.
   */
  const template = templateOf(
    [
      field('SITES', 'REPEAT_GROUP', 1, { repeatMin: 0, repeatMax: 5 }),
      field('SITE_NAME', 'TEXT', 2, {
        parentFieldKey: 'SITES', maxLength: 50,
      }),
      field('SITE_FACILITIES', 'MULTI_CHOICE', 3, {
        parentFieldKey: 'SITES', }),
    ],
    [],
    [
      { fieldKey: 'SITE_FACILITIES', optionValue: 'POWER', optionLabel: 'Power', sortOrder: 1 },
      { fieldKey: 'SITE_FACILITIES', optionValue: 'WATER', optionLabel: 'Water', sortOrder: 2 },
      { fieldKey: 'SITE_FACILITIES', optionValue: 'ROAD', optionLabel: 'Road', sortOrder: 3 },
    ],
  )

  it('keeps every selection of every entry', () => {
    const rows = rowsFor(template, 'av1', {
      SITES: [
        { SITE_NAME: 'Agartala', SITE_FACILITIES: ['POWER', 'WATER'] },
        { SITE_NAME: 'Udaipur', SITE_FACILITIES: ['ROAD'] },
      ],
    })
    const read = answersFromRows(template, 'av1', rows)
    expect(read.SITES).toStrictEqual([
      { SITE_NAME: 'Agartala', SITE_FACILITIES: ['POWER', 'WATER'] },
      { SITE_NAME: 'Udaipur', SITE_FACILITIES: ['ROAD'] },
    ])
  })

  it('reads an entry that selected nothing as an empty list, not as text', () => {
    const rows = rowsFor(template, 'av1', {
      SITES: [{ SITE_NAME: 'Agartala', SITE_FACILITIES: [] }],
    })
    const read = answersFromRows(template, 'av1', rows)
    expect((read.SITES as { SITE_FACILITIES: unknown }[])[0]!.SITE_FACILITIES).toStrictEqual([])
  })
})
