import { coreAuditEvent } from './core/audit'
import {
  coreAccountChallenge,
  coreSession,
  coreSignupChallenge,
  coreUser,
  coreUserRoleGrant,
} from './core/auth'
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
  sebProgrammeCycleFormStage,
} from './seb/form-template'
import {
  sebApplicationDocument,
  sebApplicationDocumentScan,
  sebApplicationDocumentVersion,
  sebApplicationSubmissionDocument,
  sebDocumentUploadIntent,
} from './seb/document'
import { sebEnterprise, sebEnterpriseVersion } from './seb/enterprise'
import {
  sebApplicationQualifyingAward,
  sebApplicationQualifyingAwardVersion,
  sebAwardAssessment,
  sebDisbursement,
  sebFundingAward,
  sebFundingAwardVersion,
  sebUtilizationObligation,
} from './seb/funding'
import {
  sebProgrammeCycle,
  sebProgrammeCycleAssessmentRule,
  sebProgrammeCycleEvent,
  sebProgrammeCycleIdentifierRule,
  sebProgrammeCycleReason,
  sebProgrammeCycleVersion,
} from './seb/programme'
import {
  sebApplicationAssignmentEvent,
  sebApplicationInternalNote,
  sebDeskReview,
  sebDeskReviewCheck,
  sebDeskReviewIdentifier,
} from './seb/review'
import {
  sebPartnerBankOutcome,
  sebPartnerBankReferral,
  sebPartnerBankReferralVersion,
  sebProgrammeDecision,
} from './seb/decision'
import { sebRecoveryCase, sebRecoveryCaseVersion, sebRecoveryEntry } from './seb/recovery'
import { sebApplicationEvent, sebRevisionRequest } from './seb/workflow'

export * from './shared'
export * from './core/audit'
export * from './core/auth'
export * from './seb/application'
export * from './seb/case'
export * from './seb/document'
export * from './seb/decision'
export * from './seb/answer'
export * from './seb/enterprise'
export * from './seb/form-template'
export * from './seb/funding'
export * from './seb/programme'
export * from './seb/recovery'
export * from './seb/review'
export * from './seb/workflow'

/** Complete schema passed to the request-scoped Drizzle client. */
export const schema = {
  coreUser,
  coreUserRoleGrant,
  coreSession,
  coreSignupChallenge,
  coreAccountChallenge,
  coreAuditEvent,
  sebEnterprise,
  sebEnterpriseVersion,
  sebProgrammeCycle,
  sebProgrammeCycleVersion,
  sebProgrammeCycleAssessmentRule,
  sebProgrammeCycleIdentifierRule,
  sebProgrammeCycleReason,
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
  sebRevisionRequest,
  sebApplicationEvent,
  sebApplicationAssignmentEvent,
  sebApplicationInternalNote,
  sebDeskReview,
  sebDeskReviewCheck,
  sebDeskReviewIdentifier,
  sebPartnerBankReferral,
  sebPartnerBankReferralVersion,
  sebPartnerBankOutcome,
  sebProgrammeDecision,
  sebFundingAward,
  sebFundingAwardVersion,
  sebApplicationQualifyingAward,
  sebApplicationQualifyingAwardVersion,
  sebDisbursement,
  sebUtilizationObligation,
  sebAwardAssessment,
  sebRecoveryCase,
  sebRecoveryCaseVersion,
  sebRecoveryEntry,
}
