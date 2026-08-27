/**
 * Guarded persistence for programme cycles and their pinned policy versions.
 *
 * A policy snapshot is inserted only after the guarded head reached the version
 * it belongs to, and the dependent document, assessment, and reason rows stay
 * in the same D1 batch — if the head update loses a race their version foreign
 * key fails and the whole batch rolls back.
 *
 * Normalized rows are written one prepared statement at a time because D1 has a
 * low bind-variable ceiling that a single large multi-row INSERT can exceed.
 */
import { and, asc, count, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import {
  coreAuditEvent,
  sebApplication,
  sebProgrammeCycle,
  sebProgrammeCycleAssessmentRule,
  sebProgrammeCycleIdentifierRule,
  sebProgrammeCycleEvent,
  sebProgrammeCycleReason,
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
import type { AdminAuditAction } from '../support'
import type {
  AdminOperationContext,
  PageInfo,
  ProgrammeCycleInput,
} from '../types'
import { adminAudit } from '../support'
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
  identifierRules: Array<typeof sebProgrammeCycleIdentifierRule.$inferSelect>
  assessmentRules: Array<typeof sebProgrammeCycleAssessmentRule.$inferSelect>
  reasons: Array<typeof sebProgrammeCycleReason.$inferSelect>
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
    identifierRules, assessmentRules, reasons] = await batch(db, (tx) => [
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
    // Joins the batch rather than costing its own call: single-table, so the
    // by-name mapping a batch does is safe here. Built from `tx` like the rest
    // — see `Transaction`: with one client per request the outer handle would
    // work too, and that is exactly why it must not be relied on here.
    tx
      .select()
      .from(sebProgrammeCycleIdentifierRule)
      .where(
        and(
          eq(sebProgrammeCycleIdentifierRule.programmeCycleId, id),
          eq(sebProgrammeCycleIdentifierRule.programmeCycleVersion, row.head.currentVersion),
        ),
      ),
    tx
      .select()
      .from(sebProgrammeCycleAssessmentRule)
      .where(
        and(
          eq(sebProgrammeCycleAssessmentRule.programmeCycleId, id),
          eq(sebProgrammeCycleAssessmentRule.programmeCycleVersion, row.head.currentVersion),
        ),
      ),
    tx
      .select()
      .from(sebProgrammeCycleReason)
      .where(
        and(
          eq(sebProgrammeCycleReason.programmeCycleId, id),
          eq(sebProgrammeCycleReason.programmeCycleVersion, row.head.currentVersion),
        ),
      ),
  ])
  return {
    ...row,
    formStages, formFields, formFieldOptions, formFieldConditions,
    groupDefinitions, groupDefinitionMembers, groupDefinitionMemberOptions,
    identifierRules, assessmentRules, reasons,
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
  policyReference: input.policyReference ?? null,
  applicantGuidance: input.applicantGuidance ?? null,
  partnerBankGuidance: input.partnerBankGuidance ?? null,
  status,
  opensAt: input.opensAt ?? null,
  closesAt: input.closesAt ?? null,
  minimumApplicantAge: input.policy.minimumApplicantAge,
  maximumApplicantAge: input.policy.maximumApplicantAge,
  categoryAMaximumMonths: input.policy.categoryAMaximumMonths,
  expansionWaitMonths: input.policy.expansionWaitMonths,
  majorityOwnershipRequired: input.policy.majorityOwnershipRequired,
  jurisdiction: input.policy.jurisdiction,
  fundingCeilingState: input.policy.fundingCeilingState,
  fundingCeilingAmountPaise: input.policy.fundingCeilingAmountPaise,
  fundingCeilingScope: input.policy.fundingCeilingScope,
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
  /*
   * Absent means the cycle configures none, which demands nothing and compares
   * nothing. That is what leaves cycles created before these rules existed
   * working exactly as they did.
   */
  identifierRules: (input.policy.identifierRules ?? []).map((rule) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    kind: rule.kind,
    requirement: rule.requirement,
    duplicatePolicy: rule.duplicatePolicy,
    // Only a rule that demands something needs to name the check it belongs
    // to; the CHECK constraint enforces the same pairing in the database.
    checkType: rule.requirement === 'REQUIRED_ON_PASS' ? rule.checkType : null,
    createdAt: now,
  })),
  assessmentRules: input.policy.requiredAssessmentTypes.map((assessmentType) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    assessmentType,
    requiredOutcome: 'PASSED' as const,
    createdAt: now,
  })),
  reasons: input.policy.reasons.map((reason) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    context: reason.context,
    code: reason.code,
    label: reason.label,
    applicantMessageTemplate: reason.applicantMessageTemplate ?? null,
    createdAt: now,
  })),
})

/** Inserts a policy snapshot only after the guarded head reached that version. */
const insertGuardedCycleVersion = (
  context: AdminOperationContext,
  value: typeof sebProgrammeCycleVersion.$inferInsert,
) => context.db.insert(sebProgrammeCycleVersion).select(sql`
  SELECT ${value.id}, ${value.programmeCycleId}, ${value.version}, ${value.cycleCode},
    ${value.displayName}, ${value.cycleYear}, ${value.policyReference},
    ${value.applicantGuidance}, ${value.partnerBankGuidance}, ${value.status},
    ${value.opensAt ? value.opensAt : null},
    ${value.closesAt ? value.closesAt : null},
    ${value.minimumApplicantAge}, ${value.maximumApplicantAge},
    ${value.categoryAMaximumMonths}, ${value.expansionWaitMonths},
    ${value.majorityOwnershipRequired}, ${value.jurisdiction},
    ${value.fundingCeilingState}, ${value.fundingCeilingAmountPaise},
    ${value.fundingCeilingScope}, ${value.changeType}, ${value.changeReason},
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
    action: 'SEB.CYCLE_CREATED' as AdminAuditAction,
    entityType: 'SEB_PROGRAMME_CYCLE',
    entityId: id,
    now,
  })
  const statements = (tx: Transaction) => [
    tx.insert(sebProgrammeCycle).values({
      id,
      cycleCode: input.cycleCode,
      displayName: input.displayName,
      cycleYear: input.cycleYear,
      policyReference: input.policyReference ?? null,
      applicantGuidance: input.applicantGuidance ?? null,
      partnerBankGuidance: input.partnerBankGuidance ?? null,
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
    /*
     * One multi-row insert per table, not one statement per row.
     *
     * Each statement in the batch is its own round trip to Postgres, and a
     * real template is over a hundred rows — per-row inserts made creating a
     * cycle a twenty-second wait from a deployed Worker to a remote database.
     * Postgres takes 65535 bind parameters, far above any guarded template.
     * Empty tables are skipped: drizzle refuses `.values([])`.
     */
    ...[
      policy.formStages.length
        ? tx.insert(sebProgrammeCycleFormStage).values(policy.formStages) : null,
      policy.formFields.length
        ? tx.insert(sebProgrammeCycleFormField).values(policy.formFields) : null,
      policy.formFieldOptions.length
        ? tx.insert(sebProgrammeCycleFormFieldOption).values(policy.formFieldOptions) : null,
      policy.formFieldConditions.length
        ? tx.insert(sebProgrammeCycleFormFieldCondition).values(policy.formFieldConditions)
        : null,
      // Definitions after their derived rows exist is fine either way — nothing
      // references across; they are copied forward with the seven rule tables.
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
      policy.identifierRules.length
        ? tx.insert(sebProgrammeCycleIdentifierRule).values(policy.identifierRules) : null,
      policy.assessmentRules.length
        ? tx.insert(sebProgrammeCycleAssessmentRule).values(policy.assessmentRules) : null,
      policy.reasons.length
        ? tx.insert(sebProgrammeCycleReason).values(policy.reasons) : null,
    ].filter((statement) => statement !== null),
    tx.insert(coreAuditEvent).values(audit),
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
      policyReference: input.policyReference ?? null,
      applicantGuidance: input.applicantGuidance ?? null,
      partnerBankGuidance: input.partnerBankGuidance ?? null,
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
    // One multi-row insert per table — see the same shape at creation; each
    // statement is a round trip, and a draft revision rewrites every table.
    ...[
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
      policy.identifierRules.length
        ? tx.insert(sebProgrammeCycleIdentifierRule).values(policy.identifierRules) : null,
      policy.assessmentRules.length
        ? tx.insert(sebProgrammeCycleAssessmentRule).values(policy.assessmentRules) : null,
      policy.reasons.length
        ? tx.insert(sebProgrammeCycleReason).values(policy.reasons) : null,
    ].filter((statement) => statement !== null),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${actorUserId}, 'SEB.CYCLE_UPDATED',
        'SEB_PROGRAMME_CYCLE', ${input.id}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
          AND ${sebProgrammeCycleVersion.createdAt} = ${now}
      )
    `),
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
    action: AdminAuditAction
    actorUserId: string | null
    now: Date
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
    insertGuardedCycleVersion(context, {
      ...base,
      id: crypto.randomUUID(),
      version: nextVersion,
      status: input.toStatus,
      changeType: input.changeType,
      changeReason: input.reason,
      changedByUserId: input.actorUserId,
      createdAt: input.now,
    }),
    /*
     * The form, carried forward whole.
     *
     * **Four statements, and every one of them matters.** A rule table that is
     * not copied here empties itself the first time a cycle changes version —
     * and for these that does not lose a document rule, it loses *the entire
     * application form for every draft in that cycle*, at the moment a cycle is
     * opened or its guidance is edited. Worse, stages emptying makes fields
     * fail their stage key on the *next* bump, so the damage surfaces one
     * version after its cause.
     *
     * Stages before fields, because a field's key points at one; options and
     * conditions after fields for the same reason.
     *
     * `gen_random_uuid()` rather than a minted prefix throughout, the three
     * older rule tables included: the old scheme grew ids by 37 characters on
     * every version bump and existed only because the previous engine had no
     * UUID function. It also gave every row copied in one statement the same
     * prefix, so the ids of a version were only unique across versions by
     * construction rather than by being random.
     */
    tx.insert(sebProgrammeCycleFormStage).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        stage_key, title, description, icon_name, estimated_minutes,
        sort_order, ${input.now}
      FROM ${sebProgrammeCycleFormStage}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormField).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        stage_key, field_key, field_type, role, parent_field_key, parent_field_type,
        group_definition_key,
        sort_order, label, help_text,
        placeholder, note, tone, width_hint, prefix_text, suffix_text,
        autocomplete_hint, show_char_count, textarea_rows, choice_style,
        requirement, source, repeat_min, repeat_max,
        min_length, max_length, pattern, pattern_message, min_value, max_value,
        min_date, max_date, relative_date_bound, max_file_bytes, ${input.now}
      FROM ${sebProgrammeCycleFormField}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormFieldOption).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        field_key, field_type, option_value, option_label,
        option_description, icon_name, sort_order, ${input.now}
      FROM ${sebProgrammeCycleFormFieldOption}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormFieldCondition).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        field_key, effect, group_number, sequence_number, source_field_key,
        source_field_type, operator, comparison_value, ${input.now}
      FROM ${sebProgrammeCycleFormFieldCondition}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinition).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        definition_key, label, ${input.now}
      FROM ${sebProgrammeCycleFormGroupDefinition}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinitionMember).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        definition_key, member_key, field_type, role, sort_order, label,
        help_text, placeholder, note, tone, width_hint, prefix_text,
        suffix_text, autocomplete_hint, show_char_count, textarea_rows,
        choice_style, requirement, min_length, max_length, pattern,
        pattern_message, min_value, max_value, min_date, max_date,
        relative_date_bound, ${input.now}
      FROM ${sebProgrammeCycleFormGroupDefinitionMember}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinitionMemberOption).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        definition_key, member_key, option_value, option_label,
        option_description, icon_name, sort_order, ${input.now}
      FROM ${sebProgrammeCycleFormGroupDefinitionMemberOption}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    // Carried forward with the others. A rule table that is not copied here
    // silently empties itself the first time a cycle changes version, which is
    // the moment it is least likely to be noticed.
    tx.insert(sebProgrammeCycleIdentifierRule).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        kind, requirement, duplicate_policy, check_type, ${input.now}
      FROM ${sebProgrammeCycleIdentifierRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleAssessmentRule).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        assessment_type, required_outcome, ${input.now}
      FROM ${sebProgrammeCycleAssessmentRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleReason).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        context, code, label, applicant_message_template, ${input.now}
      FROM ${sebProgrammeCycleReason}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
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
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, ${input.action},
        'SEB_PROGRAMME_CYCLE', ${input.aggregate.head.id}, 'SUCCESS', NULL,
        NULL, NULL, NULL, ${JSON.stringify({ status: input.toStatus })},
        ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
          AND ${sebProgrammeCycleVersion.createdAt} = ${input.now}
      )
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const reviseOpenProgrammeCycle = async (
  context: AdminOperationContext,
  input: {
    aggregate: ProgrammeCycleAggregate
    expectedVersion: number
    applicantGuidance?: string
    partnerBankGuidance?: string
    /** Undefined keeps the stored time; null removes it. */
    closesAt?: Date | null
    changeType: 'GUIDANCE_CHANGED' | 'CLOSING_CHANGED'
    reason: string
    message: string
    action: AdminAuditAction
    actorUserId: string
    now: Date
  },
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const guidance = input.applicantGuidance ?? input.aggregate.head.applicantGuidance
  const bankGuidance = input.partnerBankGuidance ?? input.aggregate.head.partnerBankGuidance
  const closesAt = input.closesAt === undefined ? input.aggregate.head.closesAt : input.closesAt
  const update = context.db
    .update(sebProgrammeCycle)
    .set({
      applicantGuidance: guidance,
      partnerBankGuidance: bankGuidance,
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
      partnerBankGuidance: bankGuidance,
      closesAt,
      changeType: input.changeType,
      changeReason: input.reason,
      changedByUserId: input.actorUserId,
      createdAt: input.now,
    }),
    /*
     * The form, carried forward whole.
     *
     * **Four statements, and every one of them matters.** A rule table that is
     * not copied here empties itself the first time a cycle changes version —
     * and for these that does not lose a document rule, it loses *the entire
     * application form for every draft in that cycle*, at the moment a cycle is
     * opened or its guidance is edited. Worse, stages emptying makes fields
     * fail their stage key on the *next* bump, so the damage surfaces one
     * version after its cause.
     *
     * Stages before fields, because a field's key points at one; options and
     * conditions after fields for the same reason.
     *
     * `gen_random_uuid()` rather than a minted prefix throughout, the three
     * older rule tables included: the old scheme grew ids by 37 characters on
     * every version bump and existed only because the previous engine had no
     * UUID function. It also gave every row copied in one statement the same
     * prefix, so the ids of a version were only unique across versions by
     * construction rather than by being random.
     */
    tx.insert(sebProgrammeCycleFormStage).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        stage_key, title, description, icon_name, estimated_minutes,
        sort_order, ${input.now}
      FROM ${sebProgrammeCycleFormStage}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormField).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        stage_key, field_key, field_type, role, parent_field_key, parent_field_type,
        group_definition_key,
        sort_order, label, help_text,
        placeholder, note, tone, width_hint, prefix_text, suffix_text,
        autocomplete_hint, show_char_count, textarea_rows, choice_style,
        requirement, source, repeat_min, repeat_max,
        min_length, max_length, pattern, pattern_message, min_value, max_value,
        min_date, max_date, relative_date_bound, max_file_bytes, ${input.now}
      FROM ${sebProgrammeCycleFormField}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormFieldOption).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        field_key, field_type, option_value, option_label,
        option_description, icon_name, sort_order, ${input.now}
      FROM ${sebProgrammeCycleFormFieldOption}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormFieldCondition).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        field_key, effect, group_number, sequence_number, source_field_key,
        source_field_type, operator, comparison_value, ${input.now}
      FROM ${sebProgrammeCycleFormFieldCondition}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinition).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        definition_key, label, ${input.now}
      FROM ${sebProgrammeCycleFormGroupDefinition}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinitionMember).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        definition_key, member_key, field_type, role, sort_order, label,
        help_text, placeholder, note, tone, width_hint, prefix_text,
        suffix_text, autocomplete_hint, show_char_count, textarea_rows,
        choice_style, requirement, min_length, max_length, pattern,
        pattern_message, min_value, max_value, min_date, max_date,
        relative_date_bound, ${input.now}
      FROM ${sebProgrammeCycleFormGroupDefinitionMember}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleFormGroupDefinitionMemberOption).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        definition_key, member_key, option_value, option_label,
        option_description, icon_name, sort_order, ${input.now}
      FROM ${sebProgrammeCycleFormGroupDefinitionMemberOption}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    // Carried forward with the others. A rule table that is not copied here
    // silently empties itself the first time a cycle changes version, which is
    // the moment it is least likely to be noticed.
    tx.insert(sebProgrammeCycleIdentifierRule).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        kind, requirement, duplicate_policy, check_type, ${input.now}
      FROM ${sebProgrammeCycleIdentifierRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleAssessmentRule).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        assessment_type, required_outcome, ${input.now}
      FROM ${sebProgrammeCycleAssessmentRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    tx.insert(sebProgrammeCycleReason).select(sql`
      SELECT gen_random_uuid()::text, programme_cycle_id, ${nextVersion},
        context, code, label, applicant_message_template, ${input.now}
      FROM ${sebProgrammeCycleReason}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
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
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, ${input.action},
        'SEB_PROGRAMME_CYCLE', ${input.aggregate.head.id}, 'SUCCESS', NULL,
        NULL, NULL, NULL, NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
          AND ${sebProgrammeCycleVersion.createdAt} = ${input.now}
      )
    `),
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
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId},
        ${input.deleted ? 'SEB.CYCLE_DELETED' : 'SEB.CYCLE_RESTORED'},
        'SEB_PROGRAMME_CYCLE', ${input.id}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycle}
        WHERE ${sebProgrammeCycle.id} = ${input.id}
          AND ${sebProgrammeCycle.updatedAt} = ${input.now}
      )
    `),
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
