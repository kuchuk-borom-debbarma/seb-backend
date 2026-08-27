/**
 * Editing the questions a cycle asks.
 *
 * The form is a *rule of the cycle*, frozen into its version the moment the
 * cycle opens, and every submitted application is judged against the version it
 * was filled under. So these are draft-only: changing an open cycle's questions
 * would change what applications already in flight are being asked, which the
 * whole freezing design exists to prevent. `updateDraftProgrammeCycle` already
 * refuses a non-draft cycle, and that refusal is what enforces it.
 *
 * **Every mutation here is one replace.** Adding a question reads the pinned
 * template, applies the change, hands the *whole* result to
 * `formTemplateProblem`, and writes it back. One write path and one validator,
 * so removing a question cannot produce a form that adding one would have been
 * refused for — which is exactly how a conditional question ends up without the
 * rule that made it required, a question nothing can ever ask for.
 */
import { failure, success } from '../../envelope'
import { currentStaff, ADMIN_REQUIRED_MESSAGE } from '../support'
import { constraintSafe, normalizeRequiredText } from '../support'
import type { AssessmentType } from '../types'
import { loadProgrammeCycle, updateDraftProgrammeCycle } from '../queries/programme-cycle'
import { formTemplateProblem } from '../form-template-input'
import { expandGroupDefinitions } from '../group-definitions'
import type { AdminOperationContext, AdminResult, FormTemplateInput } from '../types'
import type { ProgrammeCycleInput } from '../types'

const STALE_MESSAGE = 'The record changed. Reload and try again.'

/** Which cycle, at which version, and why. Every mutation here needs all three. */
type Scope = {
  programmeCycleId: string
  expectedVersion: number
  reason: string
}

/**
 * The cycle's current rules, as the shape the write takes.
 *
 * Read back rather than resent by the caller: a client that had to supply the
 * whole policy to move one question would be one that could silently revert a
 * change somebody else made between its read and its write.
 */
const currentInput = (
  cycle: NonNullable<Awaited<ReturnType<typeof loadProgrammeCycle>>>,
): ProgrammeCycleInput => ({
  cycleCode: cycle.head.cycleCode,
  displayName: cycle.head.displayName,
  cycleYear: cycle.head.cycleYear,
  policyReference: cycle.version.policyReference,
  applicantGuidance: cycle.version.applicantGuidance,
  partnerBankGuidance: cycle.version.partnerBankGuidance,
  // Dates, not strings: the resolver coerces the wire's `DateTime` before the
  // controller sees it, so this side of the seam works in `Date` throughout.
  opensAt: cycle.head.opensAt ?? null,
  closesAt: cycle.head.closesAt ?? null,
  policy: {
    minimumApplicantAge: cycle.version.minimumApplicantAge,
    maximumApplicantAge: cycle.version.maximumApplicantAge,
    categoryAMaximumMonths: cycle.version.categoryAMaximumMonths,
    expansionWaitMonths: cycle.version.expansionWaitMonths,
    majorityOwnershipRequired: cycle.version.majorityOwnershipRequired,
    jurisdiction: cycle.version.jurisdiction,
    fundingCeilingState: cycle.version.fundingCeilingState,
    fundingCeilingAmountPaise: cycle.version.fundingCeilingAmountPaise,
    fundingCeilingScope: cycle.version.fundingCeilingScope,
    /*
     * Narrowed here rather than by casting the whole object.
     *
     * This function used to end in `as ProgrammeCycleInput & …`, which made
     * every field of the policy unchecked — and this is the one place that
     * rebuilds a cycle's *entire* rule set in order to change one question. A
     * field added to `ProgrammeCycleInput` and forgotten here would compile,
     * and every form edit would silently reset it to its default. The cast is
     * gone so the compiler proves the round trip is complete; only the value
     * the row reads back as `string` is narrowed, and only that value.
     */
    requiredAssessmentTypes: cycle.assessmentRules.map(
      (rule) => rule.assessmentType as AssessmentType,
    ),
    formTemplate: templateOf(cycle),
    identifierRules: cycle.identifierRules.map((rule) => ({
      kind: rule.kind,
      requirement: rule.requirement,
      duplicatePolicy: rule.duplicatePolicy,
      checkType: rule.checkType,
    })),
    reasons: cycle.reasons.map((reason) => ({
      context: reason.context,
      code: reason.code,
      label: reason.label,
      applicantMessageTemplate: reason.applicantMessageTemplate,
    })),
  },
})

/**
 * The stored structures, back in the shape a caller authors.
 * Exported for the resolver: the editor reads the same shape the write takes.
 */
export const definitionsOf = (
  cycle: Pick<
    NonNullable<Awaited<ReturnType<typeof loadProgrammeCycle>>>,
    'groupDefinitions' | 'groupDefinitionMembers' | 'groupDefinitionMemberOptions'
  >,
): NonNullable<FormTemplateInput['groupDefinitions']> =>
  cycle.groupDefinitions.map((definition) => ({
    definitionKey: definition.definitionKey,
    label: definition.label,
    members: cycle.groupDefinitionMembers
      .filter((member) => member.definitionKey === definition.definitionKey)
      .map((member) => ({
        memberKey: member.memberKey,
        fieldType: member.fieldType,
        role: member.role,
        label: member.label,
        helpText: member.helpText,
        requirement: member.requirement,
        minLength: member.minLength,
        maxLength: member.maxLength,
        pattern: member.pattern,
        patternMessage: member.patternMessage,
        minValue: member.minValue,
        maxValue: member.maxValue,
        minDate: member.minDate,
        maxDate: member.maxDate,
        relativeDateBound: member.relativeDateBound,
        placeholder: member.placeholder,
        note: member.note,
        tone: member.tone,
        widthHint: member.widthHint,
        prefixText: member.prefixText,
        suffixText: member.suffixText,
        autocompleteHint: member.autocompleteHint,
        showCharCount: member.showCharCount,
        textareaRows: member.textareaRows,
        choiceStyle: member.choiceStyle,
        options: cycle.groupDefinitionMemberOptions
          .filter((option) =>
            option.definitionKey === definition.definitionKey
            && option.memberKey === member.memberKey)
          .map((option) => ({
            optionValue: option.optionValue,
            optionLabel: option.optionLabel,
            optionDescription: option.optionDescription,
            iconName: option.iconName,
          })),
      })),
  }))

/** The stored rows, back in the shape a caller authors. */
const templateOf = (
  cycle: NonNullable<Awaited<ReturnType<typeof loadProgrammeCycle>>>,
): FormTemplateInput => {
  /*
   * Derived rows are stripped: a member materialised from a structure is the
   * expansion's output, not the author's input, and showing it back would let
   * an edit drift from the definition the next write re-expands. The
   * definition itself is returned instead, from its own tables.
   */
  const derivedGroups = new Set(
    cycle.formFields
      .filter((field) => field.groupDefinitionKey)
      .map((field) => field.fieldKey),
  )
  const derived = (fieldKey: string, parentFieldKey: string | null) =>
    parentFieldKey !== null && derivedGroups.has(parentFieldKey) && fieldKey.includes('__')
  const keptFields = cycle.formFields.filter(
    (field) => !derived(field.fieldKey, field.parentFieldKey),
  )
  const keptKeys = new Set(keptFields.map((field) => field.fieldKey))
  return {
  /*
   * Order is position, not a number carried on each stage.
   *
   * `FormTemplateInput['stages']` has no `sortOrder` member — the write
   * re-derives it from array position — so passing one here was dead weight
   * TypeScript does not catch through a `.map()`. What makes that safe is that
   * the read is ordered; unordered, this array was whatever the planner
   * returned and the write renumbered the form to match it.
   */
  groupDefinitions: definitionsOf(cycle),
  stages: cycle.formStages.map((stage) => ({
    stageKey: stage.stageKey,
    title: stage.title,
    description: stage.description,
    iconName: stage.iconName,
    estimatedMinutes: stage.estimatedMinutes,
  })),
  fields: keptFields.map((field) => ({
    stageKey: field.stageKey,
    groupDefinitionKey: field.groupDefinitionKey,
    fieldKey: field.fieldKey,
    fieldType: field.fieldType,
    role: field.role,
    label: field.label,
    helpText: field.helpText,
    requirement: field.requirement,
    source: field.source,
    sortOrder: field.sortOrder,
    parentFieldKey: field.parentFieldKey,
    repeatMin: field.repeatMin,
    repeatMax: field.repeatMax,
    minLength: field.minLength,
    maxLength: field.maxLength,
    pattern: field.pattern,
    patternMessage: field.patternMessage,
    minValue: field.minValue,
    maxValue: field.maxValue,
    minDate: field.minDate,
    maxDate: field.maxDate,
    relativeDateBound: field.relativeDateBound,
    maxFileBytes: field.maxFileBytes,
    placeholder: field.placeholder,
    note: field.note,
    tone: field.tone,
    widthHint: field.widthHint,
    prefixText: field.prefixText,
    suffixText: field.suffixText,
    autocompleteHint: field.autocompleteHint,
    showCharCount: field.showCharCount,
    textareaRows: field.textareaRows,
    choiceStyle: field.choiceStyle,
  })),
  options: cycle.formFieldOptions.filter((option) => keptKeys.has(option.fieldKey)).map((option) => ({
    fieldKey: option.fieldKey,
    // Carried denormalised so a single-row CHECK can enforce "options only
    // exist for a question that offers a choice"; the composite key stops it
    // drifting from the question's own type.
    fieldType: option.fieldType,
    optionValue: option.optionValue,
    optionLabel: option.optionLabel,
    optionDescription: option.optionDescription,
    iconName: option.iconName,
    sortOrder: option.sortOrder,
  })),
  conditions: cycle.formFieldConditions.map((condition) => ({
    fieldKey: condition.fieldKey,
    effect: condition.effect,
    groupNumber: condition.groupNumber,
    sequenceNumber: condition.sequenceNumber,
    sourceFieldKey: condition.sourceFieldKey,
    sourceFieldType: condition.sourceFieldType,
    operator: condition.operator,
    comparisonValue: condition.comparisonValue,
  })) as FormTemplateInput['conditions'],
  }
}

/**
 * The one write.
 *
 * `change` receives the cycle's current questions and returns what they should
 * become. Everything else — who may do it, that the cycle is a draft, that the
 * version is current, that the result is a form the engine can resolve — is
 * decided here, once.
 */
const editTemplate = async (
  scope: Scope,
  context: AdminOperationContext,
  change: (current: FormTemplateInput) => FormTemplateInput | string,
): Promise<AdminResult<unknown>> => {
  // The form is a rule of the cycle, so it is gated like one — and this single
  // line is the gate for all seven form mutations, which funnel through here.
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  if (!normalizeRequiredText(scope.reason, 500)) return failure('Enter a change reason.')

  const cycle = await loadProgrammeCycle(context.db, scope.programmeCycleId)
  if (!cycle) return failure('The programme cycle was not found.')
  /*
   * Said here rather than left to the guarded write, which would refuse with
   * "the record changed" — true of a stale version and misleading about a
   * cycle that is simply open, where reloading changes nothing.
   */
  if (cycle.head.status !== 'DRAFT') {
    return failure('A cycle’s questions can only be changed while it is a draft.')
  }

  const next = change(templateOf(cycle))
  if (typeof next === 'string') return failure(next)

  /*
   * Structures expand before anything validates: every pass below must see
   * the questions the applicant will actually be asked. The read above
   * stripped the previous expansion, so this cannot double-expand.
   */
  const expanded = expandGroupDefinitions(next)
  if (typeof expanded === 'string') return failure(expanded)

  /*
   * The whole form, not the part that changed. A removal is refused here when
   * it orphans a rule somewhere else, and the message names the question that
   * would have been left unanswerable.
   */
  const problem = formTemplateProblem(expanded)
  if (problem) return failure(problem)

  /*
   * The cycle's whole rule set, with one question changed.
   *
   * Built once and not cast. It used to end `as never`, which turned off type
   * checking for every field of a write that rebuilds an entire cycle version —
   * so a shape change in `updateDraftProgrammeCycle` would compile here and
   * quietly reset whatever it no longer matched.
   */
  const current = currentInput(cycle)
  const changed = await constraintSafe(() => updateDraftProgrammeCycle(
    context,
    {
      ...current,
      id: scope.programmeCycleId,
      expectedVersion: scope.expectedVersion,
      reason: scope.reason,
      policy: { ...current.policy, formTemplate: expanded },
    },
    administrator.id,
    new Date(),
  ))
  if (!changed) return failure(STALE_MESSAGE)
  return success((await loadProgrammeCycle(context.db, scope.programmeCycleId))!)
}

type DefinitionInput = NonNullable<FormTemplateInput['groupDefinitions']>[number]

export const putFormGroupDefinition = (
  input: Scope & { definition: DefinitionInput },
  context: AdminOperationContext,
) => editTemplate(input, context, (current) => ({
  ...current,
  groupDefinitions: [
    ...(current.groupDefinitions ?? []).filter(
      (each) => each.definitionKey !== input.definition.definitionKey,
    ),
    input.definition,
  ],
}))

export const removeFormGroupDefinition = (
  input: Scope & { definitionKey: string },
  context: AdminOperationContext,
) => editTemplate(input, context, (current) => {
  const definitions = current.groupDefinitions ?? []
  if (!definitions.some((each) => each.definitionKey === input.definitionKey)) {
    return `This cycle defines no structure called ${input.definitionKey}.`
  }
  /*
   * Refused while used, naming the users: removing it quietly would strand
   * every using group with members the next expansion cannot rebuild.
   */
  const users = current.fields
    .filter((field) => field.groupDefinitionKey === input.definitionKey)
    .map((field) => field.fieldKey)
  if (users.length > 0) {
    return `${input.definitionKey} is used by ${users.join(' and ')}. Remove those groups first.`
  }
  return {
    ...current,
    groupDefinitions: definitions.filter(
      (each) => each.definitionKey !== input.definitionKey,
    ),
  }
})

export const replaceFormTemplate = (
  input: Scope & { template: FormTemplateInput },
  context: AdminOperationContext,
) => editTemplate(input, context, () => input.template)

export const addFormStage = (
  input: Scope & { stage: FormTemplateInput['stages'][number] },
  context: AdminOperationContext,
) => editTemplate(input, context, (current) =>
  current.stages.some((stage) => stage.stageKey === input.stage.stageKey)
    ? `This cycle already asks a stage called ${input.stage.stageKey}.`
    : { ...current, stages: [...current.stages, input.stage] })

export const updateFormStage = (
  input: Scope & { stage: FormTemplateInput['stages'][number] },
  context: AdminOperationContext,
) => editTemplate(input, context, (current) =>
  current.stages.some((stage) => stage.stageKey === input.stage.stageKey)
    ? {
        ...current,
        stages: current.stages.map((stage) =>
          stage.stageKey === input.stage.stageKey ? input.stage : stage),
      }
    : `This cycle has no stage called ${input.stage.stageKey}.`)

export const removeFormStage = (
  input: Scope & { stageKey: string },
  context: AdminOperationContext,
) => editTemplate(input, context, (current) => {
  if (!current.stages.some((stage) => stage.stageKey === input.stageKey)) {
    return `This cycle has no stage called ${input.stageKey}.`
  }
  /*
   * The questions go with it. A stage removed on its own would leave every
   * question in it naming a stage the cycle no longer has — which
   * `formTemplateProblem` refuses, so the alternative is a refusal an officer
   * cannot act on without deleting each question first.
   */
  const orphaned = new Set(
    current.fields.filter((field) => field.stageKey === input.stageKey)
      .map((field) => field.fieldKey),
  )
  return {
    // Spread first: a rebuilt object that lists the four collections silently
    // drops everything else the template carries — the structures, today.
    ...current,
    stages: current.stages.filter((stage) => stage.stageKey !== input.stageKey),
    fields: current.fields.filter((field) => !orphaned.has(field.fieldKey)),
    options: current.options.filter((option) => !orphaned.has(option.fieldKey)),
    conditions: current.conditions.filter((condition) =>
      !orphaned.has(condition.fieldKey) && !orphaned.has(condition.sourceFieldKey)),
  }
})

/**
 * One question, with the choices it offers and the rules that reveal it.
 *
 * The children name no question of their own: it is the one in `field`, and
 * the SDL leaves it out for that reason. Carrying it twice would let the two
 * differ, and the difference would be resolved silently below.
 */
type QuestionInput = Scope & {
  field: FormTemplateInput['fields'][number]
  options?: Omit<FormTemplateInput['options'][number], 'fieldKey' | 'fieldType'>[] | null
  conditions?: Omit<FormTemplateInput['conditions'][number], 'fieldKey'>[] | null
}

const withQuestion = (
  current: FormTemplateInput,
  input: QuestionInput,
): FormTemplateInput => {
  const key = input.field.fieldKey
  /*
   * The position is decided here, not left to array order. The write derives a
   * missing `sortOrder` from the field's index across the *whole* template,
   * and this function appends — so an updated question in a stage whose stored
   * numbers ran high could land on a neighbour's number and lose to the
   * per-stage unique index as a spurious "record changed". An update keeps the
   * question's place; an addition goes after everything its stage holds.
   */
  const existing = current.fields.find((field) => field.fieldKey === key)
  const sortOrder = input.field.sortOrder
    ?? existing?.sortOrder
    ?? Math.max(0, ...current.fields
      .filter((field) =>
        field.stageKey === input.field.stageKey
        && (field.parentFieldKey ?? null) === (input.field.parentFieldKey ?? null))
      .map((field, index) => field.sortOrder ?? index + 1)) + 1
  return {
    ...current,
    fields: [
      ...current.fields.filter((field) => field.fieldKey !== key),
      { ...input.field, sortOrder },
    ],
    options: [
      ...current.options.filter((option) => option.fieldKey !== key),
      ...(input.options ?? []).map((option) => ({
        ...option,
        fieldKey: key,
        fieldType: input.field.fieldType,
      })),
    ],
    /*
     * Only the rules *on* this question are replaced. A rule elsewhere that
     * reads it is somebody else's question and is not this caller's to drop —
     * and dropping it silently is how a question becomes permanently hidden.
     */
    conditions: [
      ...current.conditions.filter((condition) => condition.fieldKey !== key),
      ...(input.conditions ?? []).map((condition) => ({ ...condition, fieldKey: key })),
    ] as FormTemplateInput['conditions'],
  }
}

export const addFormQuestion = (input: QuestionInput, context: AdminOperationContext) =>
  editTemplate(input, context, (current) =>
    current.fields.some((field) => field.fieldKey === input.field.fieldKey)
      ? `This cycle already asks a question called ${input.field.fieldKey}.`
      : withQuestion(current, input))

export const updateFormQuestion = (input: QuestionInput, context: AdminOperationContext) =>
  editTemplate(input, context, (current) =>
    current.fields.some((field) => field.fieldKey === input.field.fieldKey)
      ? withQuestion(current, input)
      : `This cycle has no question called ${input.field.fieldKey}.`)

export const removeFormQuestion = (
  input: Scope & { fieldKey: string },
  context: AdminOperationContext,
) => editTemplate(input, context, (current) => {
  if (!current.fields.some((field) => field.fieldKey === input.fieldKey)) {
    return `This cycle has no question called ${input.fieldKey}.`
  }
  /*
   * A repeated group takes its members with it — a member of a group that is
   * gone belongs to nothing.
   *
   * Rules that *read* the removed question are deliberately left in place, so
   * `formTemplateProblem` refuses and names what depended on it. Dropping them
   * quietly would silently make some other question unconditional, which is a
   * change to the form nobody asked for.
   */
  const removed = new Set([
    input.fieldKey,
    ...current.fields.filter((field) => field.parentFieldKey === input.fieldKey)
      .map((field) => field.fieldKey),
  ])
  return {
    ...current,
    fields: current.fields.filter((field) => !removed.has(field.fieldKey)),
    options: current.options.filter((option) => !removed.has(option.fieldKey)),
    conditions: current.conditions.filter((condition) => !removed.has(condition.fieldKey)),
  }
})
