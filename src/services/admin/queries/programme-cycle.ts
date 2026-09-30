/**
 * Guarded persistence for programme cycles and their pinned policy versions.
 *
 * A policy snapshot is inserted only after the guarded head reached the version
 * it belongs to, and the dependent form, rule and application-kind rows stay in
 * the same batch — if the head update loses a race their version foreign key
 * fails and the whole batch rolls back.
 */
import { and, asc, count, desc, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import {
  sebApplication,
  sebPipeline,
  sebPipelineVersion,
  sebProgrammeCycle,
  sebProgrammeCycleApplicationKind,
  sebProgrammeCycleApplicationKindRule,
  sebProgrammeCycleEvent,
  sebProgrammeCycleFormRule,
  sebProgrammeCycleFormRuleOperand,
  sebProgrammeCycleFormStage,
  sebProgrammeCycleFormField,
  sebProgrammeCycleFormGroupDefinition,
  sebProgrammeCycleFormGroupDefinitionMember,
  sebProgrammeCycleFormGroupDefinitionMemberOption,
  sebProgrammeCycleFormFieldOption,
  sebProgrammeCycleFormFieldCondition,
  sebProgrammeCycleVersion,
} from '../../../db/schema'
import { COUNT_MISSING, requireInvariant } from '../../application/support'
import { batch, type Database, type Transaction } from '../../../db'
import type {
  AdminOperationContext,
  PageInfo,
  ProgrammeCycleInput,
} from '../types'
import { adminAudit } from '../support'
import { insertAuditEventWhere } from '../../audit-event'
import { auditReason } from '../../audit-vocabulary/fields'
import { prefixMatch, prefixPattern } from '../../search'
import { encodeAdminCursor } from '../pagination'

export type ProgrammeCycleRecord = typeof sebProgrammeCycle.$inferSelect
type ProgrammeCycleStatus = ProgrammeCycleRecord['status']
export type ProgrammeCycleVersionRecord = typeof sebProgrammeCycleVersion.$inferSelect

export type ProgrammeCycleAggregate = {
  head: ProgrammeCycleRecord
  version: ProgrammeCycleVersionRecord
  formStages: Array<typeof sebProgrammeCycleFormStage.$inferSelect>
  formFields: Array<typeof sebProgrammeCycleFormField.$inferSelect>
  formFieldOptions: Array<typeof sebProgrammeCycleFormFieldOption.$inferSelect>
  formFieldConditions: Array<typeof sebProgrammeCycleFormFieldCondition.$inferSelect>
  groupDefinitions: Array<typeof sebProgrammeCycleFormGroupDefinition.$inferSelect>
  groupDefinitionMembers: Array<typeof sebProgrammeCycleFormGroupDefinitionMember.$inferSelect>
  groupDefinitionMemberOptions: Array<
    typeof sebProgrammeCycleFormGroupDefinitionMemberOption.$inferSelect
  >
  formRules: Array<typeof sebProgrammeCycleFormRule.$inferSelect>
  formRuleOperands: Array<typeof sebProgrammeCycleFormRuleOperand.$inferSelect>
  applicationKinds: Array<typeof sebProgrammeCycleApplicationKind.$inferSelect>
  applicationKindRules: Array<typeof sebProgrammeCycleApplicationKindRule.$inferSelect>
}

export const loadProgrammeCycle = async (
  db: Database,
  id: string,
): Promise<ProgrammeCycleAggregate | null> => {
  const [row] = await db
    .select({ head: sebProgrammeCycle, version: sebProgrammeCycleVersion })
    .from(sebProgrammeCycle)
    .innerJoin(
      sebProgrammeCycleVersion,
      and(
        eq(sebProgrammeCycleVersion.programmeCycleId, sebProgrammeCycle.id),
        eq(sebProgrammeCycleVersion.version, sebProgrammeCycle.currentVersion),
      ),
    )
    .where(eq(sebProgrammeCycle.id, id))
    .limit(1)
  if (!row) return null
  /*
   * One transaction, not seven round trips. Every read here is single-table, so
   * one MVCC snapshot answers all of them and a caller cannot observe a cycle
   * mid-revision — half its old fields and half its new ones.
   */
  const [formStages, formFields, formFieldOptions, formFieldConditions,
    groupDefinitions, groupDefinitionMembers, groupDefinitionMemberOptions,
    formRules, formRuleOperands, applicationKinds, applicationKindRules] = await batch(db, (tx) => [
    /*
     * Ordered, and that is not cosmetic.
     *
     * Every write re-derives `sort_order` from array position, and this is the
     * array. Read unordered, a cycle's steps came back in whatever order the
     * planner returned — alphabetical, given the `(cycle, version, stage_key)`
     * unique index — so **rewording one question renumbered the whole form**,
     * and every applicant on the new version saw the steps in an order nobody
     * chose. The applicant-side read has always ordered these; this one did not.
     */
    tx.select().from(sebProgrammeCycleFormStage).where(and(
      eq(sebProgrammeCycleFormStage.programmeCycleId, id),
      eq(sebProgrammeCycleFormStage.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(asc(sebProgrammeCycleFormStage.sortOrder)),
    tx.select().from(sebProgrammeCycleFormField).where(and(
      eq(sebProgrammeCycleFormField.programmeCycleId, id),
      eq(sebProgrammeCycleFormField.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(asc(sebProgrammeCycleFormField.sortOrder)),
    tx.select().from(sebProgrammeCycleFormFieldOption).where(and(
      eq(sebProgrammeCycleFormFieldOption.programmeCycleId, id),
      eq(sebProgrammeCycleFormFieldOption.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(asc(sebProgrammeCycleFormFieldOption.sortOrder)),
    /*
     * By group and then by sequence, which is how a rule set is read: members
     * of a group are ANDed and separate groups are alternatives, so the
     * numbering is the rule rather than a display preference.
     */
    tx.select().from(sebProgrammeCycleFormFieldCondition).where(and(
      eq(sebProgrammeCycleFormFieldCondition.programmeCycleId, id),
      eq(sebProgrammeCycleFormFieldCondition.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(
      asc(sebProgrammeCycleFormFieldCondition.groupNumber),
      asc(sebProgrammeCycleFormFieldCondition.sequenceNumber),
    ),
    tx.select().from(sebProgrammeCycleFormGroupDefinition).where(and(
      eq(sebProgrammeCycleFormGroupDefinition.programmeCycleId, id),
      eq(sebProgrammeCycleFormGroupDefinition.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(asc(sebProgrammeCycleFormGroupDefinition.definitionKey)),
    // Member order is authored order, same reasoning as the stages above.
    tx.select().from(sebProgrammeCycleFormGroupDefinitionMember).where(and(
      eq(sebProgrammeCycleFormGroupDefinitionMember.programmeCycleId, id),
      eq(sebProgrammeCycleFormGroupDefinitionMember.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(asc(sebProgrammeCycleFormGroupDefinitionMember.sortOrder)),
    tx.select().from(sebProgrammeCycleFormGroupDefinitionMemberOption).where(and(
      eq(sebProgrammeCycleFormGroupDefinitionMemberOption.programmeCycleId, id),
      eq(
        sebProgrammeCycleFormGroupDefinitionMemberOption.programmeCycleVersion,
        row.head.currentVersion,
      ),
    )).orderBy(asc(sebProgrammeCycleFormGroupDefinitionMemberOption.sortOrder)),
    tx.select().from(sebProgrammeCycleFormRule).where(and(
      eq(sebProgrammeCycleFormRule.programmeCycleId, id),
      eq(sebProgrammeCycleFormRule.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(asc(sebProgrammeCycleFormRule.ruleKey)),
    // Operand order is the rule's meaning for AT_MOST_FIELD, so it is kept.
    tx.select().from(sebProgrammeCycleFormRuleOperand).where(and(
      eq(sebProgrammeCycleFormRuleOperand.programmeCycleId, id),
      eq(sebProgrammeCycleFormRuleOperand.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(
      asc(sebProgrammeCycleFormRuleOperand.ruleKey),
      asc(sebProgrammeCycleFormRuleOperand.position),
    ),
    tx.select().from(sebProgrammeCycleApplicationKind).where(and(
      eq(sebProgrammeCycleApplicationKind.programmeCycleId, id),
      eq(sebProgrammeCycleApplicationKind.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(asc(sebProgrammeCycleApplicationKind.sortOrder)),
    tx.select().from(sebProgrammeCycleApplicationKindRule).where(and(
      eq(sebProgrammeCycleApplicationKindRule.programmeCycleId, id),
      eq(sebProgrammeCycleApplicationKindRule.programmeCycleVersion, row.head.currentVersion),
    )).orderBy(
      asc(sebProgrammeCycleApplicationKindRule.kindKey),
      asc(sebProgrammeCycleApplicationKindRule.position),
    ),
  ])
  return {
    ...row,
    formStages, formFields, formFieldOptions, formFieldConditions,
    groupDefinitions, groupDefinitionMembers, groupDefinitionMemberOptions,
    formRules, formRuleOperands, applicationKinds, applicationKindRules,
  }
}

export const listProgrammeCycles = async (
  db: Database,
  input: {
    first: number
    after: { timestamp: Date; id: string } | null
    includeDeleted: boolean
    status?: ProgrammeCycleStatus | null
    cycleYear?: number | null
    search?: string | null
  },
): Promise<{ nodes: ProgrammeCycleRecord[]; pageInfo: PageInfo }> => {
  const cursor = input.after
    ? or(
        gt(sebProgrammeCycle.updatedAt, input.after.timestamp),
        and(
          eq(sebProgrammeCycle.updatedAt, input.after.timestamp),
          gt(sebProgrammeCycle.id, input.after.id),
        ),
      )
    : undefined
  const pattern = prefixPattern(input.search)
  const filters = and(
    input.includeDeleted ? undefined : isNull(sebProgrammeCycle.deletedAt),
    input.status ? eq(sebProgrammeCycle.status, input.status) : undefined,
    input.cycleYear ? eq(sebProgrammeCycle.cycleYear, input.cycleYear) : undefined,
    // The code, which is what a cycle is called in conversation.
    pattern ? prefixMatch(sebProgrammeCycle.cycleCode, pattern) : undefined,
  )
  const rows = await db
    .select()
    .from(sebProgrammeCycle)
    .where(and(filters, cursor))
    .orderBy(asc(sebProgrammeCycle.updatedAt), asc(sebProgrammeCycle.id))
    .limit(input.first + 1)
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)
  const [total] = await db
    .select({ value: count() })
    .from(sebProgrammeCycle)
    .where(filters)
  return {
    nodes: selected,
    pageInfo: {
      hasNextPage: rows.length > input.first,
      endCursor: last ? encodeAdminCursor('updatedAt', last.updatedAt, last.id) : null,
      totalCount: requireInvariant(total, COUNT_MISSING).value,
    },
  }
}

export const programmeCycleCounts = async (db: Database, id: string) => {
  const rows = await db
    .select({ status: sebApplication.status, count: sql<number>`count(*)` })
    .from(sebApplication)
    .where(eq(sebApplication.programmeCycleId, id))
    .groupBy(sebApplication.status)
  return rows.map(({ status, count }) => ({ status, count: Number(count) }))
}

/**
 * Applications of a cycle nobody has finished with: drafts, and files still at
 * a stage of their pipeline. A cycle with any is not archived, because
 * archiving hides the cycle from the office while its files are still being
 * worked.
 */
export const unfinishedApplicationCount = async (db: Database, id: string): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(sebApplication)
    .where(and(
      eq(sebApplication.programmeCycleId, id),
      isNull(sebApplication.deletedAt),
      or(eq(sebApplication.status, 'DRAFT'), sql`${sebApplication.currentStageKey} IS NOT NULL`),
    ))
  return requireInvariant(row, COUNT_MISSING).value
}

/**
 * The published version a cycle choosing or opening on this pipeline would
 * pin now, with its document — or null when the pipeline does not exist, is
 * retired, or has never been published.
 *
 * The document comes with the number because opening checks the cycle's form
 * against it, and the version pinned must be the version checked.
 */
export const findPipelinePublishedDefinition = async (
  db: Database,
  pipelineId: string,
): Promise<{ version: number; definition: unknown } | null> => {
  const [row] = await db
    .select({ version: sebPipelineVersion.version, definition: sebPipelineVersion.definition })
    .from(sebPipeline)
    .innerJoin(sebPipelineVersion, and(
      eq(sebPipelineVersion.pipelineId, sebPipeline.id),
      eq(sebPipelineVersion.version, sebPipeline.currentPublishedVersion),
      eq(sebPipelineVersion.status, 'PUBLISHED'),
    ))
    .where(and(eq(sebPipeline.id, pipelineId), isNull(sebPipeline.retiredAt)))
    .limit(1)
  return row ?? null
}

export const listProgrammeCycleEvents = async (
  db: Database,
  id: string,
  first: number,
) => db
  .select()
  .from(sebProgrammeCycleEvent)
  .where(eq(sebProgrammeCycleEvent.programmeCycleId, id))
  .orderBy(desc(sebProgrammeCycleEvent.createdAt), desc(sebProgrammeCycleEvent.id))
  .limit(first)

const versionValues = (
  cycleId: string,
  version: number,
  input: ProgrammeCycleInput,
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED',
  changeType:
    | 'CREATED'
    | 'UPDATED'
    | 'OPENED'
    | 'GUIDANCE_CHANGED'
    | 'CLOSING_CHANGED'
    | 'CLOSED'
    | 'ARCHIVED',
  reason: string | null,
  actorUserId: string,
  now: Date,
): typeof sebProgrammeCycleVersion.$inferInsert => ({
  id: crypto.randomUUID(),
  programmeCycleId: cycleId,
  version,
  cycleCode: input.cycleCode,
  displayName: input.displayName,
  cycleYear: input.cycleYear,
  // Dead column: the free-text reference was replaced by the versioned policy
  // PDF in `seb_cycle_policy_document`. Written null until a later migration
  // drops it, so the guarded insert's positional SELECT keeps its arity.
  policyReference: null,
  applicantGuidance: input.applicantGuidance ?? null,
  status,
  opensAt: input.opensAt ?? null,
  closesAt: input.closesAt ?? null,
  minimumApplicantAge: input.policy.minimumApplicantAge,
  maximumApplicantAge: input.policy.maximumApplicantAge,
  categoryAMaximumMonths: input.policy.categoryAMaximumMonths,
  majorityOwnershipRequired: input.policy.majorityOwnershipRequired,
  jurisdiction: input.policy.jurisdiction,
  fundingCeilingState: input.policy.fundingCeilingState,
  fundingCeilingAmountPaise: input.policy.fundingCeilingAmountPaise,
  fundingCeilingScope: input.policy.fundingCeilingScope,
  pipelineId: input.policy.pipelineId,
  // Stamped when the cycle opens, never before: a draft pins nothing.
  pipelineVersion: null,
  changeType,
  changeReason: reason,
  changedByUserId: actorUserId,
  createdAt: now,
})

/* The bound columns, with an absent wire value stored as null. */
const fieldRuleColumns = (field: ProgrammeCycleInput['policy']['formTemplate']['fields'][number]) => ({
  repeatMin: field.repeatMin ?? null,
  repeatMax: field.repeatMax ?? null,
  minLength: field.minLength ?? null,
  maxLength: field.maxLength ?? null,
  pattern: field.pattern ?? null,
  patternMessage: field.patternMessage ?? null,
  minValue: field.minValue ?? null,
  maxValue: field.maxValue ?? null,
  minDate: field.minDate ?? null,
  maxDate: field.maxDate ?? null,
  relativeDateBound: field.relativeDateBound ?? null,
  maxFileBytes: field.maxFileBytes ?? null,
})

/* A member's bound columns: no repeat or file bounds — a member is neither. */
const fieldRuleMemberColumns = (member: {
  minLength?: number | null
  maxLength?: number | null
  pattern?: string | null
  patternMessage?: string | null
  minValue?: number | null
  maxValue?: number | null
  minDate?: string | null
  maxDate?: string | null
  relativeDateBound?: 'NOT_FUTURE' | 'NOT_PAST' | null
}) => ({
  minLength: member.minLength ?? null,
  maxLength: member.maxLength ?? null,
  pattern: member.pattern ?? null,
  patternMessage: member.patternMessage ?? null,
  minValue: member.minValue ?? null,
  maxValue: member.maxValue ?? null,
  minDate: member.minDate ?? null,
  maxDate: member.maxDate ?? null,
  relativeDateBound: member.relativeDateBound ?? null,
})

/* The drawing columns, same rule. Typed to the subset both a field and a
   structure member carry, because both store them. */
const fieldPresentationColumns = (field: {
  placeholder?: string | null
  note?: string | null
  tone?: import('../../../db/schema/seb/form-template').FormFieldTone | null
  widthHint?: import('../../../db/schema/seb/form-template').FormFieldWidth | null
  prefixText?: string | null
  suffixText?: string | null
  autocompleteHint?:
    | import('../../../db/schema/seb/form-template').FormFieldAutocompleteHint
    | null
  showCharCount?: boolean | null
  textareaRows?: number | null
  choiceStyle?: import('../../../db/schema/seb/form-template').FormFieldChoiceStyle | null
}) => ({
  placeholder: field.placeholder ?? null,
  note: field.note ?? null,
  tone: field.tone ?? null,
  widthHint: field.widthHint ?? null,
  prefixText: field.prefixText ?? null,
  suffixText: field.suffixText ?? null,
  autocompleteHint: field.autocompleteHint ?? null,
  showCharCount: field.showCharCount ?? false,
  textareaRows: field.textareaRows ?? null,
  choiceStyle: field.choiceStyle ?? null,
})

const policyRows = (
  cycleId: string,
  version: number,
  input: ProgrammeCycleInput,
  now: Date,
) => ({
  /*
   * The form itself, which is what the document rules became.
   *
   * A required document is now an ordinary FILE field with an ordinary
   * `REQUIRED_WHEN`, so "always", "when registered", "when a GSTIN is present"
   * and "when a no-objection certificate applies" stop being four hard-coded
   * conditions against three named columns and become conditions against
   * whatever the cycle happens to ask.
   */
  formStages: input.policy.formTemplate.stages.map((stage, index) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    stageKey: stage.stageKey,
    title: stage.title,
    description: stage.description ?? null,
    iconName: stage.iconName ?? null,
    estimatedMinutes: stage.estimatedMinutes ?? null,
    sortOrder: index + 1,
    createdAt: now,
  })),
  formFields: input.policy.formTemplate.fields.map((field, index) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    stageKey: field.stageKey,
    fieldKey: field.fieldKey,
    fieldType: field.fieldType,
    role: field.role ?? null,
    parentFieldKey: field.parentFieldKey ?? null,
    // Carried so the self-referential key can prove a parent is a group; the
    // CHECK refuses any other pairing.
    parentFieldType: field.parentFieldKey ? ('REPEAT_GROUP' as const) : null,
    groupDefinitionKey: field.groupDefinitionKey ?? null,
    sortOrder: field.sortOrder ?? index + 1,
    label: field.label,
    helpText: field.helpText ?? null,
    requirement: field.requirement,
    source: field.source ?? ('APPLICANT' as const),
    ...fieldRuleColumns(field),
    ...fieldPresentationColumns(field),
    createdAt: now,
  })),
  formFieldOptions: input.policy.formTemplate.options.map((option, index) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    fieldKey: option.fieldKey,
    fieldType: option.fieldType,
    optionValue: option.optionValue,
    optionLabel: option.optionLabel,
    optionDescription: option.optionDescription ?? null,
    iconName: option.iconName ?? null,
    sortOrder: option.sortOrder ?? index + 1,
    createdAt: now,
  })),
  groupDefinitions: (input.policy.formTemplate.groupDefinitions ?? []).map((definition) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    definitionKey: definition.definitionKey,
    label: definition.label,
    createdAt: now,
  })),
  groupDefinitionMembers: (input.policy.formTemplate.groupDefinitions ?? []).flatMap(
    (definition) => definition.members.map((member, index) => ({
      id: crypto.randomUUID(),
      programmeCycleId: cycleId,
      programmeCycleVersion: version,
      definitionKey: definition.definitionKey,
      memberKey: member.memberKey,
      fieldType: member.fieldType,
      role: member.role ?? null,
      sortOrder: index + 1,
      label: member.label,
      helpText: member.helpText ?? null,
      requirement: member.requirement,
      ...fieldRuleMemberColumns(member),
      ...fieldPresentationColumns(member),
      createdAt: now,
    })),
  ),
  groupDefinitionMemberOptions: (input.policy.formTemplate.groupDefinitions ?? []).flatMap(
    (definition) => definition.members.flatMap((member) =>
      (member.options ?? []).map((option, index) => ({
        id: crypto.randomUUID(),
        programmeCycleId: cycleId,
        programmeCycleVersion: version,
        definitionKey: definition.definitionKey,
        memberKey: member.memberKey,
        optionValue: option.optionValue,
        optionLabel: option.optionLabel,
        optionDescription: option.optionDescription ?? null,
        iconName: option.iconName ?? null,
        sortOrder: index + 1,
        createdAt: now,
      })),
    ),
  ),
  formFieldConditions: input.policy.formTemplate.conditions.map((condition, index) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    fieldKey: condition.fieldKey,
    effect: condition.effect,
    groupNumber: condition.groupNumber ?? 1,
    sequenceNumber: condition.sequenceNumber ?? index + 1,
    sourceFieldKey: condition.sourceFieldKey,
    sourceFieldType: condition.sourceFieldType,
    operator: condition.operator,
    comparisonValue: condition.comparisonValue ?? null,
    createdAt: now,
  })),
  formRules: (input.policy.formTemplate.rules ?? []).map((rule) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    ruleKey: rule.ruleKey,
    ruleType: rule.ruleType,
    stageKey: rule.stageKey,
    message: rule.message,
    limitValue: rule.limitValue ?? null,
    createdAt: now,
  })),
  formRuleOperands: (input.policy.formTemplate.rules ?? []).flatMap((rule) =>
    rule.operands.map((operand, index) => ({
      id: crypto.randomUUID(),
      programmeCycleId: cycleId,
      programmeCycleVersion: version,
      ruleKey: rule.ruleKey,
      position: index + 1,
      fieldKey: operand.fieldKey,
      fieldType: operand.fieldType,
    })),
  ),
  applicationKinds: input.policy.applicationKinds.map((kind, index) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    kindKey: kind.kindKey,
    label: kind.label,
    description: kind.description ?? null,
    sortOrder: index + 1,
    createdAt: now,
  })),
  applicationKindRules: input.policy.applicationKinds.flatMap((kind) =>
    kind.rules.map((rule, index) => ({
      id: crypto.randomUUID(),
      programmeCycleId: cycleId,
      programmeCycleVersion: version,
      kindKey: kind.kindKey,
      position: index + 1,
      ruleType: rule.ruleType,
      params: rule.params,
    })),
  ),
})

/**
 * Every rule table's rows for a new version, one multi-row insert per table.
 *
 * Each statement in a batch is its own round trip, and a real template is over
 * a hundred rows — per-row inserts once made creating a cycle a twenty-second
 * wait from a deployed Worker. Parents before children, because every child row
 * names its parent by key. Empty tables are skipped: drizzle refuses
 * `.values([])`.
 */
const policyInserts = (tx: Transaction, policy: ReturnType<typeof policyRows>) => [
  policy.formStages.length
    ? tx.insert(sebProgrammeCycleFormStage).values(policy.formStages) : null,
  policy.formFields.length
    ? tx.insert(sebProgrammeCycleFormField).values(policy.formFields) : null,
  policy.formFieldOptions.length
    ? tx.insert(sebProgrammeCycleFormFieldOption).values(policy.formFieldOptions) : null,
  policy.formFieldConditions.length
    ? tx.insert(sebProgrammeCycleFormFieldCondition).values(policy.formFieldConditions)
    : null,
  policy.groupDefinitions.length
    ? tx.insert(sebProgrammeCycleFormGroupDefinition).values(policy.groupDefinitions)
    : null,
  policy.groupDefinitionMembers.length
    ? tx.insert(sebProgrammeCycleFormGroupDefinitionMember)
        .values(policy.groupDefinitionMembers)
    : null,
  policy.groupDefinitionMemberOptions.length
    ? tx.insert(sebProgrammeCycleFormGroupDefinitionMemberOption)
        .values(policy.groupDefinitionMemberOptions)
    : null,
  policy.formRules.length
    ? tx.insert(sebProgrammeCycleFormRule).values(policy.formRules) : null,
  policy.formRuleOperands.length
    ? tx.insert(sebProgrammeCycleFormRuleOperand).values(policy.formRuleOperands) : null,
  policy.applicationKinds.length
    ? tx.insert(sebProgrammeCycleApplicationKind).values(policy.applicationKinds) : null,
  policy.applicationKindRules.length
    ? tx.insert(sebProgrammeCycleApplicationKindRule).values(policy.applicationKindRules)
    : null,
].filter((statement) => statement !== null)

/**
 * The whole policy, carried forward from one version to the next.
 *
 * **Every rule table must be here.** A table that is not copied empties itself
 * the first time a cycle changes version — and for the form that loses *the
 * entire application form for every draft in the cycle*, at the moment it is
 * opened or its guidance is edited. Worse, stages emptying makes fields fail
 * their stage key on the *next* bump, so the damage surfaces one version after
 * its cause. One helper for both callers, so a new rule table is added once.
 *
 * Parents before children, for the same reason as `policyInserts`.
 * `gen_random_uuid()` gives every copied row a fresh id.
 */
const copyPolicyForward = (
  tx: Transaction,
  cycleId: string,
  fromVersion: number,
  toVersion: number,
  now: Date,
) => {
  const from = (table: SQL) => sql`FROM ${table}
      WHERE programme_cycle_id = ${cycleId}
        AND programme_cycle_version = ${fromVersion}`
  return [
    tx.insert(sebProgrammeCycleFormStage).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        stage_key, title, description, icon_name, estimated_minutes,
        sort_order, ${now}
      ${from(sql`${sebProgrammeCycleFormStage}`)}
    `),
    tx.insert(sebProgrammeCycleFormField).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        stage_key, field_key, field_type, role, parent_field_key, parent_field_type,
        group_definition_key,
        sort_order, label, help_text,
        placeholder, note, tone, width_hint, prefix_text, suffix_text,
        autocomplete_hint, show_char_count, textarea_rows, choice_style,
        requirement, source, repeat_min, repeat_max,
        min_length, max_length, pattern, pattern_message, min_value, max_value,
        min_date, max_date, relative_date_bound, max_file_bytes, ${now}
      ${from(sql`${sebProgrammeCycleFormField}`)}
    `),
    tx.insert(sebProgrammeCycleFormFieldOption).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        field_key, field_type, option_value, option_label,
        option_description, icon_name, sort_order, ${now}
      ${from(sql`${sebProgrammeCycleFormFieldOption}`)}
    `),
    tx.insert(sebProgrammeCycleFormFieldCondition).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        field_key, effect, group_number, sequence_number, source_field_key,
        source_field_type, operator, comparison_value, ${now}
      ${from(sql`${sebProgrammeCycleFormFieldCondition}`)}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinition).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        definition_key, label, ${now}
      ${from(sql`${sebProgrammeCycleFormGroupDefinition}`)}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinitionMember).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        definition_key, member_key, field_type, role, sort_order, label,
        help_text, placeholder, note, tone, width_hint, prefix_text,
        suffix_text, autocomplete_hint, show_char_count, textarea_rows,
        choice_style, requirement, min_length, max_length, pattern,
        pattern_message, min_value, max_value, min_date, max_date,
        relative_date_bound, ${now}
      ${from(sql`${sebProgrammeCycleFormGroupDefinitionMember}`)}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinitionMemberOption).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        definition_key, member_key, option_value, option_label,
        option_description, icon_name, sort_order, ${now}
      ${from(sql`${sebProgrammeCycleFormGroupDefinitionMemberOption}`)}
    `),
    tx.insert(sebProgrammeCycleFormRule).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        rule_key, rule_type, stage_key, message, limit_value, ${now}
      ${from(sql`${sebProgrammeCycleFormRule}`)}
    `),
    tx.insert(sebProgrammeCycleFormRuleOperand).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        rule_key, position, field_key, field_type
      ${from(sql`${sebProgrammeCycleFormRuleOperand}`)}
    `),
    tx.insert(sebProgrammeCycleApplicationKind).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        kind_key, label, description, sort_order, ${now}
      ${from(sql`${sebProgrammeCycleApplicationKind}`)}
    `),
    tx.insert(sebProgrammeCycleApplicationKindRule).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${toVersion},
        kind_key, position, rule_type, params
      ${from(sql`${sebProgrammeCycleApplicationKindRule}`)}
    `),
  ]
}

/** Inserts a policy snapshot only after the guarded head reached that version. */
const insertGuardedCycleVersion = (
  context: AdminOperationContext,
  value: typeof sebProgrammeCycleVersion.$inferInsert,
  /** Replaces the stored pin; the opening write stamps it this way. */
  pipelineVersion: SQL | number | null = value.pipelineVersion ?? null,
) => context.db.insert(sebProgrammeCycleVersion).select(sql`
  SELECT ${value.id}, ${value.programmeCycleId}, ${value.version}, ${value.cycleCode},
    ${value.displayName}, ${value.cycleYear}, ${value.policyReference},
    ${value.applicantGuidance}, ${value.status},
    ${value.opensAt ? value.opensAt : null},
    ${value.closesAt ? value.closesAt : null},
    ${value.minimumApplicantAge}, ${value.maximumApplicantAge},
    ${value.categoryAMaximumMonths},
    ${value.majorityOwnershipRequired}, ${value.jurisdiction},
    ${value.fundingCeilingState}, ${value.fundingCeilingAmountPaise},
    ${value.fundingCeilingScope}, ${value.pipelineId}, ${pipelineVersion},
    ${value.changeType}, ${value.changeReason},
    ${value.changedByUserId},
    ${value.createdAt}
  WHERE EXISTS (
    SELECT 1 FROM ${sebProgrammeCycle}
    WHERE ${sebProgrammeCycle.id} = ${value.programmeCycleId}
      AND ${sebProgrammeCycle.currentVersion} = ${value.version}
      AND ${sebProgrammeCycle.updatedAt} = ${value.createdAt}
  )
`)

export const insertProgrammeCycle = async (
  context: AdminOperationContext,
  input: ProgrammeCycleInput,
  actorUserId: string,
  now: Date,
): Promise<string | null> => {
  const id = crypto.randomUUID()
  const policy = policyRows(id, 1, input, now)
  const audit = adminAudit(context, {
    actorUserId,
    action: 'SEB.CYCLE_CREATED',
    entityType: 'SEB_PROGRAMME_CYCLE',
    entityId: id,
    payload: { cycleCode: input.cycleCode, displayName: input.displayName, cycleYear: input.cycleYear },
    now,
  })
  const statements = (tx: Transaction) => [
    tx.insert(sebProgrammeCycle).values({
      id,
      cycleCode: input.cycleCode,
      displayName: input.displayName,
      cycleYear: input.cycleYear,
      // Dead column — see `versionValues`. The policy PDF replaced it.
      policyReference: null,
      applicantGuidance: input.applicantGuidance ?? null,
      status: 'DRAFT',
      opensAt: input.opensAt ?? null,
      closesAt: input.closesAt ?? null,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
    }),
    tx.insert(sebProgrammeCycleVersion).values(
      versionValues(id, 1, input, 'DRAFT', 'CREATED', null, actorUserId, now),
    ),
    ...policyInserts(tx, policy),
    // Unconditional: creation has no guard to lose — the cycle's own insert
    // failing fails the whole batch, audit row included.
    insertAuditEventWhere(tx, audit, sql`TRUE`),
  ]
  await batch(context.db, statements)
  return id
}

export const updateDraftProgrammeCycle = async (
  context: AdminOperationContext,
  input: ProgrammeCycleInput & { id: string; expectedVersion: number; reason: string },
  actorUserId: string,
  now: Date,
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const policy = policyRows(input.id, nextVersion, input, now)
  const updated = context.db
    .update(sebProgrammeCycle)
    .set({
      cycleCode: input.cycleCode,
      displayName: input.displayName,
      cycleYear: input.cycleYear,
      // Dead column — see `versionValues`. The policy PDF replaced it.
      policyReference: null,
      applicantGuidance: input.applicantGuidance ?? null,
      opensAt: input.opensAt ?? null,
      closesAt: input.closesAt ?? null,
      currentVersion: nextVersion,
      updatedAt: now,
    })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.id),
        eq(sebProgrammeCycle.status, 'DRAFT'),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  // The dependent inserts intentionally remain in the same D1 batch. If the
  // guarded head update loses a race, their version foreign key fails and D1
  // rolls the complete batch back.
  const [changed] = await batch(context.db, (tx) => [
    updated,
    insertGuardedCycleVersion(
      context,
      versionValues(
        input.id,
        nextVersion,
        input,
        'DRAFT',
        'UPDATED',
        input.reason,
        actorUserId,
        now,
      ),
    ),
    ...policyInserts(tx, policy),
    insertAuditEventWhere(tx, adminAudit(context, {
      actorUserId,
      action: 'SEB.CYCLE_UPDATED',
      entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: input.id,
      payload: { version: nextVersion, reason: auditReason(input.reason) },
      now,
    }), sql`EXISTS (
      SELECT 1 FROM ${sebProgrammeCycleVersion}
      WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.id}
        AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
        AND ${sebProgrammeCycleVersion.createdAt} = ${now}
    )`),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const transitionProgrammeCycle = async (
  context: AdminOperationContext,
  input: {
    aggregate: ProgrammeCycleAggregate
    expectedVersion: number
    toStatus: 'OPEN' | 'CLOSED' | 'ARCHIVED'
    changeType: 'OPENED' | 'CLOSED' | 'ARCHIVED'
    reason: string
    message: string
    action: 'SEB.CYCLE_OPENED' | 'SEB.CYCLE_CLOSED' | 'SEB.CYCLE_ARCHIVED'
    actorUserId: string | null
    now: Date
    /**
     * Opening only: the published pipeline version the caller checked the
     * cycle's form against. Pinned as given rather than re-read, so the
     * version pinned is the version checked even if a newer one is published
     * in between — a published version never changes, so it is still valid.
     */
    pinnedPipelineVersion?: number
  },
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const updated = context.db
    .update(sebProgrammeCycle)
    .set({ status: input.toStatus, currentVersion: nextVersion, updatedAt: input.now })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.aggregate.head.id),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        eq(sebProgrammeCycle.status, input.aggregate.head.status),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  const base = input.aggregate.version
  const [changed] = await batch(context.db, (tx) => [
    updated,
    insertGuardedCycleVersion(
      context,
      {
        ...base,
        id: crypto.randomUUID(),
        version: nextVersion,
        status: input.toStatus,
        changeType: input.changeType,
        changeReason: input.reason,
        changedByUserId: input.actorUserId,
        createdAt: input.now,
      },
      /*
       * Opening pins the version the caller checked, but only while the
       * pipeline is still live: retired in between, this yields NULL, the
       * version's pin CHECK refuses the row, and the whole transition rolls
       * back to the stale answer. Closing and archiving keep the pin they
       * already have.
       */
      input.toStatus === 'OPEN'
        ? sql`(SELECT ${input.pinnedPipelineVersion ?? null}::integer FROM ${sebPipeline}
            WHERE ${sebPipeline.id} = ${base.pipelineId} AND ${sebPipeline.retiredAt} IS NULL)`
        : base.pipelineVersion,
    ),
    ...copyPolicyForward(tx, input.aggregate.head.id, input.expectedVersion, nextVersion, input.now),
    /*
     * The `created_at` term ties the guard to *this* writer's snapshot, not
     * merely to the version number: two racing writers compute the same
     * `nextVersion`, and the loser — whose own snapshot insert was refused —
     * would otherwise find the winner's row and record an event and an audit
     * entry for a change it never made.
     */
    tx.insert(sebProgrammeCycleEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.aggregate.head.id}, ${input.changeType},
        ${input.actorUserId}, ${input.message}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
          AND ${sebProgrammeCycleVersion.createdAt} = ${input.now}
      )
    `),
    insertAuditEventWhere(tx, adminAudit(context, {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: input.aggregate.head.id,
      payload: {
        version: nextVersion,
        reason: auditReason(input.reason),
        // The hourly close is the only transition without an operator.
        scheduled: input.actorUserId === null,
      },
      now: input.now,
    }), sql`EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
          AND ${sebProgrammeCycleVersion.createdAt} = ${input.now}
      )`),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const reviseOpenProgrammeCycle = async (
  context: AdminOperationContext,
  input: {
    aggregate: ProgrammeCycleAggregate
    expectedVersion: number
    applicantGuidance?: string
    /** Undefined keeps the stored time; null removes it. */
    closesAt?: Date | null
    changeType: 'GUIDANCE_CHANGED' | 'CLOSING_CHANGED'
    reason: string
    message: string
    action: 'SEB.CYCLE_GUIDANCE_CHANGED' | 'SEB.CYCLE_CLOSING_CHANGED'
    actorUserId: string
    now: Date
  },
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const guidance = input.applicantGuidance ?? input.aggregate.head.applicantGuidance
  const closesAt = input.closesAt === undefined ? input.aggregate.head.closesAt : input.closesAt
  const update = context.db
    .update(sebProgrammeCycle)
    .set({
      applicantGuidance: guidance,
      closesAt,
      currentVersion: nextVersion,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.aggregate.head.id),
        eq(sebProgrammeCycle.status, 'OPEN'),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  const [changed] = await batch(context.db, (tx) => [
    update,
    insertGuardedCycleVersion(context, {
      ...input.aggregate.version,
      id: crypto.randomUUID(),
      version: nextVersion,
      applicantGuidance: guidance,
      closesAt,
      changeType: input.changeType,
      changeReason: input.reason,
      changedByUserId: input.actorUserId,
      createdAt: input.now,
    }),
    ...copyPolicyForward(tx, input.aggregate.head.id, input.expectedVersion, nextVersion, input.now),
    tx.insert(sebProgrammeCycleEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.aggregate.head.id}, ${input.changeType},
        ${input.actorUserId}, ${input.message}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
          AND ${sebProgrammeCycleVersion.createdAt} = ${input.now}
      )
    `),
    insertAuditEventWhere(tx, adminAudit(context, {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: input.aggregate.head.id,
      payload: {
        version: nextVersion,
        reason: auditReason(input.reason),
        // Present only when the closing time is what changed; the guidance
        // text itself is never copied — it lives on the version row.
        closesAt: input.closesAt === undefined ? undefined : input.closesAt?.toISOString() ?? null,
      },
      now: input.now,
    }), sql`EXISTS (
      SELECT 1 FROM ${sebProgrammeCycleVersion}
      WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
        AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
        AND ${sebProgrammeCycleVersion.createdAt} = ${input.now}
    )`),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const setDraftCycleDeleted = async (
  context: AdminOperationContext,
  input: {
    id: string
    expectedVersion: number
    deleted: boolean
    reason: string | null
    actorUserId: string
    now: Date
  },
): Promise<boolean> => {
  const updated = context.db
    .update(sebProgrammeCycle)
    .set({
      deletedAt: input.deleted ? input.now : null,
      deletedByUserId: input.deleted ? input.actorUserId : null,
      deleteReason: input.deleted ? input.reason : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.id),
        eq(sebProgrammeCycle.status, 'DRAFT'),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        input.deleted
          ? isNull(sebProgrammeCycle.deletedAt)
          : sql`${sebProgrammeCycle.deletedAt} IS NOT NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${sebApplication}
          WHERE ${sebApplication.programmeCycleId} = ${input.id}
        )`,
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  const [changed] = await batch(context.db, (tx) => [
    updated,
    insertAuditEventWhere(tx, adminAudit(context, {
      actorUserId: input.actorUserId,
      action: input.deleted ? 'SEB.CYCLE_DELETED' : 'SEB.CYCLE_RESTORED',
      entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: input.id,
      payload: { reason: input.deleted && input.reason ? auditReason(input.reason) : undefined },
      now: input.now,
    }), sql`EXISTS (
      SELECT 1 FROM ${sebProgrammeCycle}
      WHERE ${sebProgrammeCycle.id} = ${input.id}
        AND ${sebProgrammeCycle.updatedAt} = ${input.now}
    )`),
  ])
  return Array.isArray(changed) && changed.length === 1
}

/** Finds a small deterministic closing batch; later cron runs continue. */
export const findExpiredOpenCycles = async (db: Database, now: Date) => db
  .select({ id: sebProgrammeCycle.id })
  .from(sebProgrammeCycle)
  .where(
    and(
      eq(sebProgrammeCycle.status, 'OPEN'),
      isNull(sebProgrammeCycle.deletedAt),
      lt(sebProgrammeCycle.closesAt, now),
    ),
  )
  .orderBy(asc(sebProgrammeCycle.closesAt), asc(sebProgrammeCycle.id))
  .limit(20)
