/**
 * The fixture template, proved before the suites are built on it.
 *
 * Two suites are about to seed this and assert against what they get back, so
 * it has to be a template the product would really accept: it must pass the
 * authoring check, resolve, bind every role, and take `completeAnswers()`
 * without a single issue. A fixture that quietly fails one of those would make
 * every test built on it fail for a reason none of them names.
 */
import { describe, expect, it } from 'vitest'
import { formTemplateProblem } from '../../src/services/admin/form-template-input'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import {
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import { formFieldRoles } from '../../src/db/schema/seb/form-template'
import type { FormTemplateRows } from '../../src/services/application/form/types'
import { completeAnswers, defaultTemplate, templateRowsFor, withoutField } from '../support/form'
import { permissivePolicy } from './support/template'

const asRows = (): FormTemplateRows => templateRowsFor(defaultTemplate())

describe('the fixture form', () => {
  it('is one the authoring write would accept', () => {
    expect(formTemplateProblem(defaultTemplate())).toBeNull()
  })

  it('resolves', () => {
    expect(resolveFormTemplate(asRows())).not.toBeNull()
  })

  it('binds every role, which is what lets a cycle open', () => {
    const template = resolveFormTemplate(asRows())!
    for (const role of formFieldRoles) {
      expect(template.roles[role], role).toBeTruthy()
    }
  })

  it('accepts a complete answer set with no issues at all', () => {
    const template = resolveFormTemplate(asRows())!
    const normalized = normalizeAnswers(template, completeAnswers(), new Date('2026-06-01'))
    expect(normalized.issues).toEqual([])
    expect(normalized.value).not.toBeNull()

    const report = validateAnswersForSubmission(
      template,
      normalized.value!,
      // The documents this answer set makes required, as attached.
      new Set([
        'IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF',
        'DPR', 'BANK_DETAILS',
      ]),
      new Date('2026-06-01'),
      permissivePolicy,
    )
    expect(report.issues).toEqual([])
    expect(report.valid).toBe(true)
  })

  /*
   * The conditions do something, asserted rather than assumed.
   *
   * A template whose conditions never fire would pass every test above and be
   * useless as a fixture — the suites built on it are the ones that exercise
   * conditional visibility end to end.
   */
  it('asks for the certificate only when the answer says it applies', () => {
    const template = resolveFormTemplate(asRows())!
    const attached = new Set([
      'IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF',
      'DPR', 'BANK_DETAILS',
    ])
    const answers = normalizeAnswers(
      template, completeAnswers({ NOC_REQUIRED: true }), new Date('2026-06-01'),
    ).value!
    const report = validateAnswersForSubmission(
      template, answers, attached, new Date('2026-06-01'), permissivePolicy,
    )
    expect(report.issues.map((issue) => issue.field)).toContain('NOC')
  })

  it('stops asking the prior-funding questions when the answer is no', () => {
    const template = resolveFormTemplate(asRows())!
    // Answered "yes" to prior funding but nothing else: the three dependent
    // questions become required, which is what `CONDITIONAL` means.
    const answers = normalizeAnswers(
      template,
      completeAnswers({ RECEIVED_GOVERNMENT_FUNDING: true }),
      new Date('2026-06-01'),
    ).value!
    const report = validateAnswersForSubmission(
      template,
      answers,
      new Set([
        'IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF',
        'DPR', 'BANK_DETAILS',
      ]),
      new Date('2026-06-01'),
      permissivePolicy,
    )
    expect(report.issues.map((issue) => issue.field).sort()).toEqual([
      'GOVERNMENT_FUNDING_AMOUNT_PAISE',
      'GOVERNMENT_FUNDING_SANCTION_YEAR',
      'GOVERNMENT_SCHEME_NAME',
    ])
  })

  it('can be varied without declaring a second template', () => {
    /*
     * Both, because removing a question orphans whatever depended on it: the
     * no-objection certificate is `CONDITIONAL` and its only rule named the
     * yes/no question. The authoring check refuses that — a conditional
     * question with no rule saying when is one nothing can ever make required
     * — so this is what a real edit looks like rather than a workaround.
     */
    const smaller = defaultTemplate((template) =>
      withoutField('NOC')(withoutField('NOC_REQUIRED')(template)),
    )
    expect(formTemplateProblem(smaller)).toBeNull()
    expect(smaller.fields.some((field) => field.fieldKey === 'NOC_REQUIRED')).toBe(false)
    expect(smaller.conditions.some((each) => each.sourceFieldKey === 'NOC_REQUIRED')).toBe(false)
  })

  it('refuses a variation that orphans a conditional question', () => {
    // The rule above, stated as a refusal: taking the source away and leaving
    // the dependent behind is exactly the template that renders a question
    // nothing can satisfy.
    expect(formTemplateProblem(defaultTemplate(withoutField('NOC_REQUIRED'))))
      .toBe('NOC is conditionally required but has no rule saying when.')
  })

  /*
   * Twenty owners at the members' own maxima must still fit a save. This is
   * the arithmetic the authoring check runs; asserting it against the fixture
   * keeps the fixture honest about its own worst case.
   */
  it('fits the answer byte budget at twenty owners', () => {
    expect(formTemplateProblem(defaultTemplate())).toBeNull()
    const template = resolveFormTemplate(asRows())!
    const owners = template.byKey.get('OWNERS')!
    expect(owners.rules.maxRepeat).toBe(20)
  })

  it('carries its presentation through resolution', () => {
    const template = resolveFormTemplate(asRows())!
    expect(template.stages[0]).toMatchObject({
      key: 'OWNERS', iconName: 'users', estimatedMinutes: 5,
    })
    expect(template.byKey.get('SEED_FUND_REQUESTED_PAISE')!.presentation.prefixText).toBe('₹')
    expect(template.byKey.get('GOVERNMENT_FUNDING_SANCTION_YEAR')!.presentation.widthHint)
      .toBe('CHAR_4')
    expect(template.byKey.get('NAME')!.presentation.autocompleteHint).toBe('name')
  })
})
