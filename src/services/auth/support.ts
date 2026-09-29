/**
 * Shared policy-layer helpers for the authentication and access controllers.
 *
 * The response envelope is shared rather than mirrored — see
 * `services/envelope.ts`. What stays here is what is genuinely this service's:
 * its refusal messages, the audit vocabulary it may write, and the rules about
 * what may enter a record. The row itself is `services/audit-event.ts`, shared
 * by every service.
 */
import {
  auditEventRow,
  type ActionWrittenBy,
  type AuditEventInput,
  type AuditEventRecord,
} from '../audit-event'
import type { AuthOperationContext, AuthResult } from './types'

export const AUTH_REQUIRED_MESSAGE = 'Authentication is required.'

/** Email normalization is trim plus lowercase; passwords are never normalized. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** The actions authentication and access may record. */
export type AuthAuditAction = ActionWrittenBy<'auth'>

/**
 * Builds one declared audit record for this service.
 *
 * The row is `services/audit-event.ts`, shared with every other service. This
 * service asks the most of it and hides the least: authentication is where a
 * *refusal* is worth recording — a wrong password, a spent challenge — so
 * `outcome` stays a caller's choice here, and so does opting out of the
 * caller-controlled request labels on the credential-bearing maintenance
 * paths. What this adds is the narrowing: the actions this service may write,
 * and nothing else.
 */
export const auditEvent = <A extends AuthAuditAction>(
  context: AuthOperationContext,
  input: AuditEventInput<A>,
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
