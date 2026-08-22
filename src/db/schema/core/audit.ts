import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { coreUser } from './auth'

export const auditOutcomes = ['SUCCESS', 'FAILURE'] as const

/** Fixed action names keep audit queries reliable and prevent spelling drift. */
export const auditActions = {
  signupChallengeCreated: 'AUTH.SIGNUP_CHALLENGE_CREATED',
  signupNotificationFailed: 'AUTH.SIGNUP_NOTIFICATION_FAILED',
  otpFailed: 'AUTH.OTP_FAILED',
  userCreated: 'USER.CREATED',
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
  ],
)
