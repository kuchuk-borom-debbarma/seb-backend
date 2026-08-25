import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { coreUser } from './auth'

export const auditOutcomes = ['SUCCESS', 'FAILURE'] as const

/**
 * Fixed action names keep audit queries reliable and prevent spelling drift.
 *
 * **Every name here must be written by something.** A declared action nobody
 * writes is a note about an intention, and it reads from the outside exactly
 * like an action that has simply not happened yet — which is how recovery came
 * to be entirely absent from the history while three recovery actions sat here
 * looking like coverage. `scripts/check-audit-actions.mjs` fails the build on
 * one, in both directions.
 *
 * Two absences are deliberate rather than missing:
 *
 * - **Asking an applicant for a correction** has no action of its own. It
 *   happens three ways — a desk review, a bank outcome, a committee decision —
 *   and each already records itself with the outcome that caused it, so a
 *   separate name would be a second copy of the same fact.
 * - **Claiming, releasing and reassigning** are gone with the claim itself.
 */
export const auditActions = {
  signupChallengeCreated: 'AUTH.SIGNUP_CHALLENGE_CREATED',
  signupNotificationFailed: 'AUTH.SIGNUP_NOTIFICATION_FAILED',
  otpFailed: 'AUTH.OTP_FAILED',
  userCreated: 'USER.CREATED',
  roleGranted: 'RBAC.ROLE_GRANTED',
  roleRevoked: 'RBAC.ROLE_REVOKED',
  firstSuperAdminBootstrap: 'RBAC.FIRST_SUPER_ADMIN_BOOTSTRAP',
  roleInviteIssued: 'RBAC.ROLE_INVITE_ISSUED',
  roleInviteAccepted: 'RBAC.ROLE_INVITE_ACCEPTED',
  roleInviteRefused: 'RBAC.ROLE_INVITE_REFUSED',
  signInSucceeded: 'AUTH.SIGN_IN_SUCCEEDED',
  signInFailed: 'AUTH.SIGN_IN_FAILED',
  signedOut: 'AUTH.SIGNED_OUT',
  sessionRevoked: 'AUTH.SESSION_REVOKED',
  sessionsRevoked: 'AUTH.SESSIONS_REVOKED',
  enterpriseCreated: 'SEB.ENTERPRISE_CREATED',
  enterpriseUpdated: 'SEB.ENTERPRISE_UPDATED',
  enterpriseDeleted: 'SEB.ENTERPRISE_DELETED',
  enterpriseRestored: 'SEB.ENTERPRISE_RESTORED',
  applicationStarted: 'SEB.APPLICATION_STARTED',
  applicationSaved: 'SEB.APPLICATION_SAVED',
  applicationDeleted: 'SEB.APPLICATION_DELETED',
  applicationRestored: 'SEB.APPLICATION_RESTORED',
  applicationSubmitted: 'SEB.APPLICATION_SUBMITTED',
  applicationResubmitted: 'SEB.APPLICATION_RESUBMITTED',
  documentUploadIssued: 'SEB.DOCUMENT_UPLOAD_ISSUED',
  documentFinalized: 'SEB.DOCUMENT_FINALIZED',
  documentDeleted: 'SEB.DOCUMENT_DELETED',
  documentRestored: 'SEB.DOCUMENT_RESTORED',
  cycleCreated: 'SEB.CYCLE_CREATED',
  cycleUpdated: 'SEB.CYCLE_UPDATED',
  cycleOpened: 'SEB.CYCLE_OPENED',
  cycleGuidanceChanged: 'SEB.CYCLE_GUIDANCE_CHANGED',
  cycleClosingChanged: 'SEB.CYCLE_CLOSING_CHANGED',
  cycleClosed: 'SEB.CYCLE_CLOSED',
  cycleArchived: 'SEB.CYCLE_ARCHIVED',
  cycleDeleted: 'SEB.CYCLE_DELETED',
  cycleRestored: 'SEB.CYCLE_RESTORED',
  internalNoteAdded: 'SEB.INTERNAL_NOTE_ADDED',
  deskReviewStarted: 'SEB.DESK_REVIEW_STARTED',
  deskReviewCompleted: 'SEB.DESK_REVIEW_COMPLETED',
  revisionCancelled: 'SEB.REVISION_CANCELLED',
  bankReferred: 'SEB.BANK_REFERRED',
  bankReferralCancelled: 'SEB.BANK_REFERRAL_CANCELLED',
  bankOutcomeRecorded: 'SEB.BANK_OUTCOME_RECORDED',
  bankOutcomeCorrected: 'SEB.BANK_OUTCOME_CORRECTED',
  ttmMeetingChanged: 'SEB.TTM_MEETING_CHANGED',
  ttmAgendaChanged: 'SEB.TTM_AGENDA_CHANGED',
  ttmDecisionRecorded: 'SEB.TTM_DECISION_RECORDED',
  ttmDecisionCorrected: 'SEB.TTM_DECISION_CORRECTED',
  selfReviewDisclosed: 'SEB.SELF_REVIEW_DISCLOSED',
  awardCreated: 'SEB.AWARD_CREATED',
  awardChanged: 'SEB.AWARD_CHANGED',
  releaseRecorded: 'SEB.RELEASE_RECORDED',
  releaseReversed: 'SEB.RELEASE_REVERSED',
  assessmentRecorded: 'SEB.ASSESSMENT_RECORDED',
  recoveryOpened: 'SEB.RECOVERY_OPENED',
  recoveryEntryRecorded: 'SEB.RECOVERY_ENTRY_RECORDED',
  recoveryClosed: 'SEB.RECOVERY_CLOSED',
  recoveryCancelled: 'SEB.RECOVERY_CANCELLED',
} as const

/**
 * Internal, append-only audit history shared by core and product domains.
 * `changesJson` and `metadataJson` contain JSON text, but services must only
 * write explicitly allow-listed, non-secret values.
 */
export const coreAuditEvent = sqliteTable(
  'core_audit_event',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    outcome: text('outcome', { enum: auditOutcomes }).notNull(),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    changesJson: text('changes_json'),
    metadataJson: text('metadata_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    check('core_audit_event_outcome_check', sql`${table.outcome} IN ('SUCCESS', 'FAILURE')`),
    index('core_audit_event_entity_idx').on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index('core_audit_event_actor_idx').on(table.actorUserId, table.createdAt),
    index('core_audit_event_action_idx').on(table.action, table.createdAt),
    index('core_audit_event_request_idx').on(table.requestId),
    /*
     * The unfiltered read: everything, newest first.
     *
     * Every other index here leads with a filter column, so a query that names
     * no actor, entity or action had nothing to seek on and fell back to
     * scanning the table and sorting it — which is the one query most likely to
     * be run against the largest table in the database.
     *
     * `(created_at, id)` rather than `created_at` alone because that pair is
     * exactly the keyset cursor, so the seek and the ordering use one index.
     */
    index('core_audit_event_created_idx').on(table.createdAt, table.id),
  ],
)
