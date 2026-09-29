/**
 * Shared policy-layer helpers for the authentication and access controllers.
 *
 * The response envelope is shared rather than mirrored — see
 * `services/envelope.ts`. What stays here is what is genuinely this service's:
 * its refusal messages, the audit vocabulary it may write, and the rules about
 * what may enter a record. The row itself is `services/audit-event.ts`, shared
 * by every service.
 */
import type { auditActions } from '../../db/schema'
import { auditEventRow } from '../audit-event'
import type { AuditEventRecord } from './queries/auth'
import type { AuthOperationContext, AuthResult } from './types'

export const AUTH_REQUIRED_MESSAGE = 'Authentication is required.'

/** Email normalization is trim plus lowercase; passwords are never normalized. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export type AuthAuditAction = (typeof auditActions)[keyof typeof auditActions]

export type AuthAuditEntityType =
  | 'CORE_USER'
  | 'CORE_USER_ROLE_GRANT'
  | 'CORE_ROLE'
  | 'CORE_SESSION'
  | 'CORE_SIGNUP_CHALLENGE'
  | 'CORE_ACCOUNT_CHALLENGE'

/**
 * Builds one allow-listed audit record. Callers provide only public IDs and
 * small, explicitly safe metadata objects.
 *
 * The row is `services/audit-event.ts`, shared with every other service. This
 * service asks the most of it and hides the least: authentication is where a
 * *refusal* is worth recording — a wrong password, a spent challenge — so
 * `outcome` stays a caller's choice here, and so does opting out of the
 * caller-controlled request labels on the credential-bearing maintenance
 * paths. What this adds is the vocabulary: the actions and entity types this
 * service may write, and nothing else.
 */
export const auditEvent = (
  context: AuthOperationContext,
  input: {
    action: AuthAuditAction
    entityType: AuthAuditEntityType
    entityId?: string | null
    actorUserId?: string | null
    outcome?: 'SUCCESS' | 'FAILURE'
    metadata?: Record<string, string | number | boolean | null>
    createdAt?: Date
    includeRequestMetadata?: boolean
  },
): AuditEventRecord => auditEventRow(context, input)

/**
 * Normalizes a mandatory administrative reason.
 *
 * Reasons are retained forever on the grant row and shown to future operators,
 * so an empty or unbounded value is rejected rather than silently stored.
 */
export const normalizeReason = (value: string, maximumLength: number): string | null => {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized && normalized.length <= maximumLength ? normalized : null
}
