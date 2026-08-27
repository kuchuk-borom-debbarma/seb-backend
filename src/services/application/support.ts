/**
 * Shared policy-layer helpers for the applicant controllers.
 *
 * What belongs here is what is genuinely the applicant service's. The response
 * envelope is not: `success` and `failure` live in `services/envelope.ts`,
 * because four identical copies were one decision repeated rather than four
 * decisions, and copies drift.
 *
 * Also holds the D1 boundary conversions that are easy to get wrong once and
 * then repeat: `undefined` is not SQL `NULL`, a batch result shape has to be
 * normalized before it can be read as "exactly one row changed", and an
 * expected uniqueness race is a business refusal rather than a fault.
 */
import { isExpectedConstraintError } from '../constraints'
import { changedExactlyOne } from '../../db'
import { auditActions, type coreAuditEvent } from '../../db/schema'
import { failure, success } from '../envelope'
import { authenticatedApplicant } from '../auth'
import type { ApplicationOperationContext, SebResult } from './types'

export const AUTH_REQUIRED_MESSAGE = 'Applicant authentication is required.'

/**
 * D1 bindings distinguish JavaScript `undefined` from SQL `NULL`. Keeping this
 * conversion in one place avoids scattering null-coalescing branches through
 * guarded INSERT ... SELECT statements.
 */
export const sqlNullable = <T>(value: T | null | undefined): T | null => value ?? null

/** Converts an optional Drizzle date value to D1's millisecond representation. */
/*
 * There is deliberately no date-to-milliseconds helper. Timestamps are
 * `timestamptz` and a `Date` binds to one directly; converting to epoch
 * milliseconds produced `timestamptz = bigint`, which Postgres refuses — so a
 * guarded write that should have refused cleanly threw instead.
 */

export const currentApplicant = async (context: ApplicationOperationContext) => {
  const authenticated = await authenticatedApplicant(context)
  return authenticated?.user ?? null
}

export type AuditRecord = typeof coreAuditEvent.$inferInsert
export type ApplicationAuditAction = (typeof auditActions)[keyof typeof auditActions]

/** Builds an allow-listed audit row without copying business form data. */
export const auditRecord = (
  context: ApplicationOperationContext,
  input: {
    actorUserId: string
    action: ApplicationAuditAction
    entityType: string
    entityId: string
    metadata?: Record<string, string | number | boolean | null>
    now: Date
  },
): AuditRecord => ({
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

/**
 * Converts an expected uniqueness or foreign-key race into `false`, while
 * preserving unexpected faults for GraphQL Yoga's server-error handling.
 */
export const runConstraintSafe = async (
  operation: () => Promise<boolean>,
): Promise<boolean> => {
  try {
    return await operation()
  } catch (error) {
    if (isExpectedConstraintError(error)) return false
    throw error
  }
}

/**
 * Constraint-safe variant for aggregate inserts.
 *
 * False means the write did not happen, whether a unique key refused it or its
 * own guard did — the caller turns either into a refusal rather than a crash.
 */
export const runConstraintSafeInsert = async (
  operation: () => Promise<boolean>,
): Promise<boolean> => (await runConstraintSafe(operation)) === true

/** Retries bounded uniqueness races such as generated public references. */
export const runConstraintRetry = async <T>(
  operation: () => Promise<T>,
  maximumAttempts: number,
): Promise<T | null> => {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isExpectedConstraintError(error)) throw error
    }
  }
  return null
}

/** Documents an invariant established by schema foreign keys or an atomic batch. */
/** A `COUNT(*)` always returns exactly one row; if it did not, nothing is safe. */
export const COUNT_MISSING = 'Count query returned no row.'

export const requireInvariant = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

/** Runs irreversible cleanup only for the request that won the D1 claim. */
export const afterSuccessfulClaim = async (
  claimed: boolean,
  cleanup: () => Promise<void>,
): Promise<void> => {
  if (claimed) await cleanup()
}

/** Adds a claimed row without duplicating D1 result-shape checks at call sites. */
export const appendWhenChanged = <T>(
  target: T[],
  value: T,
  result: readonly unknown[],
): void => {
  if (changedExactlyOne(result)) target.push(value)
}

/** Completes a guarded write without repeating the race-result branch in controllers. */
export const completeGuardedOperation = async <T>(
  changed: boolean,
  failureMessage: string,
  read: () => Promise<T | null>,
  invariantMessage: string,
): Promise<SebResult<T>> => {
  if (!changed) return failure(failureMessage)
  return success(requireInvariant(await read(), invariantMessage))
}

/** Normalization functions normally provide a reason; retain a safe fallback defensively. */
export const validationFailureMessage = (
  message: string | null,
  fallback: string,
): string => message ?? fallback

/** Picks the first safe field-validation message with a defensive fallback. */
export const firstValidationIssueMessage = (
  issues: ReadonlyArray<{ message: string }>,
  fallback: string,
): string => issues.length > 0 ? issues[0].message : fallback
