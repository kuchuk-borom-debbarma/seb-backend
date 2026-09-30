/** Thin GraphQL delegation for the administrative namespace. */
import { resolveFormTemplate } from '../../../services/application/form/template'
import {
  addFormQuestion,
  addFormStage,
  removeFormQuestion,
  putFormGroupDefinition,
  removeFormGroupDefinition,
  definitionsOf,
  removeFormStage,
  replaceFormTemplate,
  updateFormQuestion,
  updateFormStage,
} from '../../../services/admin/controllers/form-template'

/** Which cycle, at which version, and why — the same on every form mutation. */
type FormScope = { programmeCycleId: string; expectedVersion: number; reason: string }

import {
  analyticsSummary,
  addInternalNote,
  adminDocumentDownloadUrl,
  archiveProgrammeCycle,
  changeOpenCycleClosingTime,
  closeProgrammeCycle,
  createProgrammeCycle,
  cyclePolicyDownloadUrl,
  finalizeCyclePolicyUpload,
  intakeByReference,
  intakeQueue,
  intakeWorkspace,
  issueCyclePolicyUpload,
  openProgrammeCycle,
  programmeCycleApplicationCounts,
  programmeCycleById,
  programmeCycleEvents,
  programmeCycles,
  setProgrammeCycleDeleted,
  updateDraftProgrammeCycleController,
  updateOpenCycleGuidance,
} from '../../../services/admin'
import {
  announcementBoard,
  createAnnouncementController,
  updateAnnouncementController,
  setAnnouncementPublishedController,
  removeAnnouncementController,
  reorderAnnouncementsController,
} from '../../../services/announcement'
import {
  findCyclePolicyDocument,
  listCyclePolicyDocumentVersions,
} from '../../../services/admin/queries/policy-document'
import type { GraphQLContext } from '../../types'
import { pipelineVersionKey } from '../../../loaders'
import { snapshotRecordToPublic } from '../../../services/application/queries/application'
import type { ProgrammeCycleAggregate } from '../../../services/admin/queries/programme-cycle'

type Args<T> = { input: T }

/** The columns of a queue row its name resolvers read. */
type QueueRow = {
  pipelineId: string
  pipelineVersion: number
  currentStageKey: string | null
  statusFlags: string[]
}

const definitionOf = (row: QueueRow, context: GraphQLContext) =>
  context.loaders.pipelineDefinition.load(pipelineVersionKey(row.pipelineId, row.pipelineVersion))

type CycleInput = Parameters<typeof createProgrammeCycle>[0]
type KindInput = CycleInput['policy']['applicationKinds'][number]

/** A cycle as the wire carries it: each kind rule's parameters as JSON text. */
type WireCycle = Omit<CycleInput, 'policy'> & {
  policy: Omit<CycleInput['policy'], 'applicationKinds'> & {
    applicationKinds: Array<Omit<KindInput, 'rules'> & {
      rules: Array<{ ruleType: KindInput['rules'][number]['ruleType']; paramsJson: string }>
    }>
  }
}

/** The longest parameter text read at all; the controller bounds the object. */
const MAX_PARAMS_JSON = 8192

/*
 * Text that is not one JSON object becomes `null`, which every rule's
 * parameter schema refuses — so malformed settings reach the officer as the
 * controller's sentence naming the kind and rule, not as a parse error.
 */
const paramsOf = (text: string): Record<string, unknown> | null => {
  if (text.length > MAX_PARAMS_JSON) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

const fromWire = (cycle: WireCycle): CycleInput => ({
  ...cycle,
  policy: {
    ...cycle.policy,
    applicationKinds: cycle.policy.applicationKinds.map((kind) => ({
      ...kind,
      rules: kind.rules.map((rule) => ({
        ruleType: rule.ruleType,
        params: paramsOf(rule.paramsJson),
      })),
    })),
  },
})

export const adminResolvers = {
  Query: { admin: () => ({}) },
  Mutation: { admin: () => ({}) },
  AdminQuery: {
    programmeCycle: () => ({}),
    intake: () => ({}),
    analytics: () => ({}),
    announcement: () => ({}),
  },
  AdminAnalyticsQuery: {
    summary: (_parent: unknown, args: { input?: Parameters<typeof analyticsSummary>[0] }, context: GraphQLContext) => analyticsSummary(args.input ?? {}, context),
  },
  AdminMutation: {
    programmeCycle: () => ({}),
    formTemplate: () => ({}),
    intake: () => ({}),
    announcement: () => ({}),
  },
  AdminAnnouncementQuery: {
    board: (_parent: unknown, _args: unknown, context: GraphQLContext) => announcementBoard(context),
  },
  AdminAnnouncementMutation: {
    create: (_parent: unknown, args: { input: Parameters<typeof createAnnouncementController>[0] }, context: GraphQLContext) => createAnnouncementController(args.input, context),
    update: (_parent: unknown, args: { id: string; expectedVersion: number; input: Parameters<typeof createAnnouncementController>[0] }, context: GraphQLContext) => updateAnnouncementController({ ...args.input, id: args.id, expectedVersion: args.expectedVersion }, context),
    setPublished: (_parent: unknown, args: { id: string; expectedVersion: number; published: boolean; reason?: string | null }, context: GraphQLContext) => setAnnouncementPublishedController(args, context),
    remove: (_parent: unknown, args: { id: string; expectedVersion: number; reason: string }, context: GraphQLContext) => removeAnnouncementController(args, context),
    reorder: (_parent: unknown, args: { ids: string[]; expectedBoardVersion: number }, context: GraphQLContext) => reorderAnnouncementsController(args, context),
  },
  AdminProgrammeCycleQuery: {
    list: (_parent: unknown, args: Parameters<typeof programmeCycles>[0], context: GraphQLContext) => programmeCycles(args, context),
    byId: (_parent: unknown, args: { id: string }, context: GraphQLContext) => programmeCycleById(args.id, context),
    policyDocumentDownloadUrl: (_parent: unknown, args: { cycleId: string; version?: number | null }, context: GraphQLContext) => cyclePolicyDownloadUrl(args, context),
    counts: (_parent: unknown, args: { id: string }, context: GraphQLContext) => programmeCycleApplicationCounts(args.id, context),
    events: (_parent: unknown, args: { id: string; first?: number }, context: GraphQLContext) => programmeCycleEvents(args, context),
  },
  AdminIntakeQuery: {
    queue: (_parent: unknown, args: { input?: Parameters<typeof intakeQueue>[0] }, context: GraphQLContext) => intakeQueue(args.input ?? {}, context),
    byReference: (_parent: unknown, args: { referenceNumber: string }, context: GraphQLContext) => intakeByReference(args.referenceNumber, context),
    workspace: (_parent: unknown, args: { applicationId: string }, context: GraphQLContext) => intakeWorkspace(args.applicationId, context),
    documentDownloadUrl: (_parent: unknown, args: { applicationId: string; submissionDocumentId: string }, context: GraphQLContext) => adminDocumentDownloadUrl(args, context),
  },
  /*
   * Every one of these takes the same scope — which cycle, at which version,
   * why — flattened into the controller's input, because the service layer
   * does not know about GraphQL's shapes and should not learn.
   */
  AdminFormTemplateMutation: {
    replace: (
      _parent: unknown,
      args: Args<{ scope: FormScope; template: unknown }>,
      context: GraphQLContext,
    ) => replaceFormTemplate(
      { ...args.input.scope, template: args.input.template as never }, context,
    ),
    addStage: (
      _parent: unknown,
      args: Args<{ scope: FormScope; stage: unknown }>,
      context: GraphQLContext,
    ) => addFormStage({ ...args.input.scope, stage: args.input.stage as never }, context),
    updateStage: (
      _parent: unknown,
      args: Args<{ scope: FormScope; stage: unknown }>,
      context: GraphQLContext,
    ) => updateFormStage({ ...args.input.scope, stage: args.input.stage as never }, context),
    removeStage: (
      _parent: unknown,
      args: Args<{ scope: FormScope; stageKey: string }>,
      context: GraphQLContext,
    ) => removeFormStage({ ...args.input.scope, stageKey: args.input.stageKey }, context),
    addQuestion: (
      _parent: unknown,
      args: Args<{ scope: FormScope; field: unknown; options?: unknown; conditions?: unknown }>,
      context: GraphQLContext,
    ) => addFormQuestion({
      ...args.input.scope,
      field: args.input.field as never,
      options: args.input.options as never,
      conditions: args.input.conditions as never,
    }, context),
    updateQuestion: (
      _parent: unknown,
      args: Args<{ scope: FormScope; field: unknown; options?: unknown; conditions?: unknown }>,
      context: GraphQLContext,
    ) => updateFormQuestion({
      ...args.input.scope,
      field: args.input.field as never,
      options: args.input.options as never,
      conditions: args.input.conditions as never,
    }, context),
    removeQuestion: (
      _parent: unknown,
      args: Args<{ scope: FormScope; fieldKey: string }>,
      context: GraphQLContext,
    ) => removeFormQuestion({ ...args.input.scope, fieldKey: args.input.fieldKey }, context),
    putGroupDefinition: (
      _parent: unknown,
      args: Args<{ scope: FormScope; definition: unknown }>,
      context: GraphQLContext,
    ) => putFormGroupDefinition(
      { ...args.input.scope, definition: args.input.definition as never },
      context,
    ),
    removeGroupDefinition: (
      _parent: unknown,
      args: Args<{ scope: FormScope; definitionKey: string }>,
      context: GraphQLContext,
    ) => removeFormGroupDefinition(
      { ...args.input.scope, definitionKey: args.input.definitionKey },
      context,
    ),
  },
  AdminProgrammeCycleMutation: {
    create: (_parent: unknown, args: Args<WireCycle>, context: GraphQLContext) => createProgrammeCycle(fromWire(args.input), context),
    updateDraft: (_parent: unknown, args: Args<{ id: string; expectedVersion: number; reason: string; cycle: WireCycle }>, context: GraphQLContext) => updateDraftProgrammeCycleController({ ...fromWire(args.input.cycle), id: args.input.id, expectedVersion: args.input.expectedVersion, reason: args.input.reason }, context),
    open: (_parent: unknown, args: Args<Parameters<typeof openProgrammeCycle>[0]>, context: GraphQLContext) => openProgrammeCycle(args.input, context),
    issuePolicyDocumentUpload: (_parent: unknown, args: Args<Parameters<typeof issueCyclePolicyUpload>[0]>, context: GraphQLContext) => issueCyclePolicyUpload(args.input, context),
    finalizePolicyDocumentUpload: (_parent: unknown, args: Args<{ uploadId: string }>, context: GraphQLContext) => finalizeCyclePolicyUpload(args.input.uploadId, context),
    updateOpenGuidance: (_parent: unknown, args: Args<Parameters<typeof updateOpenCycleGuidance>[0]>, context: GraphQLContext) => updateOpenCycleGuidance(args.input, context),
    changeClosingTime: (_parent: unknown, args: Args<Parameters<typeof changeOpenCycleClosingTime>[0]>, context: GraphQLContext) => changeOpenCycleClosingTime(args.input, context),
    close: (_parent: unknown, args: Args<Parameters<typeof closeProgrammeCycle>[0]>, context: GraphQLContext) => closeProgrammeCycle(args.input, context),
    archive: (_parent: unknown, args: Args<Parameters<typeof archiveProgrammeCycle>[0]>, context: GraphQLContext) => archiveProgrammeCycle(args.input, context),
    softDeleteDraft: (_parent: unknown, args: Args<{ id: string; expectedVersion: number; reason: string }>, context: GraphQLContext) => setProgrammeCycleDeleted(args.input, context, true),
    restoreDraft: (_parent: unknown, args: { id: string; expectedVersion: number }, context: GraphQLContext) => setProgrammeCycleDeleted({ ...args, reason: '' }, context, false),
  },
  AdminIntakeMutation: {
    addInternalNote: (_parent: unknown, args: Args<Parameters<typeof addInternalNote>[0]>, context: GraphQLContext) => addInternalNote(args.input, context),
  },
  /*
   * Resolved from the cycle's own rows on read, rather than stored resolved.
   * The workspace does the same for an application; both go through
   * `resolveFormTemplate`, so what an officer edits and what an applicant is
   * asked can never be two different readings of the same rows.
   */
  AdminCycleAggregate: {
    /*
     * Lifted off the version row, which is where a cycle's rules live — the
     * head carries its identity and its window and nothing about eligibility.
     *
     * Named field by field rather than spread, so a column added to the version
     * is a deliberate decision to publish it. A version row also carries the
     * change reason and who made it, and those belong to the event history
     * rather than to a policy a client renders as form fields.
     */
    policy: (parent: { version: Record<string, unknown> }) => ({
      minimumApplicantAge: parent.version.minimumApplicantAge,
      maximumApplicantAge: parent.version.maximumApplicantAge,
      categoryAMaximumMonths: parent.version.categoryAMaximumMonths,
      majorityOwnershipRequired: parent.version.majorityOwnershipRequired,
      jurisdiction: parent.version.jurisdiction,
      fundingCeilingState: parent.version.fundingCeilingState,
      fundingCeilingAmountPaise: parent.version.fundingCeilingAmountPaise,
      fundingCeilingScope: parent.version.fundingCeilingScope,
      pipelineId: parent.version.pipelineId,
      pipelineVersion: parent.version.pipelineVersion,
    }),
    formRules: (parent: Pick<ProgrammeCycleAggregate, 'formRules' | 'formRuleOperands'>) =>
      parent.formRules.map((rule) => ({
        ...rule,
        operands: parent.formRuleOperands.filter((operand) => operand.ruleKey === rule.ruleKey),
      })),
    applicationKinds: (
      parent: Pick<ProgrammeCycleAggregate, 'applicationKinds' | 'applicationKindRules'>,
    ) => parent.applicationKinds.map((kind) => ({
      ...kind,
      rules: parent.applicationKindRules
        .filter((rule) => rule.kindKey === kind.kindKey)
        .map((rule) => ({ ruleType: rule.ruleType, paramsJson: JSON.stringify(rule.params) })),
    })),
    groupDefinitions: (parent: Parameters<typeof definitionsOf>[0]) =>
      definitionsOf(parent),
    formTemplate: (parent: {
      head: { id: string; currentVersion: number }
      formStages: unknown[]
      formFields: unknown[]
      formFieldOptions: unknown[]
      formFieldConditions: unknown[]
    } & Pick<ProgrammeCycleAggregate, 'formRules' | 'formRuleOperands'>) => resolveFormTemplate({
      programmeCycleId: parent.head.id,
      programmeCycleVersion: parent.head.currentVersion,
      stages: parent.formStages as never,
      fields: parent.formFields as never,
      options: parent.formFieldOptions as never,
      conditions: parent.formFieldConditions as never,
      rules: parent.formRules.map((rule) => ({
        ruleKey: rule.ruleKey,
        ruleType: rule.ruleType,
        stageKey: rule.stageKey,
        message: rule.message,
        limitValue: rule.limitValue,
        operandKeys: parent.formRuleOperands
          .filter((operand) => operand.ruleKey === rule.ruleKey)
          .sort((a, b) => a.position - b.position)
          .map((operand) => operand.fieldKey),
      })),
    }),
    // Read here rather than folded into `loadProgrammeCycle`: the document
    // lives beside the cycle, not inside its versioned rule set, and only the
    // screens that select this field pay for the extra reads.
    policyDocument: async (
      parent: { head: { id: string } },
      _args: unknown,
      context: GraphQLContext,
    ) => {
      const current = await findCyclePolicyDocument(context.db, parent.head.id)
      if (!current) return null
      const versions = await listCyclePolicyDocumentVersions(context.db, parent.head.id)
      return {
        id: current.head.id,
        currentVersion: current.head.currentVersion,
        originalFilename: current.version.originalFilename,
        sizeBytes: current.version.sizeBytes,
        uploadedAt: current.version.createdAt,
        scanStatus: current.scanStatus,
        versions: versions.map((version) => ({
          version: version.version,
          operation: version.operation,
          originalFilename: version.originalFilename,
          sizeBytes: version.sizeBytes,
          uploadedAt: version.createdAt,
          scanStatus: version.scanStatus,
        })),
      }
    },
  },
  /*
   * Names from the version each row is worked in. A page spans versions, so
   * each row asks the per-request loader, which reads every version the page
   * names in one statement and parses each once.
   */
  AdminApplicationQueueItem: {
    stageName: async (parent: QueueRow, _args: unknown, context: GraphQLContext) => {
      if (parent.currentStageKey === null) return null
      const definition = await definitionOf(parent, context)
      return definition?.stages.find((stage) => stage.key === parent.currentStageKey)?.name ?? null
    },
    flags: async (parent: QueueRow, _args: unknown, context: GraphQLContext) => {
      const definition = await definitionOf(parent, context)
      return parent.statusFlags.map((key) => ({
        key,
        label: definition?.statusFlags.find((flag) => flag.key === key)?.label ?? key,
      }))
    },
  },
  AdminWorkspace: {
    notes: (parent: { internalNotes?: unknown[] }) => parent.internalNotes ?? [],
    snapshots: (parent: {
      snapshots: Array<Parameters<typeof snapshotRecordToPublic>[0]
        & { answers: Parameters<typeof snapshotRecordToPublic>[1] }>
    }) => parent.snapshots.map((snapshot) => snapshotRecordToPublic(snapshot, snapshot.answers)),
    documents: (parent: { documents: Array<{ pin: Record<string, unknown>; file: Record<string, unknown> }> }) =>
      parent.documents.map(({ pin, file }) => ({ ...pin, ...file, id: pin.id })),
  },
}
