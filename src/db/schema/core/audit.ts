import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, smallint, text } from 'drizzle-orm/pg-core'
import { instant } from '../shared'
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
 * - **Asking an applicant for a correction** has no action of its own. It is
 *   one effect of a configured stage action, and the action records itself
 *   with what it did, so a separate name would be a second copy of the fact.
 * - **Claiming, releasing and reassigning** are gone with the claim itself.
 */
export const auditActions = {
  signupChallengeCreated: 'AUTH.SIGNUP_CHALLENGE_CREATED',
  signupNotificationFailed: 'AUTH.SIGNUP_NOTIFICATION_FAILED',
  otpFailed: 'AUTH.OTP_FAILED',
  userCreated: 'USER.CREATED',
  roleCreated: 'RBAC.ROLE_CREATED',
  roleUpdated: 'RBAC.ROLE_UPDATED',
  roleRetired: 'RBAC.ROLE_RETIRED',
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
  passwordResetRequested: 'AUTH.PASSWORD_RESET_REQUESTED',
  passwordResetCompleted: 'AUTH.PASSWORD_RESET_COMPLETED',
  passwordResetOtpFailed: 'AUTH.PASSWORD_RESET_OTP_FAILED',
  passwordResetNotificationFailed: 'AUTH.PASSWORD_RESET_NOTIFICATION_FAILED',
  passwordChanged: 'USER.PASSWORD_CHANGED',
  emailChangeRequested: 'USER.EMAIL_CHANGE_REQUESTED',
  emailChangeOtpFailed: 'USER.EMAIL_CHANGE_OTP_FAILED',
  /*
   * An email-change code that could not be delivered.
   *
   * Its own action, because it was recorded as
   * `AUTH.PASSWORD_RESET_NOTIFICATION_FAILED` — so somebody reading the audit
   * trail for a failed reset saw email changes among them, and somebody asking
   * why an address change never arrived found nothing under any name they
   * would think to search.
   */
  emailChangeNotificationFailed: 'USER.EMAIL_CHANGE_NOTIFICATION_FAILED',
  emailChanged: 'USER.EMAIL_CHANGED',
  displayNameChanged: 'USER.DISPLAY_NAME_CHANGED',
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
  cyclePolicyUploadIssued: 'SEB.CYCLE_POLICY_UPLOAD_ISSUED',
  cyclePolicyFinalized: 'SEB.CYCLE_POLICY_FINALIZED',
  cycleOpened: 'SEB.CYCLE_OPENED',
  cycleGuidanceChanged: 'SEB.CYCLE_GUIDANCE_CHANGED',
  cycleClosingChanged: 'SEB.CYCLE_CLOSING_CHANGED',
  cycleClosed: 'SEB.CYCLE_CLOSED',
  cycleArchived: 'SEB.CYCLE_ARCHIVED',
  cycleDeleted: 'SEB.CYCLE_DELETED',
  cycleRestored: 'SEB.CYCLE_RESTORED',
  announcementCreated: 'SEB.ANNOUNCEMENT_CREATED',
  announcementUpdated: 'SEB.ANNOUNCEMENT_UPDATED',
  announcementRemoved: 'SEB.ANNOUNCEMENT_REMOVED',
  announcementReordered: 'SEB.ANNOUNCEMENT_REORDERED',
  pipelineCreated: 'SEB.PIPELINE_CREATED',
  pipelineDraftSaved: 'SEB.PIPELINE_DRAFT_SAVED',
  pipelinePublished: 'SEB.PIPELINE_PUBLISHED',
  pipelineDraftDiscarded: 'SEB.PIPELINE_DRAFT_DISCARDED',
  pipelineRetired: 'SEB.PIPELINE_RETIRED',
  pipelineStageOwnersChanged: 'SEB.PIPELINE_STAGE_OWNERS_CHANGED',
  stageActionTaken: 'SEB.STAGE_ACTION_TAKEN',
  internalNoteAdded: 'SEB.INTERNAL_NOTE_ADDED',
  revisionCancelled: 'SEB.REVISION_CANCELLED',
  selfReviewDisclosed: 'SEB.SELF_REVIEW_DISCLOSED',
  /*
   * Failure-only: the send is best effort, and the durable business record is
   * the submission or stage-action row itself. A success action here would be a second copy of a fact
   * the history already carries; what the office cannot see anywhere else is
   * an applicant who was never told.
   */
  submissionConfirmationFailed: 'SEB.SUBMISSION_CONFIRMATION_FAILED',
  revisionNotificationFailed: 'SEB.REVISION_NOTIFICATION_FAILED',
  stageNotificationFailed: 'SEB.STAGE_NOTIFICATION_FAILED',
  /*
   * Taking the history out of the system is itself history. The rows an export
   * carried are not copied here — they are still in this table — but who took
   * them, which filters chose them, and the reason they gave are recorded
   * nowhere else.
   */
  auditExported: 'AUDIT.EXPORTED',
} as const

/** Every action name, as the type a row's `action` column is written with. */
export type AuditAction = (typeof auditActions)[keyof typeof auditActions]

/**
 * Internal, append-only audit history shared by core and product domains.
 *
 * **Two generations of row live here, told apart by `payload_version`.**
 *
 * - `0` — written before each action had a declared shape. What it recorded is
 *   in `metadata_json`, as loose flat JSON text, and is shown as recorded.
 * - `1` — the payload is `payload`, validated against the action's schema in
 *   `services/audit-vocabulary` before the row was built. `metadata_json` is
 *   NULL.
 *
 * `metadata_json` is never rewritten into `payload`. A migration that restated
 * old evidence in a new shape would be the history editing itself, and the
 * whole value of an append-only record is that nothing does.
 *
 * `subject_user_id` and `application_id` are denormalized on purpose: they are
 * what "everything done to this person" and "everything that happened to this
 * application" seek on, and deriving them at read time would mean joining every
 * row against a different table per entity type.
 */
export const coreAuditEvent = pgTable(
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
    createdAt: instant('created_at').notNull(),
    /*
     * The four columns below were added after the table had rows, which is why
     * they come last and why every one is nullable or defaulted: a Worker built
     * before them is still writing its twelve columns during the few seconds of
     * a deploy, and a column it cannot fill must not refuse its insert — that
     * insert shares a transaction with the business write it records.
     */
    subjectUserId: text('subject_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    // No foreign key: `core_*` does not depend on `seb_*`, and the history of
    // an application must be readable whatever later happens to its row.
    applicationId: text('application_id'),
    payload: jsonb('payload'),
    payloadVersion: smallint('payload_version').notNull().default(0),
  },
  (table) => [
    check('core_audit_event_outcome_check', sql`${table.outcome} IN ('SUCCESS', 'FAILURE')`),
    check('core_audit_event_payload_version_check', sql`${table.payloadVersion} IN (0, 1)`),
    /*
     * A typed row carries its payload and nothing in the legacy column; a
     * legacy row carries no typed payload. Mixed, a reader could not say which
     * of the two was the evidence.
     */
    check(
      'core_audit_event_payload_generation_check',
      sql`(${table.payloadVersion} = 1 AND ${table.payload} IS NOT NULL AND ${table.metadataJson} IS NULL)
        OR (${table.payloadVersion} = 0 AND ${table.payload} IS NULL)`,
    ),
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
    /*
     * "Everything done to this person" and "everything that happened to this
     * application", in cursor order. Partial, because most rows have neither —
     * a cycle change has no subject, a sign-in has no application — and an
     * index full of NULLs would be paid for on every insert and never read.
     */
    index('core_audit_event_subject_idx')
      .on(table.subjectUserId, table.createdAt, table.id)
      .where(sql`${table.subjectUserId} IS NOT NULL`),
    index('core_audit_event_application_idx')
      .on(table.applicationId, table.createdAt, table.id)
      .where(sql`${table.applicationId} IS NOT NULL`),
  ],
)
