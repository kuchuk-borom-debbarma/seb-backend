import { coreAuditEvent } from './core/audit'
import {
  coreAccountChallenge,
  coreSession,
  coreSignupChallenge,
  coreUser,
} from './core/auth'
import { coreRole, coreRolePermission, coreUserRoleGrant } from './core/access'
import {
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
} from './seb/application'
import { sebApplicationVersionAnswer } from './seb/answer'
import { sebFundingCase, sebFundingCaseVersion } from './seb/case'
import {
  sebProgrammeCycleFormField,
  sebProgrammeCycleFormFieldCondition,
  sebProgrammeCycleFormFieldOption,
  sebProgrammeCycleFormRule,
  sebProgrammeCycleFormRuleOperand,
  sebProgrammeCycleFormStage,
} from './seb/form-template'
import {
  sebApplicationDocument,
  sebApplicationDocumentScan,
  sebApplicationDocumentVersion,
  sebApplicationSubmissionDocument,
  sebDocumentUploadIntent,
} from './seb/document'
import {
  sebCyclePolicyDocument,
  sebCyclePolicyDocumentScan,
  sebCyclePolicyDocumentVersion,
  sebCyclePolicyUploadIntent,
} from './seb/policy-document'
import { sebAnnouncement, sebAnnouncementBoard } from './seb/announcement'
import { sebEnterprise, sebEnterpriseVersion } from './seb/enterprise'
import {
  sebPipeline,
  sebPipelineStage,
  sebPipelineStageOwner,
  sebPipelineVersion,
  sebPipelineVersionStage,
} from './seb/pipeline'
import {
  sebProgrammeCycle,
  sebProgrammeCycleApplicationKind,
  sebProgrammeCycleApplicationKindRule,
  sebProgrammeCycleEvent,
  sebProgrammeCycleVersion,
} from './seb/programme'
import { sebApplicationInternalNote } from './seb/review'
import { sebApplicationEvent, sebApplicationStageAction, sebRevisionRequest } from './seb/workflow'

export * from './shared'
export * from './core/audit'
export * from './core/access'
export * from './core/auth'
export * from './seb/application'
export * from './seb/case'
export * from './seb/announcement'
export * from './seb/document'
export * from './seb/policy-document'
export * from './seb/answer'
export * from './seb/enterprise'
export * from './seb/form-template'
export * from './seb/pipeline'
export * from './seb/programme'
export * from './seb/review'
export * from './seb/workflow'

/** Complete schema passed to the request-scoped Drizzle client. */
export const schema = {
  coreUser,
  coreRole,
  coreRolePermission,
  coreUserRoleGrant,
  coreSession,
  coreSignupChallenge,
  coreAccountChallenge,
  coreAuditEvent,
  sebEnterprise,
  sebEnterpriseVersion,
  sebProgrammeCycle,
  sebProgrammeCycleVersion,
  sebProgrammeCycleApplicationKind,
  sebProgrammeCycleApplicationKindRule,
  sebProgrammeCycleEvent,
  /*
   * The four template tables, which were imported and never listed.
   *
   * Inert while nothing uses `db.query.*` — DDL comes from `export *` above and
   * every read is an explicit `select` — but this object is what
   * `drizzle(client, { schema })` receives, so the first relational query
   * against a form table would have failed with the table simply absent.
   * `noUnusedLocals` is off, so the dangling imports said nothing.
   */
  sebProgrammeCycleFormStage,
  sebProgrammeCycleFormField,
  sebProgrammeCycleFormFieldOption,
  sebProgrammeCycleFormFieldCondition,
  sebProgrammeCycleFormRule,
  sebProgrammeCycleFormRuleOperand,
  sebFundingCase,
  sebFundingCaseVersion,
  sebApplication,
  sebApplicationVersion,
  sebApplicationSubmission,
  sebApplicationVersionAnswer,
  sebApplicationDocument,
  sebApplicationDocumentVersion,
  sebApplicationSubmissionDocument,
  sebApplicationDocumentScan,
  sebDocumentUploadIntent,
  sebCyclePolicyDocument,
  sebCyclePolicyDocumentVersion,
  sebCyclePolicyDocumentScan,
  sebCyclePolicyUploadIntent,
  sebAnnouncement,
  sebAnnouncementBoard,
  sebRevisionRequest,
  sebApplicationEvent,
  sebApplicationInternalNote,
  sebPipeline,
  sebPipelineVersion,
  sebPipelineStage,
  sebPipelineStageOwner,
  sebPipelineVersionStage,
  sebApplicationStageAction,
}
