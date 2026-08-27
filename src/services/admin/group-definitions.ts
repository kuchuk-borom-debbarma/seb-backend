/**
 * Reusable structures, expanded into the flat form model at authoring time.
 *
 * A cycle defines a structure once — "an Owner is a name, a date of birth, a
 * share" — and any repeated group can use it by name. Expansion materialises
 * each member as an ordinary field row under a **qualified key**,
 * `USE__MEMBER`, placed directly after its use, so everything downstream (the
 * engine, answer storage, issue paths, the renderer, the parity suites) sees
 * the flat model it already proves. The definition stays the authoritative,
 * editable thing; the derived rows are stripped again on the authoring read.
 *
 * Pure by design: a template in, a template or one refusal sentence out. The
 * guards live here rather than in `formTemplateProblem` because they are about
 * the structure grammar — everything about the *expanded* questions is checked
 * by the ordinary passes on the expanded result, including the answer byte
 * budget, which counts every member once per permitted entry.
 */
import type { FormTemplateInput } from './types'
import { TEMPLATE_KEY_PATTERN } from '../../db/schema/seb/form-template'

const KEY = new RegExp(TEMPLATE_KEY_PATTERN, 'u')

/* Hard ceilings, stated once. Each exists to bound what one cycle version can
   make an applicant answer and an officer review. */
const MAX_DEFINITIONS = 16
const MAX_MEMBERS = 24
/* `^[A-Z][A-Z0-9_]{1,63}$` — one leading character plus at most 63 more. */
const MAX_KEY_LENGTH = 64

type Definition = NonNullable<FormTemplateInput['groupDefinitions']>[number]

const definitionProblem = (definitions: readonly Definition[]): string | null => {
  if (definitions.length > MAX_DEFINITIONS) {
    return `A cycle may define at most ${MAX_DEFINITIONS} reusable structures.`
  }
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (!KEY.test(definition.definitionKey)) {
      return `The structure key ${definition.definitionKey} is not a valid key.`
    }
    if (seen.has(definition.definitionKey)) {
      return `This cycle already defines a structure called ${definition.definitionKey}.`
    }
    seen.add(definition.definitionKey)
    if (!definition.label.trim()) {
      return `The structure ${definition.definitionKey} needs a name.`
    }
    if (definition.members.length === 0) {
      return `The structure ${definition.definitionKey} needs at least one member.`
    }
    if (definition.members.length > MAX_MEMBERS) {
      return `The structure ${definition.definitionKey} may have at most ${MAX_MEMBERS} members.`
    }
    const membersFault = membersProblem(definition)
    if (membersFault) return membersFault
  }
  return null
}

const membersProblem = (definition: Definition): string | null => {
  const memberKeys = new Set<string>()
  for (const member of definition.members) {
    if (!KEY.test(member.memberKey)) {
      return `The member key ${member.memberKey} is not a valid key.`
    }
    if (memberKeys.has(member.memberKey)) {
      return `${definition.definitionKey} already has a member called ${member.memberKey}.`
    }
    memberKeys.add(member.memberKey)
    /*
     * A group inside a group is the nesting the whole model refuses; a
     * document has its own versioned row and cannot repeat per entry; a
     * statement repeated per entry is the same prose n times. The member
     * table's CHECK refuses these too — this is the sentence.
     */
    if (
      member.fieldType === 'REPEAT_GROUP'
      || member.fieldType === 'FILE'
      || member.fieldType === 'STATEMENT'
    ) {
      return `A member of ${definition.definitionKey} cannot be a repeated group, `
        + 'a document, or a statement.'
    }
    /*
     * The role rules, checked here even for a definition nothing uses yet:
     * expansion only validates used definitions, and the member table's own
     * CHECK would turn an unused-but-invalid one into an internal error
     * instead of a sentence.
     */
    if (member.role != null && member.role !== 'APPLICANT_DATE_OF_BIRTH') {
      return `A member of ${definition.definitionKey} can only play APPLICANT_DATE_OF_BIRTH.`
    }
    if (member.role === 'APPLICANT_DATE_OF_BIRTH' && member.fieldType !== 'DATE') {
      return `${member.memberKey} plays APPLICANT_DATE_OF_BIRTH and must be a DATE member.`
    }
  }
  return null
}

const structureUseProblem = (
  template: FormTemplateInput,
  uses: readonly FormTemplateInput['fields'][number][],
  byKey: ReadonlyMap<string, Definition>,
): string | null => {
  for (const use of uses) {
    if (use.fieldType !== 'REPEAT_GROUP') {
      return `Only a repeated group can use a structure, and ${use.fieldKey} is not one.`
    }
    if (!byKey.has(use.groupDefinitionKey!)) {
      return `${use.fieldKey} uses a structure called ${use.groupDefinitionKey}, `
        + 'which this cycle does not define.'
    }
    // Its members come from the definition and nowhere else: a hand-declared
    // extra would drift from the structure the next edit re-expands.
    if (template.fields.some((field) => field.parentFieldKey === use.fieldKey)) {
      return `${use.fieldKey} uses a structure and cannot declare members of its own.`
    }
  }
  /*
   * Rules on derived keys are refused rather than carried, in this version. A
   * condition among members would need the definition to say it — otherwise
   * the next re-expansion silently drops it — and the definition cannot yet.
   */
  for (const condition of template.conditions) {
    for (const use of uses) {
      const prefix = `${use.fieldKey}__`
      if (condition.fieldKey.startsWith(prefix) || condition.sourceFieldKey.startsWith(prefix)) {
        const named = condition.fieldKey.startsWith(prefix)
          ? condition.fieldKey
          : condition.sourceFieldKey
        return `${named} belongs to a structure: rules on structure members are not supported yet.`
      }
    }
  }
  return null
}

/**
 * Expands every structure use, or names the first fault.
 *
 * A template with no definitions and no uses is returned untouched — the
 * common path costs nothing.
 */
export const expandGroupDefinitions = (
  template: FormTemplateInput,
): FormTemplateInput | string => {
  const definitions = template.groupDefinitions ?? []
  const uses = template.fields.filter((field) => field.groupDefinitionKey)
  if (definitions.length === 0 && uses.length === 0) return template

  const problem = definitionProblem(definitions)
  if (problem) return problem

  const byKey = new Map(definitions.map((each) => [each.definitionKey, each]))
  const existingKeys = new Set(template.fields.map((field) => field.fieldKey))

  const useFault = structureUseProblem(template, uses, byKey)
  if (useFault) return useFault

  const fields: FormTemplateInput['fields'] = []
  const options = [...template.options]
  for (const field of template.fields) {
    fields.push(field)
    if (!field.groupDefinitionKey) continue
    const definition = byKey.get(field.groupDefinitionKey)!
    for (const member of definition.members) {
      const qualified = `${field.fieldKey}__${member.memberKey}`
      if (qualified.length > MAX_KEY_LENGTH) {
        return `Expanding ${field.fieldKey} makes the key ${qualified}, `
          + 'which is longer than a key may be.'
      }
      if (existingKeys.has(qualified)) {
        return `Expanding ${field.fieldKey} collides with a question called ${qualified}.`
      }
      existingKeys.add(qualified)
      const { memberKey: _memberKey, options: memberOptions, ...shape } = member
      fields.push({
        ...shape,
        fieldKey: qualified,
        stageKey: field.stageKey,
        parentFieldKey: field.fieldKey,
      })
      for (const option of memberOptions ?? []) {
        options.push({
          ...option,
          fieldKey: qualified,
          fieldType: member.fieldType,
        })
      }
    }
  }

  return { ...template, fields, options }
}
