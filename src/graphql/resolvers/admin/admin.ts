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
  cancelRecoveryCase,
  addInternalNote,
  adminDocumentDownloadUrl,
  archiveProgrammeCycle,
  changeFundingAward,
  cancelRevisionRequest,
  changeOpenCycleClosingTime,
  cancelBankReferral,
  closeProgrammeCycle,
  closeRecoveryCase,
  completeDeskReview,
  correctBankOutcome,
  correctDecision,
  createFundingAward,
  createProgrammeCycle,
  cyclePolicyDownloadUrl,
  finalizeCyclePolicyUpload,
  fundingByApplication,
  intakeByReference,
  intakeQueue,
  intakeQueues,
  intakeWorkspace,
  issueCyclePolicyUpload,
  openProgrammeCycle,
  openRecoveryCase,
  programmeCycleApplicationCounts,
  programmeCycleById,
  programmeCycleEvents,
  programmeCycles,
  recordBankOutcome,
  recordFundingAssessment,
  recordFundingRelease,
  recordRecoveryEntry,
  recordDecision,
  recoveryById,
  referApplicationToBank,
  reverseFundingRelease,
  setProgrammeCycleDeleted,
  startDeskReview,
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
import type { StaffMember } from '../../../loaders'
import type { GraphQLContext } from '../../types'
import { snapshotRecordToPublic } from '../../../services/application/queries/application'

type Args<T> = { input: T }

/** Null when nobody holds it, and when the holder's account is gone. */
const resolveAssignee = (
  parent: { assignedToUserId: string | null },
  _args: unknown,
  context: GraphQLContext,
): Promise<StaffMember | null> | null => (parent.assignedToUserId
  ? context.loaders.userById.load(parent.assignedToUserId)
  : null)

export const adminResolvers = {
  Query: { admin: () => ({}) },
  Mutation: { admin: () => ({}) },
  AdminQuery: {
    programmeCycle: () => ({}),
    intake: () => ({}),
    funding: () => ({}),
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
    decision: () => ({}),
    funding: () => ({}),
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
    queues: (_parent: unknown, args: { cycleId?: string | null }, context: GraphQLContext) => intakeQueues(args.cycleId, context),
    byReference: (_parent: unknown, args: { referenceNumber: string }, context: GraphQLContext) => intakeByReference(args.referenceNumber, context),
    workspace: (_parent: unknown, args: { applicationId: string }, context: GraphQLContext) => intakeWorkspace(args.applicationId, context),
    documentDownloadUrl: (_parent: unknown, args: { applicationId: string; submissionDocumentId: string }, context: GraphQLContext) => adminDocumentDownloadUrl(args, context),
  },
  AdminFundingQuery: {
    byApplication: (_parent: unknown, args: { applicationId: string }, context: GraphQLContext) => fundingByApplication(args.applicationId, context),
    recoveryById: (_parent: unknown, args: { recoveryCaseId: string }, context: GraphQLContext) => recoveryById(args.recoveryCaseId, context),
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
    create: (_parent: unknown, args: Args<Parameters<typeof createProgrammeCycle>[0]>, context: GraphQLContext) => createProgrammeCycle(args.input, context),
    updateDraft: (_parent: unknown, args: Args<{ id: string; expectedVersion: number; reason: string; cycle: Parameters<typeof createProgrammeCycle>[0] }>, context: GraphQLContext) => updateDraftProgrammeCycleController({ ...args.input.cycle, id: args.input.id, expectedVersion: args.input.expectedVersion, reason: args.input.reason }, context),
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
    startDeskReview: (_parent: unknown, args: Args<Parameters<typeof startDeskReview>[0]>, context: GraphQLContext) => startDeskReview(args.input, context),
    completeDeskReview: (_parent: unknown, args: Args<Parameters<typeof completeDeskReview>[0]>, context: GraphQLContext) => completeDeskReview(args.input, context),
    cancelRevision: (_parent: unknown, args: Args<Parameters<typeof cancelRevisionRequest>[0]>, context: GraphQLContext) => cancelRevisionRequest(args.input, context),
  },
  AdminDecisionMutation: {
    referToBank: (_parent: unknown, args: Args<Parameters<typeof referApplicationToBank>[0]>, context: GraphQLContext) => referApplicationToBank(args.input, context),
    cancelBankReferral: (_parent: unknown, args: Args<Parameters<typeof cancelBankReferral>[0]>, context: GraphQLContext) => cancelBankReferral(args.input, context),
    recordBankOutcome: (_parent: unknown, args: Args<Parameters<typeof recordBankOutcome>[0]>, context: GraphQLContext) => recordBankOutcome(args.input, context),
    correctBankOutcome: (_parent: unknown, args: Args<Parameters<typeof correctBankOutcome>[0]>, context: GraphQLContext) => correctBankOutcome(args.input, context),
    recordDecision: (_parent: unknown, args: Args<Parameters<typeof recordDecision>[0]>, context: GraphQLContext) => recordDecision(args.input, context),
    correctDecision: (_parent: unknown, args: Args<Parameters<typeof correctDecision>[0]>, context: GraphQLContext) => correctDecision(args.input, context),
  },
  AdminFundingMutation: {
    createAward: (_parent: unknown, args: Args<Parameters<typeof createFundingAward>[0]>, context: GraphQLContext) => createFundingAward(args.input, context),
    changeAward: (_parent: unknown, args: Args<Parameters<typeof changeFundingAward>[0]>, context: GraphQLContext) => changeFundingAward(args.input, context),
    recordRelease: (_parent: unknown, args: Args<Parameters<typeof recordFundingRelease>[0]>, context: GraphQLContext) => recordFundingRelease(args.input, context),
    reverseRelease: (_parent: unknown, args: Args<Parameters<typeof reverseFundingRelease>[0]>, context: GraphQLContext) => reverseFundingRelease(args.input, context),
    recordAssessment: (_parent: unknown, args: Args<Parameters<typeof recordFundingAssessment>[0]>, context: GraphQLContext) => recordFundingAssessment(args.input, context),
    openRecovery: (_parent: unknown, args: Args<Parameters<typeof openRecoveryCase>[0]>, context: GraphQLContext) => openRecoveryCase(args.input, context),
    recordRecoveryEntry: (_parent: unknown, args: Args<Parameters<typeof recordRecoveryEntry>[0]>, context: GraphQLContext) => recordRecoveryEntry(args.input, context),
    cancelRecovery: (_parent: unknown, args: Args<Parameters<typeof cancelRecoveryCase>[0]>, context: GraphQLContext) => cancelRecoveryCase(args.input, context),
    closeRecovery: (_parent: unknown, args: Args<Parameters<typeof closeRecoveryCase>[0]>, context: GraphQLContext) => closeRecoveryCase(args.input, context),
  },
  /*
   * The only field in this namespace that fetches anything, on the two types
   * that carry an assignment.
   *
   * Resolved here rather than in the row's own query because joining the user
   * and grant tables into a list would duplicate an application once per role
   * its assignee holds. As a field it goes through the request's loader, so a
   * page of twenty rows naming twenty people costs one lookup.
   */
  AdminApplicationQueueItem: { assignedTo: resolveAssignee },
  AdminApplicationState: { assignedTo: resolveAssignee },
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
      expansionWaitMonths: parent.version.expansionWaitMonths,
      majorityOwnershipRequired: parent.version.majorityOwnershipRequired,
      jurisdiction: parent.version.jurisdiction,
      fundingCeilingState: parent.version.fundingCeilingState,
      fundingCeilingAmountPaise: parent.version.fundingCeilingAmountPaise,
      fundingCeilingScope: parent.version.fundingCeilingScope,
    }),
    groupDefinitions: (parent: Parameters<typeof definitionsOf>[0]) =>
      definitionsOf(parent),
    formTemplate: (parent: {
      head: { id: string; currentVersion: number }
      formStages: unknown[]
      formFields: unknown[]
      formFieldOptions: unknown[]
      formFieldConditions: unknown[]
    }) => resolveFormTemplate({
      programmeCycleId: parent.head.id,
      programmeCycleVersion: parent.head.currentVersion,
      stages: parent.formStages as never,
      fields: parent.formFields as never,
      options: parent.formFieldOptions as never,
      conditions: parent.formFieldConditions as never,
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
  AdminWorkspace: {
    notes: (parent: { internalNotes?: unknown[] }) => parent.internalNotes ?? [],
    snapshots: (parent: {
      snapshots: Array<Parameters<typeof snapshotRecordToPublic>[0]
        & { answers: Parameters<typeof snapshotRecordToPublic>[1] }>
    }) => parent.snapshots.map((snapshot) => snapshotRecordToPublic(snapshot, snapshot.answers)),
    documents: (parent: { documents: Array<{ pin: Record<string, unknown>; file: Record<string, unknown> }> }) =>
      parent.documents.map(({ pin, file }) => ({ ...pin, ...file, id: pin.id })),
    reviewChecks: (parent: { reviewChecks: Array<{ check: unknown }> }) =>
      parent.reviewChecks.map(({ check }) => check),
    releases: (parent: { releases: Array<{ entry: unknown }> }) =>
      parent.releases.map(({ entry }) => entry),
    assessments: (parent: { assessments: Array<{ assessment: unknown }> }) =>
      parent.assessments.map(({ assessment }) => assessment),
  },
}
