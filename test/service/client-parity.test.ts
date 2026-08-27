/**
 * The client's copy of the visibility rules, checked against the server's.
 *
 * The applicant has to see a question appear the moment the answer above it
 * changes, so the client evaluates conditions itself rather than asking. That
 * makes two implementations of one rule, and two implementations of one rule
 * disagree — quietly, and about which questions somebody was asked.
 *
 * This runs both over the same templates and the same answers and asserts they
 * agree. It is not a fixture of expected values: a fixture only says what
 * somebody believed when they wrote it, and would go on passing while both
 * implementations drifted the same wrong way. Comparing the real functions is
 * what makes it evidence.
 *
 * The client module is importable here because it has **no runtime imports** —
 * every import in it is `import type`. If that stops being true this test
 * breaks loudly, which is the right outcome: something in the renderer would
 * have been pulled into a rule that is supposed to be pure.
 */
import { describe, expect, it } from 'vitest'
import {
  isRequiredWhenVisible as serverRequired,
  visibleFields as serverVisible,
} from '../../src/services/application/form/conditions'
import { pruneHidden as serverPrune } from '../../src/services/application/form/answers'
import type {
  AnswerMap,
  ResolvedFormTemplate,
} from '../../src/services/application/form/types'
import {
  isRequiredWhenVisible as clientRequired,
  pruneHidden as clientPrune,
  resolveTemplate,
  visibleFields as clientVisible,
} from '../../dev-web/src/features/application/formTemplate'
import { answersFor, field, templateOf, type FieldRow } from './support/template'

/**
 * The resolved server template, in the shape the client receives over GraphQL.
 *
 * The wire shape is the honest input: the client never sees the server's
 * resolved object, so a parity check built on that object would be comparing
 * two views of the same thing rather than the two implementations.
 */
const asWireTemplate = (template: ResolvedFormTemplate) => ({
  programmeCycleId: template.programmeCycleId,
  programmeCycleVersion: template.programmeCycleVersion,
  stages: template.stages.map((stage) => ({
    key: stage.key,
    title: stage.title,
    description: stage.description,
    position: stage.position,
  })),
  fields: template.fields.map((each) => ({
    key: each.key,
    stageKey: each.stageKey,
    type: each.type,
    role: each.role,
    label: each.label,
    helpText: each.helpText,
    requirement: each.requirement,
    source: each.source,
    position: each.position,
    repeatGroupKey: each.repeatGroupKey,
    options: each.options.map((option) => ({ ...option })),
    validation: { ...each.rules },
    conditions: each.conditions.map((condition) => ({ ...condition })),
  })),
})

const condition = (
  fieldKey: string,
  sourceFieldKey: string,
  operator: string,
  comparisonValue: string | null,
  effect: 'VISIBLE_WHEN' | 'REQUIRED_WHEN' = 'VISIBLE_WHEN',
  groupNumber = 1,
  sequenceNumber = 1,
) => ({
  fieldKey,
  effect,
  groupNumber,
  sequenceNumber,
  sourceFieldKey,
  operator,
  comparisonValue,
}) as never

/** Each case names a template, and the answer sets to try it under. */
const cases: { name: string; fields: FieldRow[]; conditions: unknown[]; answers: AnswerMap[] }[] = [
  {
    name: 'a plain equality condition',
    fields: [
      field('HAS_LOAN', 'BOOLEAN', 1),
      field('LOAN_BANK', 'TEXT', 2),
    ],
    conditions: [condition('LOAN_BANK', 'HAS_LOAN', 'EQUALS', 'true')],
    answers: [{}, { HAS_LOAN: true }, { HAS_LOAN: false }, { HAS_LOAN: null }],
  },
  {
    name: 'a chain, where the source is itself conditional',
    fields: [
      field('FUNDED', 'BOOLEAN', 1),
      field('SCHEME', 'TEXT', 2),
      field('SCHEME_YEAR', 'INTEGER', 3),
    ],
    conditions: [
      condition('SCHEME', 'FUNDED', 'EQUALS', 'true'),
      condition('SCHEME_YEAR', 'SCHEME', 'IS_PRESENT', null),
    ],
    // The third row is the one a naive engine gets wrong: the answer to a
    // hidden source is still in the map, and must read as unanswered.
    answers: [
      { FUNDED: true, SCHEME: 'PMEGP' },
      { FUNDED: false, SCHEME: null },
      { FUNDED: false, SCHEME: 'PMEGP' },
      { FUNDED: null, SCHEME: 'PMEGP' },
    ],
  },
  {
    /*
     * A repeated group behind a condition, and a member carrying none of its
     * own. Both implementations ordered the member before its group and read
     * it as permanently hidden — the client drew entry cards with no questions
     * in them, the server cleared the entries on the next save. Neither threw,
     * and no case in this table reached it.
     */
    name: 'a repeated group that is only asked sometimes',
    fields: [
      field('HAS_PARTNERS', 'BOOLEAN', 1),
      field('PARTNERS', 'REPEAT_GROUP', 2, { repeatMin: 0, repeatMax: 5 }),
      field('PARTNER_NAME', 'TEXT', 3, { parentFieldKey: 'PARTNERS', maxLength: 100 }),
    ],
    conditions: [condition('PARTNERS', 'HAS_PARTNERS', 'EQUALS', 'true')],
    answers: [
      { HAS_PARTNERS: true, PARTNERS: [{ PARTNER_NAME: 'Asha Debbarma' }] },
      { HAS_PARTNERS: false, PARTNERS: [{ PARTNER_NAME: 'Asha Debbarma' }] },
      { HAS_PARTNERS: null, PARTNERS: [] },
    ],
  },
  {
    name: 'two groups, which are alternatives',
    fields: [
      field('SECTOR', 'SINGLE_CHOICE', 1),
      field('CATEGORY', 'SINGLE_CHOICE', 2),
      field('EXTRA', 'TEXT', 3),
    ],
    conditions: [
      condition('EXTRA', 'SECTOR', 'EQUALS', 'FOOD', 'VISIBLE_WHEN', 1, 1),
      condition('EXTRA', 'CATEGORY', 'EQUALS', 'B', 'VISIBLE_WHEN', 2, 1),
    ],
    answers: [
      {},
      { SECTOR: 'FOOD' },
      { CATEGORY: 'B' },
      { SECTOR: 'FOOD', CATEGORY: 'B' },
      { SECTOR: 'OTHER', CATEGORY: 'A' },
    ],
  },
  {
    name: 'one group, whose members are ANDed',
    fields: [
      field('SECTOR', 'SINGLE_CHOICE', 1),
      field('CATEGORY', 'SINGLE_CHOICE', 2),
      field('EXTRA', 'TEXT', 3),
    ],
    conditions: [
      condition('EXTRA', 'SECTOR', 'EQUALS', 'FOOD', 'VISIBLE_WHEN', 1, 1),
      condition('EXTRA', 'CATEGORY', 'EQUALS', 'B', 'VISIBLE_WHEN', 1, 2),
    ],
    answers: [
      { SECTOR: 'FOOD' },
      { CATEGORY: 'B' },
      { SECTOR: 'FOOD', CATEGORY: 'B' },
    ],
  },
  {
    name: 'ordering operators over a number and a date',
    fields: [
      field('AMOUNT', 'INTEGER', 1),
      field('WHEN', 'DATE', 2),
      field('BIG', 'TEXT', 3),
      field('RECENT', 'TEXT', 4),
    ],
    conditions: [
      condition('BIG', 'AMOUNT', 'GREATER_OR_EQUAL', '100'),
      condition('RECENT', 'WHEN', 'LESS_THAN', '2026-01-01'),
    ],
    answers: [
      { AMOUNT: 99, WHEN: '2025-12-31' },
      { AMOUNT: 100, WHEN: '2026-01-01' },
      { AMOUNT: 101, WHEN: '2026-06-01' },
      { AMOUNT: null, WHEN: null },
      // Unparseable on both sides, and both must refuse rather than guess.
      { AMOUNT: 'not a number', WHEN: 'not a date' },
    ],
  },
  {
    name: 'absence, and a multiple choice compared by membership',
    fields: [
      field('CHOICES', 'MULTI_CHOICE', 1),
      field('WHY_NOT', 'TEXT', 2),
      field('BECAUSE', 'TEXT', 3),
    ],
    conditions: [
      condition('WHY_NOT', 'CHOICES', 'IS_ABSENT', null),
      condition('BECAUSE', 'CHOICES', 'EQUALS', 'B'),
    ],
    answers: [{ CHOICES: [] }, { CHOICES: ['A'] }, { CHOICES: ['A', 'B'] }, {}],
  },
  {
    name: 'a conditional requirement, which is a separate effect',
    fields: [
      field('OWNS', 'BOOLEAN', 1),
      field('PROOF', 'TEXT', 2, { requirement: 'CONDITIONAL' }),
    ],
    conditions: [condition('PROOF', 'OWNS', 'EQUALS', 'true', 'REQUIRED_WHEN')],
    answers: [{ OWNS: true }, { OWNS: false }, {}],
  },
  {
    /*
     * A question the programme office fills in.
     *
     * The client wrote a key for every field it walked, including these — and
     * the server refuses one outright, so a cycle declaring a single
     * `SERVER_DERIVED` question made **every save from this client fail** on a
     * key the applicant had never touched. Only comparing what is *pruned*
     * reaches it; visibility agreed perfectly throughout.
     */
    name: 'a question the office records rather than the applicant',
    fields: [
      field('HAS_PRIOR', 'BOOLEAN', 1),
      field('PRIOR_PAISE', 'MONEY_PAISE', 2, { source: 'SERVER_DERIVED', minValue: 0 }),
      field('NOTE', 'TEXT', 3, { maxLength: 100 }),
    ],
    conditions: [condition('NOTE', 'HAS_PRIOR', 'EQUALS', 'true')],
    answers: [{ HAS_PRIOR: true }, { HAS_PRIOR: false }],
  },
  {
    /*
     * A statement takes no answer at all, and the server refuses even a null
     * addressed to one — so a prune writing its key makes every save on a
     * statement-bearing cycle fail. The case that found the client doing
     * exactly that.
     */
    name: 'a statement, which is read and never answered',
    fields: [
      field('NOTICE', 'STATEMENT', 1, { requirement: 'OPTIONAL' }),
      field('NAME_TEXT', 'TEXT', 2, { maxLength: 50 }),
    ],
    conditions: [],
    answers: [{}, { NAME_TEXT: 'Rina' }],
  },
  {
    // A cleared multiple choice: an empty list on the server, and this used to
    // be null on the client. Harmless, because the server coerces null to `[]`
    // — and a harmless divergence between two copies of one rule is the one
    // that gets copied into the next.
    name: 'a cleared multiple choice',
    fields: [
      field('SHOW', 'BOOLEAN', 1),
      field('SECTORS', 'MULTI_CHOICE', 2, { minLength: 0, maxLength: 3 }),
    ],
    conditions: [condition('SECTORS', 'SHOW', 'EQUALS', 'true')],
    answers: [{ SHOW: true, SECTORS: ['A'] }, { SHOW: false, SECTORS: ['A'] }],
  },
]

/**
 * The one thing the client's prune must do that the server's must not.
 *
 * A save **replaces** the whole answer set: every non-FILE question the cycle
 * asks has to be an own property, because an absent key is
 * `MISSING_SNAPSHOT_FIELD` and an explicit null is the only way to take an
 * optional answer back. The client's state holds only what the applicant has
 * touched, so its prune has to fill in the rest.
 *
 * This is here because making the two identical looked like an improvement and
 * broke the form outright: the client began dropping untouched questions, the
 * server refused every save after the first, and the page showed "Saved" from
 * the one that had landed. It cost a browser to find; it costs a millisecond
 * to keep.
 */
describe('what the client sends is a whole answer set', () => {
  const template = () => templateOf([
    field('HAS_LOAN', 'BOOLEAN', 1),
    field('LOAN_BANK', 'TEXT', 2, { maxLength: 100 }),
    field('SECTORS', 'MULTI_CHOICE', 3),
  ], [condition('LOAN_BANK', 'HAS_LOAN', 'EQUALS', 'true')])

  const answerable = (resolved: ReturnType<typeof templateOf>) =>
    resolved.fields
      .filter((each) => each.type !== 'FILE' && each.repeatGroupKey === null
        && each.source !== 'SERVER_DERIVED')
      .map((each) => each.key)
      .sort()

  it('names every answerable question, from a browser that has answered none', () => {
    const server = template()
    const client = resolveTemplate(asWireTemplate(server) as never)
    const pruned = clientPrune(client, {} as AnswerMap)
    expect(Object.keys(pruned).sort()).toEqual(answerable(server))
  })

  it('still names them all when one answer has been typed', () => {
    const server = template()
    const client = resolveTemplate(asWireTemplate(server) as never)
    const pruned = clientPrune(client, { HAS_LOAN: true } as AnswerMap)
    expect(Object.keys(pruned).sort()).toEqual(answerable(server))
  })

  /*
   * And every value survives `JSON.stringify`, which is the shape it actually
   * travels in. `undefined` is an own property that encodes to nothing at all,
   * so a map that looks complete in memory can arrive missing keys.
   */
  it('sends every one of them over the wire', () => {
    const server = template()
    const client = resolveTemplate(asWireTemplate(server) as never)
    const encoded = JSON.parse(JSON.stringify(clientPrune(client, {} as AnswerMap)))
    expect(Object.keys(encoded).sort()).toEqual(answerable(server))
  })
})

describe('the client evaluates visibility exactly as the server does', () => {
  it('covers every case', () => {
    // A table that silently collapsed to zero rows would look like a fast green
    // run, so the count is asserted rather than assumed.
    expect(cases.length).toBe(11)
    expect(cases.flatMap((each) => each.answers).length).toBe(37)
  })

  for (const { name, fields, conditions, answers } of cases) {
    for (const [index, answerSet] of answers.entries()) {
      it(`${name}, answers ${index}`, () => {
        const server = templateOf(fields, conditions as never)
        const client = resolveTemplate(asWireTemplate(server) as never)
        const filled = answersFor(server, answerSet as Record<string, unknown>) as AnswerMap

        expect([...clientVisible(client, filled)].sort())
          .toEqual([...serverVisible(server, filled)].sort())

        const visible = serverVisible(server, filled)
        for (const each of server.fields) {
          if (!visible.has(each.key)) continue
          const clientField = client.byKey.get(each.key)!
          expect(
            clientRequired(client, clientField, filled, visible),
            `${each.key} required`,
          ).toBe(serverRequired(server, each, filled, visible))
        }

        /*
         * And what each one *keeps*, not only what each one shows.
         *
         * Agreeing about visibility is not the whole rule: the answers the
         * client sends are the answers it pruned, and a key it writes that the
         * server refuses is a save that fails however well the two agree about
         * which questions were asked.
         *
         * **Compared over the keys the server produces, not key for key.** The
         * two are deliberately not identical: the client's runs on browser
         * state holding only what has been touched and must return a *complete*
         * map, because a save replaces the whole answer set and a missing key
         * is `MISSING_SNAPSHOT_FIELD`. The server's runs on an already
         * normalized map where every question has a value, so it can skip what
         * is absent. Making them equal here is what broke the form: the client
         * started dropping untouched questions and every save after the first
         * was refused.
         */
        const clientPruned = clientPrune(client, filled)
        const serverPruned = serverPrune(server, filled)
        for (const [key, value] of Object.entries(serverPruned)) {
          expect(clientPruned[key], key).toEqual(value)
        }
      })
    }
  }
})
