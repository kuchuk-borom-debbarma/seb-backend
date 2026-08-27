/**
 * Every way a cycle's questions can be malformed, and what the officer is told.
 *
 * `formTemplateProblem` is the one validator behind every authoring mutation,
 * so a refusal it cannot express is a template that reaches the database and
 * fails there — as a constraint name, or as a form the engine returns `null`
 * for, which reads to an applicant as "this application's form is
 * unavailable".
 *
 * Each row asserts the **exact sentence**, because the sentence is the feature:
 * an officer who is told only that the form is invalid has to find the fault
 * themselves, in a form somebody else may have written.
 */
import { describe, expect, it } from 'vitest'
import { formTemplateProblem } from '../../src/services/admin/form-template-input'
import type { FormTemplateInput } from '../../src/services/admin/types'
import { defaultTemplate, withoutField } from '../support/form'

/** The fixture form, with one thing wrong with it. */
const spoiled = (
  change: (template: FormTemplateInput) => FormTemplateInput,
): string | null => formTemplateProblem(defaultTemplate(change))

const field = (
  template: FormTemplateInput,
  fieldKey: string,
): FormTemplateInput['fields'][number] =>
  template.fields.find((each) => each.fieldKey === fieldKey)!

const replacing = (
  fieldKey: string,
  change: (field: FormTemplateInput['fields'][number]) => FormTemplateInput['fields'][number],
) => (template: FormTemplateInput): FormTemplateInput => ({
  ...template,
  fields: template.fields.map((each) => each.fieldKey === fieldKey ? change(each) : each),
})

describe('what a cycle may not say about its questions', () => {
  it('accepts the fixture form unchanged', () => {
    expect(formTemplateProblem(defaultTemplate())).toBeNull()
  })

  it('refuses a form with no stages', () => {
    expect(spoiled((template) => ({ ...template, stages: [], fields: [], options: [], conditions: [] })))
      .toBe('A cycle must ask at least one stage of questions.')
  })

  it('refuses a stage key that is not a key', () => {
    expect(spoiled((template) => ({
      ...template,
      stages: [{ stageKey: 'not a key', title: 'Something' }, ...template.stages],
    }))).toBe('The stage key not a key is not a valid key.')
  })

  it('refuses a stage with no heading', () => {
    expect(spoiled((template) => ({
      ...template,
      stages: template.stages.map((stage, index) =>
        index === 0 ? { ...stage, title: '   ' } : stage),
    }))).toBe('Every stage needs a heading.')
  })

  it('refuses a question key that is not a key', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [...template.fields, { ...field(template, 'NOC_REQUIRED'), fieldKey: 'lower case' }],
    }))).toBe('The question key lower case is not a valid key.')
  })

  it('refuses a question in a stage the cycle does not have', () => {
    expect(spoiled(replacing('GENDER', (each) => ({ ...each, stageKey: 'NOWHERE' }))))
      .toBe('GENDER names a stage this cycle does not have.')
  })

  it('refuses a question with no label', () => {
    expect(spoiled(replacing('GENDER', (each) => ({ ...each, label: ' ' }))))
      .toBe('GENDER needs a label.')
  })

  it('refuses a question inside a repeated group the cycle does not have', () => {
    expect(spoiled(replacing('GENDER', (each) => ({ ...each, parentFieldKey: 'NO_SUCH_GROUP' }))))
      .toBe('GENDER names a repeated group this cycle does not have.')
  })

  /*
   * A group cannot sit inside a group. Nesting would make an answer's address
   * two indices deep, and the issue path a client puts on a control's `id`
   * carries exactly one.
   */
  /**
   * A cycle nobody could ever submit against.
   *
   * The engine caps an answer set at 32 KB on the wire. A cycle whose own
   * declared limits add up past that is published, opened, and then discovered
   * by the first applicant who fills it in — who is told to shorten their
   * longest answers, and cannot, because it is the form that is too large.
   * Nothing downstream is in a position to notice, so it is refused here.
   */
  it('refuses a form nobody could answer within the save limit', () => {
    const problem = spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        ...Array.from({ length: 30 }, (_, index) => ({
          ...field(template, 'GOVERNMENT_SCHEME_NAME'),
          fieldKey: `ESSAY_${index}`,
          role: null,
          requirement: 'OPTIONAL' as const,
          maxLength: 2_000,
        })),
      ],
    }))
    expect(problem).toContain('could not all be answered at once')
    // Names the figures, so an officer can see how far over they are.
    expect(problem).toContain('against a limit of 32 KB')
  })

  it('accepts a repeated group whose entries stay inside it', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNERS', fieldType: 'REPEAT_GROUP' as const,
          requirement: 'OPTIONAL' as const, role: null, repeatMin: 0, repeatMax: 5,
        },
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNER_NAME', fieldType: 'TEXT' as const,
          requirement: 'OPTIONAL' as const, role: null, maxLength: 100,
          parentFieldKey: 'PARTNERS',
        },
      ],
    }))).toBeNull()
  })

  /*
   * The group's cost is per entry, so a generous member and a generous bound
   * multiply. This is the shape that gets a cycle past a reviewer's eye and
   * fails only in front of an applicant.
   */
  it('refuses a repeated group whose entries multiply past the limit', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNERS', fieldType: 'REPEAT_GROUP' as const,
          // Twenty is the ceiling now; a 2,000-character essay per entry still
          // multiplies far past the budget.
          requirement: 'OPTIONAL' as const, role: null, repeatMin: 0, repeatMax: 20,
        },
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNER_STORY', fieldType: 'LONG_TEXT' as const,
          requirement: 'OPTIONAL' as const, role: null, maxLength: 2_000,
          parentFieldKey: 'PARTNERS',
        },
      ],
    }))).toContain('could not all be answered at once')
  })

  /**
   * A rule reading a question that is answered inside a repeated group.
   *
   * The third of the three cross-row rules the schema delegates to this module,
   * and the one that was never written. A rule inside an entry reads its
   * siblings from that entry and everything else from the top level, so a
   * top-level question reading a *member* reads a key that has no value there —
   * and the rule **silently never fires**.
   */
  it('refuses a rule that reads a question answered inside a group', () => {
    const withGroup = (template: FormTemplateInput): FormTemplateInput => ({
      ...template,
      fields: [
        ...template.fields,
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNERS', fieldType: 'REPEAT_GROUP' as const,
          requirement: 'OPTIONAL' as const, role: null, repeatMin: 0, repeatMax: 3,
        },
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNER_TYPE',
          fieldType: 'SINGLE_CHOICE' as const, requirement: 'OPTIONAL' as const, role: null,
          parentFieldKey: 'PARTNERS',
        },
      ],
      options: [
        ...template.options,
        {
          fieldKey: 'PARTNER_TYPE', fieldType: 'SINGLE_CHOICE' as const,
          optionValue: 'INDIVIDUAL', optionLabel: 'An individual', sortOrder: 1,
        },
      ],
    })

    expect(spoiled((template) => {
      const based = withGroup(template)
      return {
        ...based,
        conditions: [
          ...based.conditions,
          {
            fieldKey: 'GOVERNMENT_SCHEME_NAME',
            effect: 'REQUIRED_WHEN' as const,
            groupNumber: 1,
            sequenceNumber: 1,
            sourceFieldKey: 'PARTNER_TYPE',
            sourceFieldType: 'SINGLE_CHOICE' as const,
            operator: 'EQUALS' as const,
            comparisonValue: 'INDIVIDUAL',
          },
        ],
      }
    })).toBe(
      'GOVERNMENT_SCHEME_NAME has a rule that reads PARTNER_TYPE, which is answered '
      + 'inside PARTNERS and cannot be seen from here.',
    )
  })

  // A member reading a sibling in its own entry is exactly what a group is for.
  it('accepts a rule that reads a sibling in the same entry', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNERS', fieldType: 'REPEAT_GROUP' as const,
          requirement: 'OPTIONAL' as const, role: null, repeatMin: 0, repeatMax: 3,
        },
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNER_TYPE',
          fieldType: 'BOOLEAN' as const, requirement: 'OPTIONAL' as const, role: null,
          parentFieldKey: 'PARTNERS',
        },
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNER_PAN', fieldType: 'TEXT' as const,
          requirement: 'OPTIONAL' as const, role: null, maxLength: 20,
          parentFieldKey: 'PARTNERS',
        },
      ],
      conditions: [
        ...template.conditions,
        {
          fieldKey: 'PARTNER_PAN',
          effect: 'VISIBLE_WHEN' as const,
          groupNumber: 1,
          sequenceNumber: 1,
          sourceFieldKey: 'PARTNER_TYPE',
          sourceFieldType: 'BOOLEAN' as const,
          operator: 'EQUALS' as const,
          comparisonValue: 'true',
        },
      ],
    }))).toBeNull()
  })

  /**
   * A question the programme itself reads, removed.
   *
   * Two questions are role-bound: the decision bound and the age rule find
   * their inputs through a role across many cycles at once.
   * `resolveFormTemplate` returns `null` unless both are bound and nothing
   * here demanded it — so removing the requested amount gave a cycle whose
   * form **could not be read back at all**, and the only sign was the cycle
   * later refusing to open.
   */
  it('refuses a form with no question the programme can read as a role', () => {
    expect(spoiled(withoutField('SEED_FUND_REQUESTED_PAISE')))
      .toBe('Every cycle needs one question the programme reads as SEED_FUND_REQUESTED_PAISE: the amount of seed funding requested — the queue, the decision bound and the analytics all read it. Bind another question to this role before removing its holder.')
  })

  it('refuses two questions claiming the same role', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        {
          ...field(template, 'DATE_OF_BIRTH'), fieldKey: 'SECOND_BIRTHDAY',
          role: 'APPLICANT_DATE_OF_BIRTH' as const,
        },
      ],
    }))).toBe(
      "DATE_OF_BIRTH and SECOND_BIRTHDAY both claim to be the cycle's APPLICANT_DATE_OF_BIRTH.",
    )
  })

  it('refuses a pinned role on a question that is not the key it must be', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: template.fields.map((each) => each.fieldKey === 'SEED_FUND_REQUESTED_PAISE'
        ? { ...each, fieldKey: 'AMOUNT_WANTED' }
        : each),
    }))).toBe(
      "Only SEED_FUND_REQUESTED_PAISE may be the cycle's SEED_FUND_REQUESTED_PAISE, "
      + 'not AMOUNT_WANTED.',
    )
  })

  it('refuses a member declared in a different stage from its group', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNERS', stageKey: 'DOCUMENTS',
          fieldType: 'REPEAT_GROUP' as const, requirement: 'OPTIONAL' as const,
          role: null, repeatMin: 0, repeatMax: 3,
        },
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNER_NAME',
          stageKey: 'FINANCIAL', fieldType: 'TEXT' as const,
          requirement: 'OPTIONAL' as const, role: null, maxLength: 100,
          parentFieldKey: 'PARTNERS',
        },
      ],
    }))).toBe('PARTNER_NAME must be in the same stage as PARTNERS.')
  })

  /*
   * Two bounds that were reaching a constraint violation rather than a
   * sentence — and, until the `IS NOT NULL` terms were added to those
   * constraints, not even reaching one.
   */
  it('refuses a repeated group with no entry bounds', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        {
          ...field(template, 'NOC_REQUIRED'), fieldKey: 'PARTNERS',
          fieldType: 'REPEAT_GROUP' as const, requirement: 'OPTIONAL' as const,
          role: null, repeatMin: null, repeatMax: null,
        },
      ],
    }))).toBe('PARTNERS needs how few and how many entries it may have.')
  })

  /*
   * A document slot with no size of its own is legitimate — the programme's
   * own limit applies, and a cycle can only ask for something smaller. This is
   * here so the row is not quietly added later on the strength of the
   * constraint's shape.
   */
  it('accepts a document slot that states no size of its own', () => {
    expect(spoiled(replacing('DPR', (each) => ({ ...each, maxFileBytes: null })))).toBeNull()
  })

  it('refuses a date rule that is neither of the two', () => {
    expect(spoiled(replacing('DATE_OF_BIRTH', (each) => ({
      ...each, relativeDateBound: 'NOT_FUTUR' as never,
    })))).toBe(
      'DATE_OF_BIRTH has a date rule of NOT_FUTUR, which is neither NOT_FUTURE nor NOT_PAST.',
    )
  })

  it('refuses a repeated group inside a repeated group', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        { ...field(template, 'NOC_REQUIRED'), fieldKey: 'OUTER', fieldType: 'REPEAT_GROUP' as const,
          repeatMin: 0, repeatMax: 3, parentFieldKey: null },
        { ...field(template, 'NOC_REQUIRED'), fieldKey: 'INNER', fieldType: 'REPEAT_GROUP' as const,
          repeatMin: 0, repeatMax: 3, parentFieldKey: 'OUTER' },
      ],
    }))).toBe('INNER cannot sit inside a repeated group.')
  })

  /*
   * Money without a floor. The old typed columns carried a per-column CHECK
   * refusing a negative award; a template-declared amount has to recover that
   * guarantee by declaring one.
   */
  it('refuses an amount with no smallest permitted value', () => {
    expect(spoiled(replacing('SEED_FUND_REQUESTED_PAISE', (each) => ({ ...each, minValue: null }))))
      .toBe('SEED_FUND_REQUESTED_PAISE needs a smallest permitted amount.')
  })

  it('refuses a format rule longer than anybody should write', () => {
    expect(spoiled(replacing('GOVERNMENT_SCHEME_NAME', (each) => ({ ...each, pattern: `^${'a'.repeat(220)}$` }))))
      .toBe('The format rule on GOVERNMENT_SCHEME_NAME is too long.')
  })

  /*
   * A nested quantifier is how a pattern takes exponential time on input that
   * nearly matches — and the author is a programme officer, not somebody who
   * would recognise that.
   */
  it('refuses a format rule that could run away', () => {
    expect(spoiled(replacing('GOVERNMENT_SCHEME_NAME', (each) => ({ ...each, pattern: '^(a+)+$' }))))
      .toBe('The format rule on GOVERNMENT_SCHEME_NAME is too complex to run safely.')
  })

  it('refuses a format rule on a question with no length cap', () => {
    expect(spoiled(replacing('GOVERNMENT_SCHEME_NAME', (each) => ({
      ...each, pattern: '^[A-Z ]+$', maxLength: null,
    })))).toBe('GOVERNMENT_SCHEME_NAME needs a maximum length before it can have a format rule.')
  })

  it('refuses a format rule that is not an expression', () => {
    expect(spoiled(replacing('GOVERNMENT_SCHEME_NAME', (each) => ({
      ...each, pattern: '^[unclosed',
    })))).toBe('The format rule on GOVERNMENT_SCHEME_NAME is not a valid expression.')
  })

  it('refuses a choice on a question the cycle does not ask', () => {
    expect(spoiled((template) => ({
      ...template,
      options: [...template.options, {
        fieldKey: 'NO_SUCH_QUESTION', fieldType: 'SINGLE_CHOICE' as const,
        optionValue: 'ONE', optionLabel: 'One', sortOrder: 1,
      }],
    }))).toBe('A choice names a question this cycle does not ask.')
  })

  it('refuses a choice whose type disagrees with its question', () => {
    expect(spoiled((template) => ({
      ...template,
      options: template.options.map((option, index) =>
        index === 0 ? { ...option, fieldType: 'TEXT' as const } : option),
    }))).toContain('does not match that question')
  })

  it('refuses a rule on a question the cycle does not ask', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'NO_SUCH_QUESTION', effect: 'VISIBLE_WHEN' as const,
        groupNumber: 1, sequenceNumber: 1,
        sourceFieldKey: 'NOC_REQUIRED', sourceFieldType: 'BOOLEAN' as const,
        operator: 'EQUALS' as const, comparisonValue: 'true',
      }],
    }))).toBe('A rule names NO_SUCH_QUESTION, which this cycle does not ask.')
  })

  it('refuses a rule whose type disagrees with the question it reads', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: template.conditions.map((condition, index) =>
        index === 0 ? { ...condition, sourceFieldType: 'DATE' as const } : condition),
    }))).toContain('does not match the type of the question it reads')
  })

  it('refuses a question whose rule reads itself', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'NOC_REQUIRED', effect: 'VISIBLE_WHEN' as const,
        groupNumber: 1, sequenceNumber: 9,
        sourceFieldKey: 'NOC_REQUIRED', sourceFieldType: 'BOOLEAN' as const,
        operator: 'EQUALS' as const, comparisonValue: 'true',
      }],
    }))).toBe('NOC_REQUIRED cannot depend on itself.')
  })

  /*
   * A question marked conditional with nothing saying when is one nothing can
   * ever ask for — it is neither optional nor reachable.
   */
  it('refuses a conditional question with no rule saying when', () => {
    expect(spoiled(replacing('GENDER', (each) => ({ ...each, requirement: 'CONDITIONAL' as const }))))
      .toBe('GENDER is conditionally required but has no rule saying when.')
  })

  it('refuses questions that depend on each other in a circle', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [
        ...template.conditions,
        {
          fieldKey: 'GENDER', effect: 'VISIBLE_WHEN' as const,
          groupNumber: 1, sequenceNumber: 1,
          sourceFieldKey: 'DESIGNATION', sourceFieldType: 'SINGLE_CHOICE' as const,
          operator: 'EQUALS' as const, comparisonValue: 'PROPRIETOR',
        },
        {
          fieldKey: 'DESIGNATION', effect: 'VISIBLE_WHEN' as const,
          groupNumber: 1, sequenceNumber: 1,
          sourceFieldKey: 'GENDER', sourceFieldType: 'SINGLE_CHOICE' as const,
          operator: 'EQUALS' as const, comparisonValue: 'FEMALE',
        },
      ],
    }))).toBe('These questions depend on each other in a circle, so none of them could be shown.')
  })
})

/*
 * Presentation is refused with the same precision as validation, because the
 * engine and the renderer both treat an unrecognised token as "none" — a typo
 * would not fail, it would quietly switch the styling off.
 */
describe('what a cycle may not say about how questions are drawn', () => {
  it('refuses a placeholder on a question with no text box', () => {
    expect(spoiled(replacing('GENDER', (each) => ({ ...each, placeholder: 'Pick one' }))))
      .toBe('GENDER cannot have a placeholder: only a typed answer shows one.')
  })

  it('refuses a placeholder longer than 200 characters', () => {
    expect(spoiled(replacing('NAME', (each) => ({
      ...each, placeholder: 'x'.repeat(201),
    })))).toBe('The placeholder on NAME is longer than 200 characters.')
  })

  it('refuses a note longer than 500 characters', () => {
    expect(spoiled(replacing('NAME', (each) => ({
      ...each, note: 'x'.repeat(501),
    })))).toBe('The note on NAME is longer than 500 characters.')
  })

  it('refuses an unrecognised tone by name', () => {
    expect(spoiled(replacing('NAME', (each) => ({
      ...each, tone: 'LOUD' as never,
    })))).toBe('NAME has a tone of LOUD, which is not INFO, WARNING, SUCCESS or DANGER.')
  })

  it('refuses an unrecognised width by name', () => {
    expect(spoiled(replacing('NAME', (each) => ({
      ...each, widthHint: 'WIDE' as never,
    })))).toBe('NAME has a width of WIDE, which is not a recognised width.')
  })

  it('refuses an affix on a question that cannot carry one', () => {
    expect(spoiled(replacing('DATE_OF_BIRTH', (each) => ({
      ...each, prefixText: '₹',
    })))).toBe('DATE_OF_BIRTH cannot carry a prefix or suffix.')
  })

  it('refuses an affix longer than eight characters', () => {
    expect(spoiled(replacing('SEED_FUND_REQUESTED_PAISE', (each) => ({
      ...each, suffixText: 'per annum!',
    })))).toBe('The suffix on SEED_FUND_REQUESTED_PAISE must be 1 to 8 characters.')
  })

  it('refuses an unrecognised autofill token by name', () => {
    expect(spoiled(replacing('NAME', (each) => ({
      ...each, autocompleteHint: 'emial' as never,
    })))).toBe('NAME has an autofill hint of emial, which is not a recognised token.')
  })

  it('refuses a character count without a maximum length to count against', () => {
    expect(spoiled(replacing('NAME', (each) => ({
      ...each, maxLength: null, pattern: null, patternMessage: null, showCharCount: true,
    })))).toBe('NAME needs a maximum length before it can show a character count.')
  })

  it('refuses rows anywhere but a several-line text answer', () => {
    expect(spoiled(replacing('NAME', (each) => ({ ...each, textareaRows: 6 }))))
      .toBe('NAME can only set rows on a several-line text answer.')
  })

  it('refuses rows outside 2 to 20', () => {
    expect(spoiled(replacing('GOVERNMENT_SCHEME_NAME', (each) => ({
      ...each, fieldType: 'LONG_TEXT', textareaRows: 40,
    })))).toBe('The rows on GOVERNMENT_SCHEME_NAME must be between 2 and 20.')
  })

  it('refuses an autofill hint on a question with no input to fill', () => {
    expect(spoiled(replacing('NOC_REQUIRED', (each) => ({
      ...each, autocompleteHint: 'name',
    })))).toBe('NOC_REQUIRED cannot carry an autofill hint.')
  })

  it('refuses a character count on a question that is not text', () => {
    expect(spoiled(replacing('NOC_REQUIRED', (each) => ({
      ...each, showCharCount: true,
    })))).toBe('NOC_REQUIRED can only count characters on a text answer.')
  })

  it('refuses card styling on the options of a non-choice question', () => {
    expect(spoiled((template) => ({
      ...template,
      // A FILE question's options are content types; a card icon there means
      // nothing a renderer could draw.
      options: [...template.options, {
        fieldKey: 'DPR', fieldType: 'FILE' as const,
        optionValue: 'application/pdf', optionLabel: 'PDF',
        iconName: 'file-text',
      }],
    }))).toBe('Choices of DPR cannot carry card styling: it is not a choice question.')
  })

  it('refuses a choice style that does not fit the question, by name', () => {
    expect(spoiled(replacing('GENDER', (each) => ({
      ...each, choiceStyle: 'CHECKBOX_LIST' as never,
    })))).toBe('GENDER has a choice style of CHECKBOX_LIST, which does not fit SINGLE_CHOICE.')
  })

  it('refuses option card styling on a question that is not a choice', () => {
    expect(spoiled((template) => ({
      ...template,
      options: template.options.map((option, index) =>
        index === 0 ? { ...option, iconName: 'Not-An-Icon' } : option),
    }))).toBe(`The icon on a choice of ${defaultTemplate().options[0]!.fieldKey} is not a lowercase icon name.`)
  })

  it('refuses an option description longer than 200 characters', () => {
    expect(spoiled((template) => ({
      ...template,
      options: template.options.map((option, index) =>
        index === 0 ? { ...option, optionDescription: 'x'.repeat(201) } : option),
    }))).toBe(`The description on a choice of ${defaultTemplate().options[0]!.fieldKey} is longer than 200 characters.`)
  })

  it('refuses a stage icon that is not a lowercase icon name', () => {
    expect(spoiled((template) => ({
      ...template,
      stages: template.stages.map((stage, index) =>
        index === 0 ? { ...stage, iconName: 'Building2' } : stage),
    }))).toBe(`The icon on ${defaultTemplate().stages[0]!.stageKey} is not a lowercase icon name.`)
  })

  it('refuses an estimated time outside 1 to 120 minutes', () => {
    expect(spoiled((template) => ({
      ...template,
      stages: template.stages.map((stage, index) =>
        index === 0 ? { ...stage, estimatedMinutes: 0 } : stage),
    }))).toBe(`The estimated minutes on ${defaultTemplate().stages[0]!.stageKey} must be between 1 and 120.`)
  })

  it('refuses a stage introduction longer than 500 characters', () => {
    expect(spoiled((template) => ({
      ...template,
      stages: template.stages.map((stage, index) =>
        index === 0 ? { ...stage, description: 'x'.repeat(501) } : stage),
    }))).toBe(`The introduction to ${defaultTemplate().stages[0]!.stageKey} is longer than 500 characters.`)
  })
})

describe('what a cycle may not say about a statement', () => {
  const statement = (
    override: Partial<FormTemplateInput['fields'][number]>,
  ) => (template: FormTemplateInput): FormTemplateInput => ({
    ...template,
    fields: [...template.fields, {
      stageKey: template.stages[0]!.stageKey,
      fieldKey: 'A_STATEMENT',
      fieldType: 'STATEMENT',
      label: 'Read this before you continue.',
      requirement: 'OPTIONAL',
      ...override,
    }],
  })

  it('accepts a plain statement', () => {
    expect(spoiled(statement({}))).toBeNull()
  })

  it('refuses a required statement', () => {
    expect(spoiled(statement({ requirement: 'REQUIRED' })))
      .toBe('A_STATEMENT is a statement: nothing can be required of it.')
  })

  it('refuses a statement inside a repeated group', () => {
    // The group does not exist either, but membership is refused first — the
    // statement rule is about the type, not the target.
    expect(spoiled(statement({ requirement: 'REQUIRED', parentFieldKey: 'NOWHERE' })))
      .not.toBeNull()
  })

  it('refuses a condition reading a statement', () => {
    expect(spoiled((template) => ({
      ...statement({})(template),
      conditions: [...template.conditions, {
        fieldKey: 'NOC_REQUIRED',
        effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'A_STATEMENT',
        sourceFieldType: 'STATEMENT',
        operator: 'IS_PRESENT',
      }],
    }))).toBe(
      'NOC_REQUIRED has a rule that reads A_STATEMENT, which is a statement and has no answer.',
    )
  })
})

/* Branch mop-up: the halves of guards the main cases leave untouched. */
describe('the guard halves', () => {
  it('refuses a server-derived member of a group', () => {
    expect(spoiled(replacing('NAME', (each) => ({ ...each, source: 'SERVER_DERIVED' }))))
      .toBe('NAME cannot sit inside a repeated group.')
  })

  it('refuses a group stating only one of its two bounds', () => {
    expect(spoiled(replacing('OWNERS', (each) => ({ ...each, repeatMax: null }))))
      .toBe('OWNERS needs how few and how many entries it may have.')
  })

  it('refuses rows below two', () => {
    expect(spoiled(replacing('GOVERNMENT_SCHEME_NAME', (each) => ({
      ...each, fieldType: 'LONG_TEXT', textareaRows: 1,
    })))).toBe('The rows on GOVERNMENT_SCHEME_NAME must be between 2 and 20.')
  })

  it('refuses a choice style on a question that offers no choices at all', () => {
    expect(spoiled(replacing('NOC_REQUIRED', (each) => ({
      ...each, choiceStyle: 'RADIO' as never,
    })))).toBe('NOC_REQUIRED has a choice style of RADIO, which does not fit BOOLEAN.')
  })

  it('refuses a single-choice style on a multiple choice', () => {
    expect(spoiled(replacing('GENDER', (each) => ({
      ...each, fieldType: 'MULTI_CHOICE', choiceStyle: 'RADIO' as never,
    })))).toBe('GENDER has a choice style of RADIO, which does not fit MULTI_CHOICE.')
  })

  it('accepts a multiple choice with a fitting style', () => {
    expect(spoiled((template) => ({
      ...replacing('GENDER', (each) => ({
        ...each, fieldType: 'MULTI_CHOICE' as const, choiceStyle: 'CHECKBOX_LIST' as never,
      }))(template),
      // The options follow their question's type; the denormalised pair is
      // exactly what the option check compares.
      options: template.options.map((option) => option.fieldKey === 'GENDER'
        ? { ...option, fieldType: 'MULTI_CHOICE' as const }
        : option),
    }))).toBeNull()
  })
})

describe('the whole-form ceilings', () => {
  it('refuses more than twenty stages', () => {
    expect(spoiled((template) => ({
      ...template,
      stages: [
        ...template.stages,
        ...Array.from({ length: 21 - template.stages.length }, (_, index) => ({
          stageKey: `EXTRA_${index}`, title: `Extra ${index}`,
        })),
      ],
    }))).toBe('A cycle may ask at most 20 stages of questions.')
  })

  it('refuses more than two hundred questions', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [
        ...template.fields,
        ...Array.from({ length: 201 - template.fields.length }, (_, index) => ({
          stageKey: 'DOCUMENTS', fieldKey: `EXTRA_${index}`,
          fieldType: 'BOOLEAN' as const, label: `Extra ${index}`,
          requirement: 'OPTIONAL' as const,
        })),
      ],
    }))).toBe('A cycle may ask at most 200 questions.')
  })

  it('refuses a group allowing more than twenty entries, in words', () => {
    // The schema CHECK holds the line too; this is the sentence that reaches
    // the officer instead of "the record changed".
    expect(spoiled(replacing('OWNERS', (each) => ({ ...each, repeatMax: 21 }))))
      .toBe('OWNERS may allow at most 20 entries.')
  })
})

/*
 * Review findings, pinned. Each of these passed the validator and then either
 * corrupted silently (empty group) or died on a database CHECK as "the record
 * changed" — the exact failure mode this module exists to prevent.
 */
describe('what the review found the validator missing', () => {
  it('refuses a repeated group with no members at all', () => {
    expect(spoiled((template) => ({
      ...template,
      fields: [...template.fields, {
        stageKey: 'DOCUMENTS', fieldKey: 'EMPTY_GROUP', fieldType: 'REPEAT_GROUP',
        label: 'Nothing inside', requirement: 'OPTIONAL', repeatMin: 0, repeatMax: 3,
      }],
    }))).toBe('EMPTY_GROUP has no questions inside it.')
  })

  it('refuses a document inside a repeated group', () => {
    expect(spoiled(replacing('NAME', (each) => ({ ...each, fieldType: 'FILE', maxLength: null }))))
      .toBe('NAME cannot sit inside a repeated group.')
  })

  it('refuses the date-of-birth role on a question that is not a date', () => {
    expect(spoiled(replacing('DATE_OF_BIRTH', (each) => ({
      ...each, fieldType: 'TEXT', relativeDateBound: null, maxLength: 20,
    })))).toBe('DATE_OF_BIRTH plays APPLICANT_DATE_OF_BIRTH and must be a DATE question.')
  })

  it('refuses a condition on a role-bound member', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'DATE_OF_BIRTH', effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'GENDER', sourceFieldType: 'SINGLE_CHOICE',
        operator: 'EQUALS', comparisonValue: 'OTHER',
      }],
    }))).toBe(
      'DATE_OF_BIRTH plays a role the programme reads from every entry: it cannot be conditional.',
    )
  })

  it('refuses inverted or misplaced length bounds in words', () => {
    expect(spoiled(replacing('NAME', (each) => ({ ...each, minLength: 50, maxLength: 10 }))))
      .toBe('NAME has a smallest length above its largest.')
    expect(spoiled(replacing('DATE_OF_BIRTH', (each) => ({ ...each, maxLength: 10 }))))
      .toBe('DATE_OF_BIRTH cannot carry length bounds.')
  })

  it('refuses inverted numeric and date bounds, and misplaced ones', () => {
    expect(spoiled(replacing('GOVERNMENT_FUNDING_SANCTION_YEAR', (each) => ({
      ...each, minValue: 2000, maxValue: 1900,
    })))).toBe('GOVERNMENT_FUNDING_SANCTION_YEAR has a smallest value above its largest.')
    expect(spoiled(replacing('NAME', (each) => ({ ...each, minValue: 1 }))))
      .toBe('NAME cannot carry numeric bounds.')
    expect(spoiled(replacing('DATE_OF_BIRTH', (each) => ({
      ...each, minDate: '2020-01-01', maxDate: '2010-01-01',
    })))).toBe('DATE_OF_BIRTH has an earliest day after its latest.')
    expect(spoiled(replacing('NAME', (each) => ({ ...each, minDate: '2020-01-01' }))))
      .toBe('NAME cannot carry date bounds.')
  })

  it('refuses a negative amount floor and a zero-entry ceiling', () => {
    expect(spoiled(replacing('SEED_FUND_REQUESTED_PAISE', (each) => ({
      ...each, minValue: -1,
    })))).toBe('SEED_FUND_REQUESTED_PAISE cannot have a negative smallest amount.')
    expect(spoiled(replacing('OWNERS', (each) => ({ ...each, repeatMin: 0, repeatMax: 0 }))))
      .toBe('OWNERS must allow at least one entry.')
  })

  it('refuses file-size limits anywhere but a document, and out of range', () => {
    expect(spoiled(replacing('NAME', (each) => ({ ...each, maxFileBytes: 1000 }))))
      .toBe('NAME is not a document and cannot limit an upload size.')
    expect(spoiled(replacing('DPR', (each) => ({ ...each, maxFileBytes: 99_000_000 }))))
      .toBe('The upload limit on DPR must be between 1 byte and 5 MB.')
  })

  it('refuses a format message with no format rule', () => {
    expect(spoiled(replacing('NAME', (each) => ({
      ...each, patternMessage: 'Wrong shape.',
    })))).toBe('NAME has a format message but no format rule.')
  })

  it('refuses a choice value that is not a key, and a file type that is not one', () => {
    expect(spoiled((template) => ({
      ...template,
      options: template.options.map((option, index) =>
        index === 0 ? { ...option, optionValue: 'not a key' } : option),
    }))).toContain('is not a valid choice value')
  })

  it('refuses a comparison that contradicts its operator', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'GOVERNMENT_SCHEME_NAME', effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'NOC_REQUIRED', sourceFieldType: 'BOOLEAN',
        operator: 'EQUALS', comparisonValue: null,
      }],
    }))).toBe('A rule on GOVERNMENT_SCHEME_NAME compares with EQUALS but gives no value.')
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'GOVERNMENT_SCHEME_NAME', effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'NOC_REQUIRED', sourceFieldType: 'BOOLEAN',
        operator: 'IS_PRESENT', comparisonValue: 'true',
      }],
    }))).toBe('A rule on GOVERNMENT_SCHEME_NAME asks IS_PRESENT and needs no value.')
  })

  it('refuses ordering a source that has no order', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'GOVERNMENT_SCHEME_NAME', effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'GOVERNMENT_SCHEME_NAME', sourceFieldType: 'TEXT',
        operator: 'GREATER_THAN', comparisonValue: 'x',
      },
      ],
    }))).not.toBeNull()
  })
})

/* The half-branches of the new bound mirrors, each hit once. */
describe('the bound-mirror halves', () => {
  it('refuses negative and sub-one lengths', () => {
    expect(spoiled(replacing('NAME', (each) => ({ ...each, minLength: -1 }))))
      .toBe('NAME cannot have a negative smallest length.')
    expect(spoiled(replacing('NAME', (each) => ({ ...each, maxLength: 0 }))))
      .toBe('NAME cannot have a largest length below one.')
  })

  it('refuses a format rule anywhere but a text answer', () => {
    expect(spoiled(replacing('GOVERNMENT_FUNDING_SANCTION_YEAR', (each) => ({
      ...each, pattern: '^\\d{4}$', maxLength: null,
    })))).toBe('GOVERNMENT_FUNDING_SANCTION_YEAR cannot carry a format rule.')
  })

  it('refuses entry bounds on a question that is not a group', () => {
    expect(spoiled(replacing('NAME', (each) => ({ ...each, repeatMin: 1, repeatMax: 3 }))))
      .toBe('NAME is not a repeated group and cannot carry entry bounds.')
  })

  it('refuses a group whose smallest is negative', () => {
    expect(spoiled(replacing('OWNERS', (each) => ({ ...each, repeatMin: -1, repeatMax: 3 }))))
      .toBe('OWNERS must allow at least one entry.')
  })
})

describe('the option and rule mirror halves', () => {
  it('refuses a FILE option that is not a content type', () => {
    expect(spoiled(replacing('DPR', (each) => each))).toBeNull()
    expect(spoiled((template) => ({
      ...template,
      options: [...template.options, {
        fieldKey: 'DPR', fieldType: 'FILE' as const,
        optionValue: 'NOT A MIME', optionLabel: 'Bad',
      }],
    }))).toBe('NOT A MIME on DPR is not a content type.')
  })

  it('refuses ordering a source with no order, by name', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'GOVERNMENT_SCHEME_NAME', effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'EXISTING_CREDIT_STATUS', sourceFieldType: 'SINGLE_CHOICE',
        operator: 'GREATER_THAN', comparisonValue: 'X',
      }],
    }))).toBe(
      'A rule on GOVERNMENT_SCHEME_NAME orders EXISTING_CREDIT_STATUS, which has no order.',
    )
  })

  it('lets a file be read only for presence', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'GOVERNMENT_SCHEME_NAME', effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'DPR', sourceFieldType: 'FILE',
        operator: 'EQUALS', comparisonValue: 'x',
      }],
    }))).toBe(
      'A rule on GOVERNMENT_SCHEME_NAME can only ask whether DPR is attached.',
    )
  })

  it('refuses a rule numbered below one', () => {
    expect(spoiled((template) => ({
      ...template,
      conditions: [...template.conditions, {
        fieldKey: 'GOVERNMENT_SCHEME_NAME', effect: 'VISIBLE_WHEN',
        sourceFieldKey: 'NOC_REQUIRED', sourceFieldType: 'BOOLEAN',
        operator: 'IS_PRESENT', comparisonValue: null, groupNumber: 0,
      }],
    }))).toBe('A rule on GOVERNMENT_SCHEME_NAME numbers its group below one.')
  })

  it('refuses the money role on a question that is not an amount', () => {
    expect(spoiled(replacing('SEED_FUND_REQUESTED_PAISE', (each) => ({
      ...each, fieldType: 'INTEGER',
    })))).toBe(
      'SEED_FUND_REQUESTED_PAISE plays SEED_FUND_REQUESTED_PAISE and must be a '
      + 'MONEY_PAISE question.',
    )
  })
})
