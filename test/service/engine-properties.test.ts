/**
 * Layer 3: properties, over templates nobody wrote by hand.
 *
 * The tables in the other layers assert what somebody thought to check. These
 * assert things that must hold for *every* template, against several hundred
 * generated ones — which is how a case nobody imagined gets found.
 *
 * The generator is hand-rolled and seeded rather than a new dependency. Two
 * reasons: a failure has to be reproducible, so the seed is printed with it;
 * and the shapes worth generating here are narrow and specific — chains of
 * conditions, repeat groups, choice fields — which a general-purpose generator
 * would need as much configuring as writing.
 */
import { describe, expect, it } from 'vitest'
import { visibleFields } from '../../src/services/application/form/conditions'
import { answersEqual, pruneHidden } from '../../src/services/application/form/answers'
import { normalizeAnswers } from '../../src/services/application/form/engine'
import {
  answersFromRows,
  answersToRows,
} from '../../src/services/application/queries/form-template'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import type {
  AnswerMap,
  FormTemplateRows,
  ResolvedFormTemplate,
} from '../../src/services/application/form/types'
import { roleFields, roleOptions, roleAnswers, type FieldRow } from './support/template'

const NOW = new Date('2026-06-01T00:00:00Z')

/**
 * A tiny deterministic generator.
 *
 * `mulberry32`, chosen because it is six lines and reproducible from one
 * 32-bit seed — which is what makes a failure something a reader can rerun
 * rather than something that happened once on a machine they do not have.
 */
const randomFrom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = ReturnType<typeof randomFrom>

const pick = <T>(rng: Rng, values: readonly T[]): T =>
  values[Math.floor(rng() * values.length)]!

const GENERATED_TYPES = [
  'TEXT', 'LONG_TEXT', 'DATE', 'INTEGER', 'MONEY_PAISE',
  'BOOLEAN', 'ATTESTATION', 'SINGLE_CHOICE', 'MULTI_CHOICE',
] as const

type GeneratedType = (typeof GENERATED_TYPES)[number]

/** One generated template, and a matching answer set. */
const generate = (seed: number): {
  template: ResolvedFormTemplate
  answers: AnswerMap
  describe: string
} => {
  const rng = randomFrom(seed)
  const count = 3 + Math.floor(rng() * 6)
  const fields: FieldRow[] = []
  const options: FormTemplateRows['options'][number][] = []
  const conditions: FormTemplateRows['conditions'][number][] = []

  for (let index = 0; index < count; index += 1) {
    const key = `Q${index}`
    const type: GeneratedType = pick(rng, GENERATED_TYPES)
    const requirement = pick(rng, ['REQUIRED', 'OPTIONAL', 'CONDITIONAL'] as const)
    fields.push({
      stageKey: 'MAIN',
      fieldKey: key,
      fieldType: type,
      role: null,
      label: `Question ${index}`,
      helpText: null,
      /*
       * A `CONDITIONAL` question with no rule is a template the authoring
       * check refuses — it is a question nothing could ever make required — so
       * one is only generated where a rule will follow.
       */
      requirement: index === 0 && requirement === 'CONDITIONAL' ? 'OPTIONAL' : requirement,
      source: 'APPLICANT',
      sortOrder: index + 1,
      parentFieldKey: null,
      repeatMin: null,
      repeatMax: null,
      minLength: null,
      maxLength: type === 'TEXT' || type === 'LONG_TEXT' ? 200 : null,
      pattern: null,
      patternMessage: null,
      minValue: type === 'MONEY_PAISE' ? 0 : null,
      maxValue: null,
      minDate: null,
      maxDate: null,
      relativeDateBound: null,
      maxFileBytes: null,
    })
    if (type === 'SINGLE_CHOICE' || type === 'MULTI_CHOICE') {
      for (const value of ['ONE', 'TWO', 'THREE']) {
        options.push({
          fieldKey: key,
          optionValue: value,
          optionLabel: value,
          sortOrder: options.length + 1,
        })
      }
    }
    /*
     * Rules always point *backwards*, at a question already declared. A
     * generator free to point either way produces cycles, and a cycle is a
     * template `resolveFormTemplate` refuses — so the run would spend itself
     * discarding inputs rather than testing anything.
     */
    if (index > 0 && rng() < 0.55) {
      const source = fields[Math.floor(rng() * index)]!
      conditions.push({
        fieldKey: key,
        effect: fields[index]!.requirement === 'CONDITIONAL' ? 'REQUIRED_WHEN' : 'VISIBLE_WHEN',
        groupNumber: 1,
        sequenceNumber: conditions.filter((each) => each.fieldKey === key).length + 1,
        sourceFieldKey: source.fieldKey,
        operator: pick(rng, ['EQUALS', 'NOT_EQUALS', 'IS_PRESENT', 'IS_ABSENT'] as const),
        comparisonValue: comparisonFor(source.fieldType as GeneratedType),
      })
    }
    if (fields[index]!.requirement === 'CONDITIONAL'
      && !conditions.some((each) => each.fieldKey === key)) {
      fields[index]!.requirement = 'OPTIONAL'
    }
  }

  const resolved = resolveFormTemplate({
    programmeCycleId: 'c1',
    programmeCycleVersion: 1,
    stages: [{ stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 }],
    fields: [...fields, ...roleFields],
    options: [...options, ...roleOptions],
    conditions,
  })
  if (!resolved) throw new Error(`seed ${seed} produced a template that does not resolve`)

  const supplied: Record<string, unknown> = { ...roleAnswers }
  for (const each of fields) {
    supplied[each.fieldKey] = rng() < 0.25
      ? emptyFor(each.fieldType as GeneratedType)
      : valueFor(each.fieldType as GeneratedType, rng)
  }
  const normalized = normalizeAnswers(resolved, supplied, NOW)
  if (!normalized.value) {
    throw new Error(`seed ${seed}: ${JSON.stringify(normalized.issues)}`)
  }
  return { template: resolved, answers: normalized.value, describe: `seed ${seed}` }
}

function comparisonFor(type: GeneratedType): string | null {
  switch (type) {
    case 'BOOLEAN':
    case 'ATTESTATION':
      return 'true'
    case 'INTEGER':
    case 'MONEY_PAISE':
      return '5'
    case 'DATE':
      return '2020-01-01'
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE':
      return 'ONE'
    default:
      return 'MATCH'
  }
}

function valueFor(type: GeneratedType, rng: Rng): unknown {
  switch (type) {
    case 'TEXT':
    case 'LONG_TEXT':
      return rng() < 0.5 ? 'MATCH' : 'something else'
    case 'DATE':
      return rng() < 0.5 ? '2020-01-01' : '2021-07-09'
    case 'INTEGER':
    case 'MONEY_PAISE':
      return rng() < 0.5 ? 5 : 900
    case 'BOOLEAN':
    case 'ATTESTATION':
      return rng() < 0.5
    case 'SINGLE_CHOICE':
      return pick(rng, ['ONE', 'TWO', 'THREE'])
    case 'MULTI_CHOICE':
      return rng() < 0.5 ? ['ONE'] : ['TWO', 'THREE']
  }
}

function emptyFor(type: GeneratedType): unknown {
  return type === 'MULTI_CHOICE' ? [] : null
}

/** Every seed the run covers, fixed so a failure is reproducible. */
const SEEDS = Array.from({ length: 200 }, (_, index) => 1_000 + index)

describe('over generated templates', () => {
  it('generates the number of templates it claims to', () => {
    expect(SEEDS).toHaveLength(200)
    expect(new Set(SEEDS).size).toBe(SEEDS.length)
  })

  /**
   * Pruning is idempotent.
   *
   * If it were not, a draft would change every time it was saved without the
   * applicant touching it — and two saves in a row would disagree about what
   * the form holds.
   */
  it.each(SEEDS)('prune(prune(a)) equals prune(a) — %i', (seed) => {
    const { template, answers, describe: label } = generate(seed)
    const once = pruneHidden(template, answers)
    expect(pruneHidden(template, once), label).toEqual(once)
  })

  /**
   * Pruning only ever removes.
   *
   * An answer that appears from nowhere is an answer nobody gave, and it would
   * be stored against the applicant's name.
   */
  it.each(SEEDS)('pruning invents no answers — %i', (seed) => {
    const { template, answers, describe: label } = generate(seed)
    const pruned = pruneHidden(template, answers)
    for (const key of Object.keys(pruned)) {
      expect(Object.keys(answers), `${label}: ${key} appeared`).toContain(key)
    }
  })

  /**
   * Everything left after pruning belongs to a question still being asked —
   * judged against the *pruned* answers, not the originals.
   *
   * Checking against the originals would let a stale answer justify keeping
   * itself: it is only visible because of a value pruning was about to remove.
   */
  it.each(SEEDS)('every surviving answer belongs to a visible question — %i', (seed) => {
    const { template, answers, describe: label } = generate(seed)
    const pruned = pruneHidden(template, answers)
    const visible = visibleFields(template, pruned)
    for (const field of template.fields) {
      const value = pruned[field.key]
      if (value === undefined || value === null) continue
      if (Array.isArray(value) && value.length === 0) continue
      expect(visible.has(field.key), `${label}: ${field.key} answered but not asked`).toBe(true)
    }
  })

  /**
   * Storing an answer set and reading it back returns the same answers.
   *
   * The round trip crosses two representations — a map in the engine, rows
   * with two ordinals in the database — and every crossing is somewhere a
   * value can quietly change shape. This is the property the `ATTESTATION`
   * decoder broke: it lost nothing visibly, and made the form unsubmittable.
   */
  it.each(SEEDS)('an answer set survives being stored and read back — %i', (seed) => {
    const { template, answers, describe: label } = generate(seed)
    const rows = answersToRows(template, answers)
      .map((row) => ({ ...row, applicationVersionId: 'av1' }))
    const read = answersFromRows(template, 'av1', rows)
    expect(answersEqual(template, answers, read), label).toBe(true)
  })

  /**
   * Normalising an already-normalised set changes nothing.
   *
   * A save is normalise-then-store; a load is read-then-normalise. If the two
   * disagreed, an untouched draft would report itself as edited — which is
   * what decides whether a revision is in scope.
   */
  it.each(SEEDS)('normalising twice is the same as normalising once — %i', (seed) => {
    const { template, answers, describe: label } = generate(seed)
    const again = normalizeAnswers(template, answers, NOW)
    expect(again.issues, label).toEqual([])
    expect(answersEqual(template, answers, again.value!), label).toBe(true)
  })
})
