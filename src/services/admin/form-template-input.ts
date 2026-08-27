/**
 * Refusing an incoherent form before a cycle can carry one.
 *
 * The schema refuses most of this again, and `resolveFormTemplate` refuses it a
 * third time when the rows are read back. That redundancy is the point: a
 * constraint violation arrives at an administrator as *"the record changed"*,
 * which says nothing about which question to fix. These checks exist to make
 * the refusal **useful**; the constraints exist to make the outcome **correct**.
 *
 * Three of these rules cannot be a `CHECK` at all, because they are cross-row:
 * a conditional field needs at least one rule making it required, the
 * visibility graph must be acyclic, and a condition must name a field the
 * template actually declares. A cyclic template renders nothing and can never
 * be repaired from the applicant's side, so it must never be written.
 */
import type { FormTemplateInput } from './types'
import {
  formFieldAutocompleteHints,
  formFieldRoles,
  formFieldWidths,
  ICON_NAME_PATTERN,
  ROLE_CANONICAL_KEY,
  TEMPLATE_KEY_PATTERN,
} from '../../db/schema/seb/form-template'
import { MAX_ANSWER_BYTES } from '../application/form/engine'

const KEY = new RegExp(TEMPLATE_KEY_PATTERN, 'u')

/** The longest expression a cycle may declare; see `form/template.ts`. */
const MAX_PATTERN_LENGTH = 200
const ICON = new RegExp(ICON_NAME_PATTERN, 'u')
/* Which field types have a control the affordance can attach to. Mirrors the
   schema CHECKs; the sentence arrives before the constraint would. */
const PLACEHOLDER_TYPES = new Set(
  ['TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER', 'MONEY_PAISE'])
const AFFIX_TYPES = new Set(['TEXT', 'INTEGER', 'MONEY_PAISE'])
const AUTOCOMPLETE_TYPES = new Set(['TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER'])
const SINGLE_CHOICE_STYLES = new Set(['RADIO', 'DROPDOWN', 'SEGMENTED', 'CARD'])
const MULTI_CHOICE_STYLES = new Set(['CHECKBOX_LIST', 'MULTISELECT'])

/**
 * Nested quantifiers, the shape that makes a regular expression catastrophic.
 *
 * Heuristic and deliberately so — a complete answer needs an automaton, and
 * this is one of four layers rather than the only one. The others are the
 * length cap here, the mandatory `maxLength` on any patterned field, and the
 * anchoring done at resolve time.
 */
const NESTED_QUANTIFIER = /(\([^)]*[+*][^)]*\)|\[[^\]]*\][{+*])\s*[{+*]/u

/**
 * The steps themselves: at least one, each with a usable key and a heading.
 */
const stageProblem = (template: FormTemplateInput): string | null => {
  if (template.stages.length === 0) {
    return 'A cycle must ask at least one stage of questions.'
  }
  /*
   * Hard ceilings, counted after structures expand. They bound what one cycle
   * can make an applicant answer and an officer review — and the byte budget
   * alone would not catch a form of two hundred tiny questions.
   */
  if (template.stages.length > 20) {
    return 'A cycle may ask at most 20 stages of questions.'
  }
  if (template.fields.length > 200) {
    return 'A cycle may ask at most 200 questions.'
  }
  for (const stage of template.stages) {
    if (!KEY.test(stage.stageKey)) {
      return `The stage key ${stage.stageKey} is not a valid key.`
    }
    if (!stage.title.trim()) return 'Every stage needs a heading.'
    if ((stage.description ?? '').length > 500) {
      return `The introduction to ${stage.stageKey} is longer than 500 characters.`
    }
    if (stage.iconName != null && !ICON.test(stage.iconName)) {
      return `The icon on ${stage.stageKey} is not a lowercase icon name.`
    }
    const minutes = stage.estimatedMinutes ?? null
    if (minutes !== null && (minutes < 1 || minutes > 120)) {
      return `The estimated minutes on ${stage.stageKey} must be between 1 and 120.`
    }
  }
  return null
}

/* Where a question may sit: its stage, and — for a member — its group. */
const membershipProblem = (
  field: FormTemplateInput['fields'][number],
  fieldsByKey: Map<string, FormTemplateInput['fields'][number]>,
): string | null => {
  if (field.parentFieldKey) {
  const parent = fieldsByKey.get(field.parentFieldKey)
  if (!parent || parent.fieldType !== 'REPEAT_GROUP') {
    return `${field.fieldKey} names a repeated group this cycle does not have.`
  }
  // Both are only ever read at the top level, so one inside a group means
  // something other than it says — see the schema's own CHECK. The date of
  // birth is the carve-out: the age rule walks the group's entries for it.
  if (field.source === 'SERVER_DERIVED'
    || (field.role && field.role !== 'APPLICANT_DATE_OF_BIRTH')) {
    return `${field.fieldKey} cannot sit inside a repeated group.`
  }
  /*
   * Groups do not nest. An answer inside a nested group would need two
   * indices to address, and the issue path a client puts on a control's
   * `id` carries one — so the applicant would be sent to a control that
   * cannot be identified.
   *
   * `seb_programme_cycle_form_field_nesting_check` already refuses this,
   * and that was the only thing refusing it: a CHECK violation is not a
   * lost race, so `constraintSafe` deliberately does not catch it and the
   * officer got an unhandled error instead of a sentence.
   */
  if (field.fieldType === 'REPEAT_GROUP') {
    return `${field.fieldKey} cannot sit inside a repeated group.`
  }
  // A document has its own versioned row and cannot repeat per entry; a
  // statement repeated per entry is the same prose n times. The definition
  // path already refuses both; a hand-authored member gets the same sentence.
  if (field.fieldType === 'FILE' || field.fieldType === 'STATEMENT') {
    return `${field.fieldKey} cannot sit inside a repeated group.`
  }
  /*
   * A member is in its group's stage, because a group is drawn as a set of
   * entry cards *inside* one stage — a member elsewhere names a place the
   * renderer has nowhere to put it.
   *
   * It also makes the change summary correct by construction. `changedStageKeys`
   * compares a group as a whole and attributes the difference to the
   * group's stage, so a member declared in another stage would have its
   * edits reported against a stage it does not belong to — and under
   * revision, whether a change is in the reopened scope is decided by
   * exactly that list.
   */
  if (field.stageKey !== parent.stageKey) {
    return `${field.fieldKey} must be in the same stage as ${field.parentFieldKey}.`
  }
}
  return null
}

type FieldInput = FormTemplateInput['fields'][number]

const lengthBoundsProblem = (field: FieldInput): string | null => {
  const lengthTypes = ['TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'MULTI_CHOICE']
  const minLength = field.minLength ?? null
  const maxLength = field.maxLength ?? null
  if ((minLength !== null || maxLength !== null) && !lengthTypes.includes(field.fieldType)) {
    return `${field.fieldKey} cannot carry length bounds.`
  }
  if (minLength !== null && minLength < 0) {
    return `${field.fieldKey} cannot have a negative smallest length.`
  }
  if (maxLength !== null && maxLength < 1) {
    return `${field.fieldKey} cannot have a largest length below one.`
  }
  if (minLength !== null && maxLength !== null && minLength > maxLength) {
    return `${field.fieldKey} has a smallest length above its largest.`
  }
  return null
}

const numericBoundsProblem = (field: FieldInput): string | null => {
  const numericTypes = ['INTEGER', 'MONEY_PAISE']
  const minValue = field.minValue ?? null
  const maxValue = field.maxValue ?? null
  if ((minValue !== null || maxValue !== null) && !numericTypes.includes(field.fieldType)) {
    return `${field.fieldKey} cannot carry numeric bounds.`
  }
  if (field.fieldType === 'MONEY_PAISE' && minValue !== null && minValue < 0) {
    return `${field.fieldKey} cannot have a negative smallest amount.`
  }
  if (minValue !== null && maxValue !== null && maxValue < minValue) {
    return `${field.fieldKey} has a smallest value above its largest.`
  }
  return null
}

const dateBoundsProblem = (field: FieldInput): string | null => {
  const minDate = field.minDate ?? null
  const maxDate = field.maxDate ?? null
  if (
    (minDate !== null || maxDate !== null || field.relativeDateBound)
    && field.fieldType !== 'DATE'
  ) {
    return `${field.fieldKey} cannot carry date bounds.`
  }
  if (minDate !== null && maxDate !== null && minDate > maxDate) {
    return `${field.fieldKey} has an earliest day after its latest.`
  }
  return null
}

const fileBoundsProblem = (field: FieldInput): string | null => {
  const maxFileBytes = field.maxFileBytes ?? null
  if (maxFileBytes !== null && field.fieldType !== 'FILE') {
    return `${field.fieldKey} is not a document and cannot limit an upload size.`
  }
  if (maxFileBytes !== null && (maxFileBytes < 1 || maxFileBytes > 5_242_880)) {
    return `The upload limit on ${field.fieldKey} must be between 1 byte and 5 MB.`
  }
  return null
}

const patternShapeProblem = (field: FieldInput): string | null => {
  if ((field.patternMessage ?? null) !== null && (field.pattern ?? null) === null) {
    return `${field.fieldKey} has a format message but no format rule.`
  }
  if ((field.pattern ?? null) !== null
    && !['TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE'].includes(field.fieldType)) {
    return `${field.fieldKey} cannot carry a format rule.`
  }
  return null
}

/*
 * Two bounds the database refuses and this did not — both were reaching
 * the constraint rather than a sentence, and both constraints were
 * themselves accepting the row until their `IS NOT NULL` terms were added.
 *
 * A repeated group must state both. The schema's own ceiling of twenty
 * entries exists to bound what an applicant can be asked to submit, and an
 * absent bound defeats it: `rules.ts` reads a null maximum as "no maximum",
 * so the cycle would be published with a group nothing limits.
 */
const repeatBoundsProblem = (field: FieldInput): string | null => {
  if (field.fieldType !== 'REPEAT_GROUP') {
    if ((field.repeatMin ?? null) !== null || (field.repeatMax ?? null) !== null) {
      return `${field.fieldKey} is not a repeated group and cannot carry entry bounds.`
    }
    return null
  }
  if ((field.repeatMin ?? null) === null || (field.repeatMax ?? null) === null) {
    return `${field.fieldKey} needs how few and how many entries it may have.`
  }
  // The schema CHECK holds this line too; the sentence is what the officer
  // sees instead of "the record changed".
  if ((field.repeatMax ?? 0) > 20) {
    return `${field.fieldKey} may allow at most 20 entries.`
  }
  if ((field.repeatMin ?? 0) < 0
    || (field.repeatMax ?? 0) < Math.max(field.repeatMin ?? 0, 1)) {
    return `${field.fieldKey} must allow at least one entry.`
  }
  return null
}

/* The shape of a question's own bounds, refused before the database would. */
const ruleShapeProblem = (
  field: FormTemplateInput['fields'][number],
): string | null => {
  if (field.fieldType === 'MONEY_PAISE' && (field.minValue ?? null) === null) {
  return `${field.fieldKey} needs a smallest permitted amount.`
}
/*
 * The typed-bound matrix, mirrored from the schema CHECKs. Every branch
 * exists because the constraint refuses the row anyway — a CHECK violation is
 * not a lost race, so `constraintSafe` rethrows it and the officer would see
 * an internal error instead of which bound to fix. One helper per bound
 * family, each a straight chain of sentences.
 */
{
  const bounds = lengthBoundsProblem(field)
    ?? numericBoundsProblem(field)
    ?? dateBoundsProblem(field)
    ?? fileBoundsProblem(field)
    ?? patternShapeProblem(field)
  if (bounds) return bounds
}
{
  const repeat = repeatBoundsProblem(field)
  if (repeat) return repeat
}
if (field.relativeDateBound
  && field.relativeDateBound !== 'NOT_FUTURE' && field.relativeDateBound !== 'NOT_PAST') {
  /*
   * Named rather than described, because the engine reads an unrecognised
   * bound as *no* bound: a typo here does not fail, it quietly switches the
   * rule off, and the officer would never learn which of the two they meant.
   */
  return `${field.fieldKey} has a date rule of ${field.relativeDateBound}, `
    + 'which is neither NOT_FUTURE nor NOT_PAST.'
}
if (field.fieldType === 'STATEMENT' && field.requirement !== 'OPTIONAL') {
  // There is nothing to give: a statement is read, not answered.
  return `${field.fieldKey} is a statement: nothing can be required of it.`
}
  return null
}

/** Each question on its own: where it sits, what it says, what it bounds. */
const fieldProblem = (
  template: FormTemplateInput,
  fieldsByKey: Map<string, FormTemplateInput['fields'][number]>,
): string | null => {
  const stageKeys = new Set(template.stages.map((stage) => stage.stageKey))
for (const field of template.fields) {
  if (!KEY.test(field.fieldKey)) {
    return `The question key ${field.fieldKey} is not a valid key.`
  }
  if (!stageKeys.has(field.stageKey)) {
    return `${field.fieldKey} names a stage this cycle does not have.`
  }
  if (!field.label.trim()) return `${field.fieldKey} needs a label.`

  const membership = membershipProblem(field, fieldsByKey)
  if (membership) return membership
  const shape = ruleShapeProblem(field)
  if (shape) return shape
  const problem = presentationProblem(field)
  if (problem) return problem
  if (field.pattern) {
    if (field.pattern.length > MAX_PATTERN_LENGTH) {
      return `The format rule on ${field.fieldKey} is too long.`
    }
    if (NESTED_QUANTIFIER.test(field.pattern)) {
      return `The format rule on ${field.fieldKey} is too complex to run safely.`
    }
    // Bounded input is what makes running an authored expression safe at all.
    if ((field.maxLength ?? null) === null) {
      return `${field.fieldKey} needs a maximum length before it can have a format rule.`
    }
    try {
      new RegExp(field.pattern, 'u')
    } catch {
      return `The format rule on ${field.fieldKey} is not a valid expression.`
    }
  }
}
  return null
}

/*
 * The drawing instructions, refused with the same precision as the rules.
 * The renderer treats an unrecognised token as "none", so a typo here would
 * not fail — it would quietly switch the styling off, and nothing would say so.
 */
const presentationProblem = (
  field: FormTemplateInput['fields'][number],
): string | null => {
  if (field.placeholder != null) {
    if (!PLACEHOLDER_TYPES.has(field.fieldType)) {
      return `${field.fieldKey} cannot have a placeholder: only a typed answer shows one.`
    }
    if (field.placeholder.length > 200) {
      return `The placeholder on ${field.fieldKey} is longer than 200 characters.`
    }
  }
  if ((field.note ?? '').length > 500) {
    return `The note on ${field.fieldKey} is longer than 500 characters.`
  }
  if (field.tone != null && !['INFO', 'WARNING', 'SUCCESS', 'DANGER'].includes(field.tone)) {
    return `${field.fieldKey} has a tone of ${field.tone}, `
      + 'which is not INFO, WARNING, SUCCESS or DANGER.'
  }
  if (field.widthHint != null && !formFieldWidths.includes(field.widthHint)) {
    return `${field.fieldKey} has a width of ${field.widthHint}, which is not a recognised width.`
  }
  const affix = affixProblem(field)
  if (affix) return affix
  if (field.autocompleteHint != null) {
    if (!formFieldAutocompleteHints.includes(field.autocompleteHint)) {
      return `${field.fieldKey} has an autofill hint of ${field.autocompleteHint}, `
        + 'which is not a recognised token.'
    }
    if (!AUTOCOMPLETE_TYPES.has(field.fieldType)) {
      return `${field.fieldKey} cannot carry an autofill hint.`
    }
  }
  if (field.showCharCount) {
    if (field.fieldType !== 'TEXT' && field.fieldType !== 'LONG_TEXT') {
      return `${field.fieldKey} can only count characters on a text answer.`
    }
    if ((field.maxLength ?? null) === null) {
      return `${field.fieldKey} needs a maximum length before it can show a character count.`
    }
  }
  if (field.textareaRows != null) {
    if (field.fieldType !== 'LONG_TEXT') {
      return `${field.fieldKey} can only set rows on a several-line text answer.`
    }
    if (field.textareaRows < 2 || field.textareaRows > 20) {
      return `The rows on ${field.fieldKey} must be between 2 and 20.`
    }
  }
  return choiceStyleProblem(field)
}

/* An affix is decoration beside a value-bearing control; see the schema CHECK. */
const affixProblem = (
  field: FormTemplateInput['fields'][number],
): string | null => {
  for (const [affix, value] of [
    ['prefix', field.prefixText ?? null],
    ['suffix', field.suffixText ?? null],
  ] as const) {
    if (value == null) continue
    if (!AFFIX_TYPES.has(field.fieldType)) {
      return `${field.fieldKey} cannot carry a prefix or suffix.`
    }
    if (value.length < 1 || value.length > 8) {
      return `The ${affix} on ${field.fieldKey} must be 1 to 8 characters.`
    }
  }
  return null
}

const choiceStyleProblem = (
  field: FormTemplateInput['fields'][number],
): string | null => {
  if (field.choiceStyle == null) return null
  const fits = field.fieldType === 'SINGLE_CHOICE'
    ? SINGLE_CHOICE_STYLES.has(field.choiceStyle)
    : field.fieldType === 'MULTI_CHOICE' && MULTI_CHOICE_STYLES.has(field.choiceStyle)
  if (!fits) {
    return `${field.fieldKey} has a choice style of ${field.choiceStyle}, `
      + `which does not fit ${field.fieldType}.`
  }
  return null
}

/** The choices a question offers, against the question that offers them. */
const optionProblem = (
  template: FormTemplateInput,
  fieldsByKey: Map<string, FormTemplateInput['fields'][number]>,
): string | null => {
for (const option of template.options) {
  const field = fieldsByKey.get(option.fieldKey)
  if (!field) return `A choice names a question this cycle does not ask.`
  if (field.fieldType !== option.fieldType) {
    return `A choice on ${option.fieldKey} does not match that question's type.`
  }
  const isChoice = field.fieldType === 'SINGLE_CHOICE' || field.fieldType === 'MULTI_CHOICE'
  if ((option.optionDescription != null || option.iconName != null) && !isChoice) {
    return `Choices of ${option.fieldKey} cannot carry card styling: it is not a choice question.`
  }
  if ((option.optionDescription ?? '').length > 200) {
    return `The description on a choice of ${option.fieldKey} is longer than 200 characters.`
  }
  if (option.iconName != null && !ICON.test(option.iconName)) {
    return `The icon on a choice of ${option.fieldKey} is not a lowercase icon name.`
  }
  // The stored-value grammar, mirrored from the option CHECK: a choice value
  // is a template key; a FILE option is a content type.
  if (isChoice && !KEY.test(option.optionValue)) {
    return `${option.optionValue} on ${option.fieldKey} is not a valid choice value.`
  }
  if (field.fieldType === 'FILE'
    && !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u
      .test(option.optionValue)) {
    return `${option.optionValue} on ${option.fieldKey} is not a content type.`
  }
}
  return null
}

/*
 * Operator and value must agree, and an ordering needs an ordered source —
 * mirrored from the condition CHECKs for the usual reason: the constraint's
 * refusal arrives as an internal error, this one as a sentence.
 */
const conditionShapeProblem = (
  condition: FormTemplateInput['conditions'][number],
): string | null => {
  const presence = condition.operator === 'IS_PRESENT' || condition.operator === 'IS_ABSENT'
  if (!presence && (condition.comparisonValue ?? null) === null) {
    return `A rule on ${condition.fieldKey} compares with ${condition.operator} but gives no value.`
  }
  if (presence && (condition.comparisonValue ?? null) !== null) {
    return `A rule on ${condition.fieldKey} asks ${condition.operator} and needs no value.`
  }
  if (
    ['GREATER_THAN', 'GREATER_OR_EQUAL', 'LESS_THAN', 'LESS_OR_EQUAL']
      .includes(condition.operator)
    && !['INTEGER', 'MONEY_PAISE', 'DATE'].includes(condition.sourceFieldType)
  ) {
    return `A rule on ${condition.fieldKey} orders ${condition.sourceFieldKey}, `
      + 'which has no order.'
  }
  if (condition.sourceFieldType === 'FILE' && !presence) {
    return `A rule on ${condition.fieldKey} can only ask whether ${condition.sourceFieldKey} `
      + 'is attached.'
  }
  if ((condition.groupNumber ?? 1) < 1 || (condition.sequenceNumber ?? 1) < 1) {
    return `A rule on ${condition.fieldKey} numbers its group below one.`
  }
  return null
}

/**
 * The rules between questions, and the questions that need one.
 *
 * The two halves are together because the second reads what the first
 * collected: a `CONDITIONAL` question with no `REQUIRED_WHEN` rule is one
 * nothing can ever make required, and only a full pass over the rules knows
 * which questions have one.
 */
const ruleProblem = (
  template: FormTemplateInput,
  fieldsByKey: Map<string, FormTemplateInput['fields'][number]>,
): string | null => {
  const conditional = new Set<string>()
  for (const condition of template.conditions) {
    /*
     * Both keys are named, because the officer reading this is usually
     * removing one question and being told about another. "A rule is based on
     * a question this cycle does not ask" is true and leaves them to search a
     * form somebody else wrote for the rule that broke.
     */
    if (!fieldsByKey.has(condition.fieldKey)) {
      return `A rule names ${condition.fieldKey}, which this cycle does not ask.`
    }
    const source = fieldsByKey.get(condition.sourceFieldKey)
    if (!source) {
      return `${condition.fieldKey} has a rule that reads ${condition.sourceFieldKey}, `
        + 'which this cycle does not ask.'
    }
    if (source.fieldType !== condition.sourceFieldType) {
      return `A rule on ${condition.fieldKey} does not match the type of the question it reads.`
    }
    if (source.fieldType === 'STATEMENT') {
      // The resolver refuses this template too; the sentence arrives first.
      return `${condition.fieldKey} has a rule that reads ${condition.sourceFieldKey}, `
        + 'which is a statement and has no answer.'
    }
    if (condition.sourceFieldKey === condition.fieldKey) {
      return `${condition.fieldKey} cannot depend on itself.`
    }
    /*
     * A rule can only read something the question can actually see.
     *
     * The third of the three cross-row rules `db/schema/seb/form-template.ts`
     * delegates here, and the one that was never written. Inside a repeated
     * entry a rule reads its siblings from that entry and everything else from
     * the top level — so a top-level question reading a *member* of a group
     * reads a key that never has a value there, and the rule **silently never
     * fires**. As `REQUIRED_WHEN` that makes a conditional question one nothing
     * can ask for; as `VISIBLE_WHEN … IS_ABSENT` it makes a question
     * permanently visible. Neither fails, which is what makes it worth
     * refusing here.
     */
    const dependent = fieldsByKey.get(condition.fieldKey)
    const sourceGroup = source.parentFieldKey ?? null
    if (sourceGroup !== null && sourceGroup !== (dependent?.parentFieldKey ?? null)) {
      return `${condition.fieldKey} has a rule that reads ${condition.sourceFieldKey}, `
        + `which is answered inside ${sourceGroup} and cannot be seen from here.`
    }
    const shape = conditionShapeProblem(condition)
    if (shape) return shape
    if (condition.effect === 'REQUIRED_WHEN') conditional.add(condition.fieldKey)
  }

  for (const field of template.fields) {
    if (field.requirement === 'CONDITIONAL' && !conditional.has(field.fieldKey)) {
      return `${field.fieldKey} is conditionally required but has no rule saying when.`
    }
  }
  return null
}

/** Whether the whole form could be answered inside what a save will carry. */
const budgetProblem = (template: FormTemplateInput): string | null => {
const budget = worstCaseAnswerBytes(template)
if (budget > MAX_ANSWER_BYTES) {
  /*
   * A cycle whose questions, answered at their own declared limits, exceed
   * what a save will accept.
   *
   * **Refused here or not at all.** The engine's budget is a byte count on
   * the answers as sent, so a cycle that breaches it is published, opened,
   * and then discovered by the first applicant who fills it in — who is told
   * to shorten their longest answers and has no way to comply, because it is
   * the *form* that is too large. Nothing else in the programme is in a
   * position to notice.
   */
  return 'The questions this cycle asks could not all be answered at once. '
    + `Shorten the longest answers it permits, or ask fewer: at their declared limits `
    + `they come to about ${Math.round(budget / 1024)} KB against a limit of `
    + `${Math.round(MAX_ANSWER_BYTES / 1024)} KB.`
}
  return null
}

/**
 * The two bindings a cycle cannot be read or opened without.
 *
 * `resolveFormTemplate` returns `null` unless every role is bound, and nothing
 * here demanded it — so an officer could **remove the requested-amount
 * question** and get a cycle whose form could no longer be read back at all.
 * The editor showed nothing, the applicant's form was unavailable, and the
 * only sign anything was wrong appeared later, when opening the cycle failed.
 *
 * Named individually rather than "the form is invalid", because the officer has
 * just removed or reworded one specific question and that is the one to put
 * back. `openingProblem` still checks at open time; this is what stops the
 * cycle reaching that state at all.
 */
const roleProblem = (template: FormTemplateInput): string | null => {
  const bound = new Map<string, string[]>()
  for (const field of template.fields) {
    if (!field.role) continue
    bound.set(field.role, [...(bound.get(field.role) ?? []), field.fieldKey])
  }
  for (const role of formFieldRoles) {
    const holders = bound.get(role) ?? []
    if (holders.length === 0) {
      return `This cycle has no question the programme can read as ${role}.`
    }
    if (holders.length > 1) {
      return `${holders.join(' and ')} both claim to be the cycle's ${role}.`
    }
    const pinned = ROLE_CANONICAL_KEY[role]
    if (pinned !== undefined && holders[0] !== pinned) {
      return `Only ${pinned} may be the cycle's ${role}, not ${holders[0]}.`
    }
  }
  /*
   * The role's own type, mirrored from the schema's role CHECK: the age rule
   * parses a date and the decision bound parses an amount, so a mistyped
   * holder is a rule that silently never fires — or a CHECK violation the
   * officer sees as an internal error.
   */
  for (const field of template.fields) {
    if (field.role === 'APPLICANT_DATE_OF_BIRTH' && field.fieldType !== 'DATE') {
      return `${field.fieldKey} plays APPLICANT_DATE_OF_BIRTH and must be a DATE question.`
    }
    if (field.role === 'SEED_FUND_REQUESTED_PAISE' && field.fieldType !== 'MONEY_PAISE') {
      return `${field.fieldKey} plays SEED_FUND_REQUESTED_PAISE and must be a MONEY_PAISE question.`
    }
  }
  return null
}

/**
 * The whole form, checked pass by pass and refused at the first fault.
 *
 * Each pass is separate because each answers a different question about the
 * template, and they run in this order deliberately: a rule naming a question
 * is only worth reporting once the questions themselves make sense, and a
 * cycle in the graph is only worth looking for once every rule names something
 * real.
 */
/*
 * Whole-group facts only visible across rows: a group must contain questions
 * (detaching a structure would otherwise delete its members silently — the
 * write accepted it and the applicant met entry cards with nothing in them),
 * and a role-bound member cannot be conditional (the age rule reads it from
 * every entry; a hidden one turns the refusal into a control nobody can see).
 */
const groupsProblem = (
  template: FormTemplateInput,
  fieldsByKey: Map<string, FormTemplateInput['fields'][number]>,
): string | null => {
  for (const field of template.fields) {
    if (field.fieldType !== 'REPEAT_GROUP') continue
    const hasMember = template.fields.some(
      (each) => each.parentFieldKey === field.fieldKey,
    )
    if (!hasMember) return `${field.fieldKey} has no questions inside it.`
  }
  for (const condition of template.conditions) {
    const target = fieldsByKey.get(condition.fieldKey)
    if (target?.role && target.parentFieldKey) {
      return `${condition.fieldKey} plays a role the programme reads from every entry: `
        + 'it cannot be conditional.'
    }
  }
  return null
}

export const formTemplateProblem = (template: FormTemplateInput): string | null => {
  const fieldsByKey = new Map(template.fields.map((field) => [field.fieldKey, field]))
  const passes = [
    () => stageProblem(template),
    () => fieldProblem(template, fieldsByKey),
    () => groupsProblem(template, fieldsByKey),
    () => optionProblem(template, fieldsByKey),
    () => ruleProblem(template, fieldsByKey),
    () => roleProblem(template),
    () => budgetProblem(template),
    () => hasVisibilityCycle(template)
      ? 'These questions depend on each other in a circle, so none of them could be shown.'
      : null,
  ]
  for (const pass of passes) {
    const problem = pass()
    if (problem) return problem
  }
  return null
}

/**
 * Whether the visibility graph has a cycle.
 *
 * A cycle deadlocks a form permanently: no ordering exists in which every
 * question's controller is decided first, so nothing renders and an applicant
 * has no way to act. Detected by repeatedly removing whatever has no
 * undecided dependency — what remains when nothing can be removed is a cycle.
 */
const hasVisibilityCycle = (template: FormTemplateInput): boolean => {
  const dependencies = new Map<string, Set<string>>(
    template.fields.map((field) => [field.fieldKey, new Set<string>()]),
  )
  for (const condition of template.conditions) {
    dependencies.get(condition.fieldKey)?.add(condition.sourceFieldKey)
  }
  const settled = new Set<string>()
  let progressed = true
  while (progressed) {
    progressed = false
    for (const [key, sources] of dependencies) {
      if (settled.has(key)) continue
      if ([...sources].every((source) => settled.has(source) || !dependencies.has(source))) {
        settled.add(key)
        progressed = true
      }
    }
  }
  return settled.size !== dependencies.size
}

/**
 * The largest answer set this template could produce, in bytes.
 *
 * Deliberately an over-estimate, and deliberately arithmetic rather than a
 * sample: what matters is that a cycle a client *could* fill to its limits is
 * one the save will accept, and a figure derived from any particular answer set
 * would say nothing about the worst one.
 *
 * Bytes, not characters, for the reason the engine's own budget is: a form
 * answered in Bengali or Kokborok costs roughly three bytes per character, so
 * counting UTF-16 units would under-count by two thirds — and the whole point
 * is to stay under a limit measured on the wire.
 */
const worstCaseAnswerBytes = (template: FormTemplateInput): number => {
  const longestOption = (fieldKey: string): number => Math.max(
    0,
    ...template.options
      .filter((option) => option.fieldKey === fieldKey)
      .map((option) => option.optionValue.length),
  )

  const valueBytes = (field: FormTemplateInput['fields'][number]): number => {
    switch (field.fieldType) {
      case 'TEXT':
      case 'LONG_TEXT':
      case 'EMAIL':
      case 'PHONE':
        // Three bytes per character, which is what an Indic script costs.
        return (field.maxLength ?? DEFAULT_TEXT_BUDGET) * 3
      case 'SINGLE_CHOICE':
        return longestOption(field.fieldKey) + 2
      case 'MULTI_CHOICE':
        return (longestOption(field.fieldKey) + 4) * (field.maxLength ?? DEFAULT_SELECTIONS)
      case 'DATE':
        return 12
      case 'INTEGER':
      case 'MONEY_PAISE':
        return 17
      case 'BOOLEAN':
      case 'ATTESTATION':
        return 5
      // None of these carries an answer: a document is evidence, a statement
      // is read, and a group's cost is its members', counted below.
      case 'FILE':
      case 'STATEMENT':
      case 'REPEAT_GROUP':
        return 0
    }
  }

  // The key, its quotes, its colon and the comma after the value.
  const entryBytes = (field: FormTemplateInput['fields'][number]): number =>
    field.fieldKey.length + 4 + valueBytes(field)

  let total = 2
  for (const field of template.fields) {
    // Truthiness, not `!== null`: this input comes off the wire, where a key
    // that was simply not sent arrives `undefined` — and `undefined !== null`
    // is true, so a strict comparison skipped every top-level question and the
    // budget came to nothing at all.
    if (field.parentFieldKey) continue
    total += entryBytes(field)
    if (field.fieldType !== 'REPEAT_GROUP') continue
    const members = template.fields.filter((each) => each.parentFieldKey === field.fieldKey)
    const perEntry = members.reduce((sum, member) => sum + entryBytes(member), 2)
    total += perEntry * (field.repeatMax ?? 0)
  }
  return total
}

/** What an unbounded text answer is assumed to cost. Only a `pattern` demands
 * a cap, so a plain question may legitimately declare none. */
const DEFAULT_TEXT_BUDGET = 2_000

/** How many selections an unbounded multiple choice is assumed to carry. */
const DEFAULT_SELECTIONS = 20
