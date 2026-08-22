import { coreAuditEvent, type auditActions } from '../../db/schema'
import { authenticatedAdministrator } from '../auth'
import type { AdminOperationContext, AdminResult } from './types'

export const ADMIN_REQUIRED_MESSAGE = 'Administrator access is required.'
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

export const currentAdministrator = async (context: AdminOperationContext) => {
  const authenticated = await authenticatedAdministrator(context)
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
  input: { reason: string; expectedVersion: number },
  invalidRequestMessage: string,
): Promise<{ actorId: string; reason: string } | { refusal: AdminResult<never> }> => {
  const administrator = await currentAdministrator(context)
  if (!administrator) return { refusal: failure(ADMIN_REQUIRED_MESSAGE) }
  const reason = normalizeRequiredText(input.reason, 1_000)
  if (!reason || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { refusal: failure(invalidRequestMessage) }
  }
  return { actorId: administrator.id, reason }
}
