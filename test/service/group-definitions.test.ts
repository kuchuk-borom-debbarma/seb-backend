/**
 * Reusable structures: defined once, used as a repeated group, expanded into
 * ordinary rows at authoring time.
 *
 * Expansion is a pure function from an authored template to the flat model
 * everything downstream already proves — so what this suite pins is the
 * grammar (qualified keys), the guards (each a named sentence), and the shape
 * of what comes out. Everything after expansion is somebody else's suite.
 */
import { describe, expect, it } from 'vitest'
import { expandGroupDefinitions } from '../../src/services/admin/group-definitions'
import { formTemplateProblem } from '../../src/services/admin/form-template-input'
import type { FormTemplateInput } from '../../src/services/admin/types'
import { defaultTemplate } from '../support/form'

/** The fixture form plus an `OWNER`-style structure and one use of it. */
const withDefinition = (
  vary: (template: FormTemplateInput) => FormTemplateInput = (each) => each,
): FormTemplateInput => vary({
  ...defaultTemplate(),
  groupDefinitions: [{
    definitionKey: 'PARTNER',
    label: 'Partner',
    members: [
      {
        memberKey: 'NAME', fieldType: 'TEXT', label: 'Partner name',
        requirement: 'REQUIRED', maxLength: 120,
      },
      {
        memberKey: 'SHARE', fieldType: 'INTEGER', label: 'Share (%)',
        requirement: 'REQUIRED', minValue: 1, maxValue: 100, suffixText: '%',
      },
      {
        memberKey: 'KIND', fieldType: 'SINGLE_CHOICE', label: 'Kind',
        requirement: 'OPTIONAL',
        options: [
          { optionValue: 'WORKING', optionLabel: 'Working partner' },
          { optionValue: 'SLEEPING', optionLabel: 'Sleeping partner' },
        ],
      },
    ],
  }],
  fields: [
    ...defaultTemplate().fields,
    {
      stageKey: 'FINANCIAL', fieldKey: 'PARTNERS', fieldType: 'REPEAT_GROUP',
      label: 'Partners', requirement: 'OPTIONAL', repeatMin: 0, repeatMax: 5,
      groupDefinitionKey: 'PARTNER',
    },
  ],
})

describe('expanding a structure into the flat model', () => {
  it('materialises each member under a qualified key, after its use', () => {
    const expanded = expandGroupDefinitions(withDefinition())
    expect(typeof expanded).not.toBe('string')
    const template = expanded as FormTemplateInput
    const keys = template.fields.map((field) => field.fieldKey)
    const use = keys.indexOf('PARTNERS')
    expect(keys.slice(use, use + 4))
      .toEqual(['PARTNERS', 'PARTNERS__NAME', 'PARTNERS__SHARE', 'PARTNERS__KIND'])
    const name = template.fields.find((field) => field.fieldKey === 'PARTNERS__NAME')!
    expect(name).toMatchObject({
      stageKey: 'FINANCIAL', parentFieldKey: 'PARTNERS',
      fieldType: 'TEXT', requirement: 'REQUIRED', maxLength: 120,
    })
    // The member's choices came along, re-keyed.
    expect(template.options.filter((option) => option.fieldKey === 'PARTNERS__KIND'))
      .toHaveLength(2)
    // And the member's presentation survived.
    expect(template.fields.find((field) => field.fieldKey === 'PARTNERS__SHARE'))
      .toMatchObject({ suffixText: '%' })
  })

  it('produces a template the ordinary authoring check accepts', () => {
    const expanded = expandGroupDefinitions(withDefinition())
    expect(typeof expanded).not.toBe('string')
    expect(formTemplateProblem(expanded as FormTemplateInput)).toBeNull()
  })

  it('uses a single instance as bounds one-to-one', () => {
    const expanded = expandGroupDefinitions(withDefinition((template) => ({
      ...template,
      fields: template.fields.map((field) => field.fieldKey === 'PARTNERS'
        ? { ...field, repeatMin: 1, repeatMax: 1 }
        : field),
    }))) as FormTemplateInput
    expect(expanded.fields.find((field) => field.fieldKey === 'PARTNERS'))
      .toMatchObject({ repeatMin: 1, repeatMax: 1 })
  })

  it('leaves a template with no definitions exactly alone', () => {
    const plain = defaultTemplate()
    expect(expandGroupDefinitions(plain)).toEqual(plain)
  })
})

describe('what a cycle may not say about its structures', () => {
  const problem = (vary: (template: FormTemplateInput) => FormTemplateInput) => {
    const expanded = expandGroupDefinitions(withDefinition(vary))
    return typeof expanded === 'string' ? expanded : null
  }

  it('refuses a use naming a structure the cycle does not define', () => {
    expect(problem((template) => ({
      ...template,
      fields: template.fields.map((field) => field.fieldKey === 'PARTNERS'
        ? { ...field, groupDefinitionKey: 'NOWHERE' }
        : field),
    }))).toBe('PARTNERS uses a structure called NOWHERE, which this cycle does not define.')
  })

  it('refuses a structure on anything but a repeated group', () => {
    expect(problem((template) => ({
      ...template,
      fields: template.fields.map((field) => field.fieldKey === 'NOC_REQUIRED'
        ? { ...field, groupDefinitionKey: 'PARTNER' }
        : field),
    }))).toBe('Only a repeated group can use a structure, and NOC_REQUIRED is not one.')
  })

  it('refuses a use that declares members of its own', () => {
    expect(problem((template) => ({
      ...template,
      fields: [...template.fields, {
        stageKey: 'FINANCIAL', fieldKey: 'EXTRA', fieldType: 'TEXT',
        label: 'Extra', requirement: 'OPTIONAL', maxLength: 10,
        parentFieldKey: 'PARTNERS',
      }],
    }))).toBe('PARTNERS uses a structure and cannot declare members of its own.')
  })

  it('refuses more than sixteen structures', () => {
    expect(problem((template) => ({
      ...template,
      groupDefinitions: Array.from({ length: 17 }, (_, index) => ({
        definitionKey: `DEF_${index}`, label: `Definition ${index}`,
        members: [{
          memberKey: 'NAME', fieldType: 'TEXT' as const, label: 'Name',
          requirement: 'OPTIONAL' as const, maxLength: 10,
        }],
      })),
      fields: defaultTemplate().fields,
    }))).toBe('A cycle may define at most 16 reusable structures.')
  })

  it('refuses a structure with no members, and one with more than 24', () => {
    expect(problem((template) => ({
      ...template,
      groupDefinitions: [{ ...template.groupDefinitions![0]!, members: [] }],
    }))).toBe('The structure PARTNER needs at least one member.')
    expect(problem((template) => ({
      ...template,
      groupDefinitions: [{
        ...template.groupDefinitions![0]!,
        members: Array.from({ length: 25 }, (_, index) => ({
          memberKey: `M_${index}`, fieldType: 'TEXT' as const, label: `M ${index}`,
          requirement: 'OPTIONAL' as const, maxLength: 10,
        })),
      }],
    }))).toBe('The structure PARTNER may have at most 24 members.')
  })

  it('refuses a member that is a group, a document, or a statement', () => {
    for (const fieldType of ['REPEAT_GROUP', 'FILE', 'STATEMENT'] as const) {
      expect(problem((template) => ({
        ...template,
        groupDefinitions: [{
          ...template.groupDefinitions![0]!,
          members: [{
            memberKey: 'BAD', fieldType, label: 'Bad', requirement: 'OPTIONAL',
          }],
        }],
      }))).toBe('A member of PARTNER cannot be a repeated group, a document, or a statement.')
    }
  })

  it('refuses two structures under one key, and a key that is not a key', () => {
    expect(problem((template) => ({
      ...template,
      groupDefinitions: [
        template.groupDefinitions![0]!,
        { ...template.groupDefinitions![0]! },
      ],
    }))).toBe('This cycle already defines a structure called PARTNER.')
    expect(problem((template) => ({
      ...template,
      groupDefinitions: [{
        ...template.groupDefinitions![0]!, definitionKey: 'not a key',
      }],
      fields: template.fields.map((field) => field.fieldKey === 'PARTNERS'
        ? { ...field, groupDefinitionKey: 'not a key' }
        : field),
    }))).toBe('The structure key not a key is not a valid key.')
  })

  it('refuses a qualified key that would run past sixty-four characters', () => {
    // 60 + '__' + 'NAME' = 66 characters, past the 64 a key may hold.
    const longUse = 'U'.repeat(60)
    expect(problem((template) => ({
      ...template,
      fields: template.fields.map((field) => field.fieldKey === 'PARTNERS'
        ? { ...field, fieldKey: longUse }
        : field),
    }))).toBe(
      `Expanding ${longUse} makes the key ${longUse}__NAME, which is longer than a key may be.`,
    )
  })

  it('refuses an expansion that collides with a question the cycle asks', () => {
    expect(problem((template) => ({
      ...template,
      fields: [...template.fields, {
        stageKey: 'FINANCIAL', fieldKey: 'PARTNERS__NAME', fieldType: 'TEXT',
        label: 'Impostor', requirement: 'OPTIONAL', maxLength: 10,
      }],
    }))).toBe('Expanding PARTNERS collides with a question called PARTNERS__NAME.')
  })

  it('refuses conditions among a structure use, in this version', () => {
    expect(problem((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'PARTNERS__NAME', effect: 'REQUIRED_WHEN',
        sourceFieldKey: 'NOC_REQUIRED', sourceFieldType: 'BOOLEAN',
        operator: 'EQUALS', comparisonValue: 'true',
      }],
    }))).toBe(
      'PARTNERS__NAME belongs to a structure: rules on structure members are not supported yet.',
    )
  })

  it('lets a role-bound member through once, and the duplicate-role check catch twice', () => {
    const roled = (template: FormTemplateInput): FormTemplateInput => ({
      ...template,
      groupDefinitions: [{
        definitionKey: 'PARTNER', label: 'Partner',
        members: [{
          memberKey: 'BORN', fieldType: 'DATE', label: 'Date of birth',
          requirement: 'REQUIRED', role: 'APPLICANT_DATE_OF_BIRTH',
        }],
      }],
    })
    const once = expandGroupDefinitions(withDefinition(roled))
    expect(typeof once).not.toBe('string')
    // The fixture already binds the role inside OWNERS, so the expanded twin
    // is a second claim — refused by the ordinary role pass, by name.
    expect(formTemplateProblem(once as FormTemplateInput))
      .toContain("both claim to be the cycle's APPLICANT_DATE_OF_BIRTH")
  })
})

describe('what a member may play', () => {
  const memberWithRole = (role: string, fieldType = 'DATE') => (template: FormTemplateInput) => ({
    ...template,
    groupDefinitions: [{
      definitionKey: 'PARTNER', label: 'Partner',
      members: [{
        memberKey: 'BORN', fieldType: fieldType as never, label: 'Born',
        requirement: 'REQUIRED' as const, role: role as never,
      }],
    }],
    // Deliberately UNUSED: an invalid definition nothing uses yet must still
    // be refused with a sentence, or it dies on the member table's CHECK.
    fields: defaultTemplate().fields,
  })

  it('refuses any role but the date of birth, even on an unused structure', () => {
    const expanded = expandGroupDefinitions(withDefinition(
      memberWithRole('SEED_FUND_REQUESTED_PAISE', 'MONEY_PAISE'),
    ))
    expect(expanded).toBe('A member of PARTNER can only play APPLICANT_DATE_OF_BIRTH.')
  })

  it('refuses the date-of-birth role on a member that is not a date', () => {
    const expanded = expandGroupDefinitions(withDefinition(
      memberWithRole('APPLICANT_DATE_OF_BIRTH', 'TEXT'),
    ))
    expect(expanded).toBe('BORN plays APPLICANT_DATE_OF_BIRTH and must be a DATE member.')
  })
})
