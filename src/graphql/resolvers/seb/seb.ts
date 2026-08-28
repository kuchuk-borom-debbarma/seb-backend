/** Thin GraphQL adapters for the applicant-facing Mission SEP domain. */
import {
  applicationById,
  applicationDraftChanges,
  applicationFormTemplate,
  applicationFunding,
  applicationStatusExplanations,
  applicationTimeline,
  availableProgrammeCycles,
  createEnterprise,
  documentDownloadUrl,
  enterpriseById,
  expansionEligibility,
  finalizeDocumentUpload,
  issueDocumentUpload,
  myApplications,
  myProgrammeCycles,
  myEnterprises,
  restoreApplicationDocument,
  restoreApplicationDraft,
  restoreEnterprise,
  resubmitApplication,
  saveApplicationDraft,
  softDeleteApplicationDocument,
  softDeleteApplicationDraft,
  softDeleteEnterprise,
  startExpansionApplication,
  startInitialApplication,
  submitApplication,
  submittedApplicationCopy,
  updateEnterprise,
  validateApplication,
  type ApplicationStatus,
  type ApplicationType,
  type BusinessSector,
  type EnterpriseStatus,
  type SuppliedEnterpriseProfile,
} from '../../../services/application'
import type { GraphQLContext } from '../../types'

export const sebResolvers = {
  Query: { seb: () => ({}) },
  Mutation: { seb: () => ({}) },
  SebQuery: {
    enterprise: () => ({}),
    application: () => ({}),
  },
  SebMutation: {
    enterprise: () => ({}),
    application: () => ({}),
  },
  SebEnterpriseQuery: {
    mine: (
      _parent: unknown,
      args: {
        first?: number | null
        after?: string | null
        includeDeleted?: boolean | null
        status?: EnterpriseStatus | null
        sector?: BusinessSector | null
        search?: string | null
      },
      context: GraphQLContext,
    ) => myEnterprises(args, context),
    byId: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
      enterpriseById(args.id, context),
  },
  SebEnterpriseMutation: {
    create: (
      _parent: unknown,
      args: { input: SuppliedEnterpriseProfile },
      context: GraphQLContext,
    ) => createEnterprise(args.input, context),
    update: (
      _parent: unknown,
      args: { input: { id: string; expectedVersion: number; profile: SuppliedEnterpriseProfile } },
      context: GraphQLContext,
    ) => updateEnterprise(args.input, context),
    softDelete: (
      _parent: unknown,
      args: { input: { id: string; expectedVersion: number; reason?: string | null } },
      context: GraphQLContext,
    ) => softDeleteEnterprise(args.input, context),
    restore: (
      _parent: unknown,
      args: { id: string; expectedVersion: number },
      context: GraphQLContext,
    ) => restoreEnterprise(args, context),
  },
  SebApplicationQuery: {
    myProgrammeCycles: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      myProgrammeCycles(context),
    statusGuide: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      applicationStatusExplanations(context),
    availableProgrammeCycles: (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => availableProgrammeCycles(context),
    mine: (
      _parent: unknown,
      args: {
        first?: number | null
        after?: string | null
        enterpriseId?: string | null
        status?: ApplicationStatus | null
        programmeCycleId?: string | null
        applicationType?: ApplicationType | null
        search?: string | null
        includeDeleted?: boolean | null
      },
      context: GraphQLContext,
    ) => myApplications(args, context),
    byId: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
      applicationById(args.id, context),
    validate: (
      _parent: unknown,
      args: { applicationId: string },
      context: GraphQLContext,
    ) => validateApplication(args.applicationId, context),
    submittedCopy: (
      _parent: unknown,
      args: { applicationId: string },
      context: GraphQLContext,
    ) => submittedApplicationCopy(args.applicationId, context),
    expansionEligibility: (
      _parent: unknown,
      args: { enterpriseId: string; programmeCycleId: string },
      context: GraphQLContext,
    ) => expansionEligibility(args, context),
    funding: (
      _parent: unknown,
      args: { applicationId: string },
      context: GraphQLContext,
    ) => applicationFunding(args.applicationId, context),
    formTemplate: (
      _parent: unknown,
      args: { applicationId: string },
      context: GraphQLContext,
    ) => applicationFormTemplate(args.applicationId, context),
    draftChanges: (
      _parent: unknown,
      args: { applicationId: string },
      context: GraphQLContext,
    ) => applicationDraftChanges(args.applicationId, context),
    timeline: (
      _parent: unknown,
      args: { applicationId: string; first?: number | null; after?: string | null },
      context: GraphQLContext,
    ) => applicationTimeline(args, context),
    documentDownloadUrl: (
      _parent: unknown,
      args: { documentId: string },
      context: GraphQLContext,
    ) => documentDownloadUrl(args.documentId, context),
  },
  SebApplicationMutation: {
    startInitial: (
      _parent: unknown,
      args: { input: { enterpriseId: string; programmeCycleId: string } },
      context: GraphQLContext,
    ) => startInitialApplication(args.input, context),
    startExpansion: (
      _parent: unknown,
      args: { input: { enterpriseId: string; programmeCycleId: string } },
      context: GraphQLContext,
    ) => startExpansionApplication(args.input, context),
    saveDraft: (
      _parent: unknown,
      args: {
        input: {
          applicationId: string
          expectedVersion: number
          expectedStatusVersion: number
          answers: unknown
        }
      },
      context: GraphQLContext,
    ) => saveApplicationDraft(args.input, context),
    softDeleteDraft: (
      _parent: unknown,
      args: {
        input: {
          applicationId: string
          expectedVersion: number
          expectedStatusVersion: number
          reason?: string | null
        }
      },
      context: GraphQLContext,
    ) => softDeleteApplicationDraft(args.input, context),
    restoreDraft: (
      _parent: unknown,
      args: { input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number } },
      context: GraphQLContext,
    ) => restoreApplicationDraft(args.input, context),
    issueDocumentUpload: (
      _parent: unknown,
      args: {
        input: {
          applicationId: string
          fieldKey: string
          expectedDocumentVersion: number
          originalFilename: string
          contentType: string
          sizeBytes: number
          checksumSha256: string
        }
      },
      context: GraphQLContext,
    ) => issueDocumentUpload(args.input, context),
    finalizeDocumentUpload: (
      _parent: unknown,
      args: { uploadId: string },
      context: GraphQLContext,
    ) => finalizeDocumentUpload(args.uploadId, context),
    softDeleteDocument: (
      _parent: unknown,
      args: { input: { applicationId: string; documentId: string; expectedVersion: number } },
      context: GraphQLContext,
    ) => softDeleteApplicationDocument(args.input, context),
    restoreDocument: (
      _parent: unknown,
      args: { input: { applicationId: string; documentId: string; expectedVersion: number } },
      context: GraphQLContext,
    ) => restoreApplicationDocument(args.input, context),
    submit: (
      _parent: unknown,
      args: { input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number } },
      context: GraphQLContext,
    ) => submitApplication(args.input, context),
    resubmit: (
      _parent: unknown,
      args: { input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number } },
      context: GraphQLContext,
    ) => resubmitApplication(args.input, context),
  },
}
