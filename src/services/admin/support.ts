/**
 * Shared policy-layer helpers for the administrative controllers.
 *
 * Mirrors `services/application/support.ts` and `services/auth/support.ts` on
 * purpose. Keeping one copy per service is what stops four controllers drifting
 * to different failure envelopes or different rules about what may enter an
 * audit row.
 *
 * Audit metadata stays deliberately smaller than the business record: a flat
 * map of primitives, never the form itself.
 */
import { coreAuditEvent, type auditActions } from '../../db/schema'
import { authenticatedWithCapability, type Capability } from '../auth'
import type { AdminOperationContext, AdminResult } from './types'

/**
 * The one refusal every insufficiently authorized staff request receives.
 *
 * Deliberately does not name a role. The office now holds four of them, so
 * "administrator access is required" would be wrong for a reviewer refused a
 * write and misleading for an approver refused a desk review — and naming the
 * role that *would* work tells a caller which account to go looking for.
 */
export const ADMIN_REQUIRED_MESSAGE = 'You do not have permission to do that.'
export const STALE_MESSAGE = 'The record changed. Reload and try again.'

export const success = <T>(response: T, message: string | null = null): AdminResult<T> => ({
  success: true,
  message,
  response,
})

export const failure = <T>(message: string): AdminResult<T> => ({
  success: false,
  message,
  response: null,
})

/**
 * The caller, if they hold the capability this operation needs.
 *
 * Named for staff rather than administrators because the office now holds four
 * roles and two of them are not administrators: a reviewer may read a
 * workspace, and an approver may record a decision, without being able to do
 * anything else. Which role carries which capability is decided in one place,
 * `auth/capabilities.ts`, and never restated here.
 *
 * The capability is a required argument on purpose. A default would mean an
 * operation that forgot to say what it needs silently inherits somebody else's
 * answer, and the direction that mistake fails in is "too permissive".
 */
export const currentStaff = async (
  context: AdminOperationContext,
  capability: Capability,
) => {
  const authenticated = await authenticatedWithCapability(context, capability)
  return authenticated?.user ?? null
}

export type AdminAuditAction = (typeof auditActions)[keyof typeof auditActions]

/** Audit metadata stays deliberately smaller than the business record. */
export const adminAudit = (
  context: AdminOperationContext,
  input: {
    actorUserId: string | null
    action: AdminAuditAction
    entityType: string
    entityId: string
    now: Date
    metadata?: Record<string, string | number | boolean | null>
  },
): typeof coreAuditEvent.$inferInsert => ({
  id: crypto.randomUUID(),
  actorUserId: input.actorUserId,
  action: input.action,
  entityType: input.entityType,
  entityId: input.entityId,
  outcome: 'SUCCESS',
  requestId:
    context.requestHeaders.get('CF-Ray') ?? context.requestHeaders.get('X-Request-ID'),
  ipAddress: context.requestHeaders.get('CF-Connecting-IP'),
  userAgent: context.requestHeaders.get('User-Agent'),
  changesJson: null,
  metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  createdAt: input.now,
})

const isExpectedConstraintError = (error: unknown): boolean =>
  error instanceof Error && /constraint|unique|foreign key/iu.test(error.message)

export const constraintSafe = async <T>(operation: () => Promise<T>): Promise<T | null> => {
  try {
    return await operation()
  } catch (error) {
    if (isExpectedConstraintError(error)) return null
    throw error
  }
}

export const normalizeRequiredText = (
  value: string,
  maximumLength: number,
): string | null => {
  const normalized = value.trim()
  return normalized && normalized.length <= maximumLength ? normalized : null
}

export const normalizeOptionalText = (
  value: string | null | undefined,
  maximumLength: number,
): string | null | 'INVALID' => {
  if (value === null || value === undefined) return null
  const normalized = value.trim()
  if (!normalized) return null
  return normalized.length <= maximumLength ? normalized : 'INVALID'
}

export const changedExactlyOne = (
  result: unknown[] | { meta: { changes?: number } },
): boolean => Array.isArray(result) ? result.length === 1 : (result.meta.changes ?? 0) === 1

/**
 * The preamble every reasoned, version-guarded administrative transition shares.
 *
 * Each of these transitions is authorized the same way, requires the same
 * bounded mandatory reason, and takes the same optimistic-concurrency version.
 * Only the message describing a malformed request differs, so that is the one
 * thing a caller supplies.
 */
export const authorizeReasonedTransition = async (
  context: AdminOperationContext,
  capability: Capability,
  input: { reason: string; expectedVersion: number },
  invalidRequestMessage: string,
): Promise<{ actorId: string; reason: string } | { refusal: AdminResult<never> }> => {
  const administrator = await currentStaff(context, capability)
  if (!administrator) return { refusal: failure(ADMIN_REQUIRED_MESSAGE) }
  const reason = normalizeRequiredText(input.reason, 1_000)
  if (!reason || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { refusal: failure(invalidRequestMessage) }
  }
  return { actorId: administrator.id, reason }
}
