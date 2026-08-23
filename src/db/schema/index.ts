import { coreAuditEvent } from './core/audit'
import { coreSession, coreSignupChallenge, coreUser, coreUserRoleGrant } from './core/auth'
import {
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
} from './seb/application'
import { sebFundingCase, sebFundingCaseVersion } from './seb/case'
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
  sebProgrammeCycleDocumentRule,
  sebProgrammeCycleEvent,
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
  sebTtmAgendaItem,
  sebTtmAgendaItemVersion,
  sebTtmDecision,
  sebTtmMeeting,
  sebTtmMeetingVersion,
} from './seb/decision'
import { sebRecoveryCase, sebRecoveryCaseVersion, sebRecoveryEntry } from './seb/recovery'
import { sebApplicationEvent, sebRevisionRequest } from './seb/workflow'

export * from './core/audit'
export * from './core/auth'
export * from './seb/application'
export * from './seb/case'
export * from './seb/document'
export * from './seb/decision'
export * from './seb/enterprise'
export * from './seb/funding'
export * from './seb/programme'
export * from './seb/recovery'
export * from './seb/review'
export * from './seb/workflow'

/** Complete schema passed to the request-scoped Drizzle D1 client. */
export const schema = {
  coreUser,
  coreUserRoleGrant,
  coreSession,
  coreSignupChallenge,
  coreAuditEvent,
  sebEnterprise,
  sebEnterpriseVersion,
  sebProgrammeCycle,
  sebProgrammeCycleVersion,
  sebProgrammeCycleDocumentRule,
  sebProgrammeCycleAssessmentRule,
  sebProgrammeCycleReason,
  sebProgrammeCycleEvent,
  sebFundingCase,
  sebFundingCaseVersion,
  sebApplication,
  sebApplicationVersion,
  sebApplicationSubmission,
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
  sebTtmMeeting,
  sebTtmMeetingVersion,
  sebTtmAgendaItem,
  sebTtmAgendaItemVersion,
  sebTtmDecision,
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
