/**
 * Shared policy-layer helpers for the authentication and access controllers.
 *
 * The response envelope is shared rather than mirrored — see
 * `services/envelope.ts`. What stays here is what is genuinely this service's:
 * its refusal messages, its audit-record shape, and the rules about what may
 * enter one.
 */
import type { auditActions } from '../../db/schema'
import type { AuditEventRecord } from './queries/auth'
import type { AuthOperationContext, AuthResult } from './types'

export const AUTH_REQUIRED_MESSAGE = 'Authentication is required.'

/** Email normalization is trim plus lowercase; passwords are never normalized. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export type AuthAuditAction = (typeof auditActions)[keyof typeof auditActions]

export type AuthAuditEntityType =
  | 'CORE_USER'
  | 'CORE_USER_ROLE_GRANT'
  | 'CORE_SESSION'
  | 'CORE_SIGNUP_CHALLENGE'
  | 'CORE_ACCOUNT_CHALLENGE'

/**
 * Builds one allow-listed audit record. Callers provide only public IDs and
 * small, explicitly safe metadata objects. Credential-bearing maintenance
 * operations may opt out of caller-controlled request labels entirely.
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
): AuditEventRecord => {
  const includeRequestMetadata = input.includeRequestMetadata ?? true
  return {
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    outcome: input.outcome ?? 'SUCCESS',
    requestId: includeRequestMetadata
      ? context.requestHeaders.get('CF-Ray') ?? context.requestHeaders.get('X-Request-ID')
      : null,
    ipAddress: includeRequestMetadata
      ? context.requestHeaders.get('CF-Connecting-IP')
      : null,
    userAgent: includeRequestMetadata ? context.requestHeaders.get('User-Agent') : null,
    changesJson: null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: input.createdAt ?? new Date(),
  }
}

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
