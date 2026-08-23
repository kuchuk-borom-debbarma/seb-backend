/**
 * Reading the audit history.
 *
 * One capability guards everything here — `AUDIT_READ`, which only
 * `SUPER_ADMIN` holds. That is a deliberately narrow gate, because the history
 * carries more about people than any other read in the portal: who did what,
 * from which address, with which browser, across every applicant and every
 * member of staff.
 *
 * The filters are validated here so a caller learns which one was wrong; the
 * query decides what is actually returned.
 */
import { z } from 'zod'
import { authenticatedWithCapability } from '../../auth'
import { decodeCursor, pageSize } from '../../application/pagination'
import { listAuditActions, listAuditEvents, MAX_ACTION_FILTER, MAX_ACTOR_FILTER } from '../queries/audit'
import { AUDIT_REQUIRED_MESSAGE, failure, INVALID_REQUEST_MESSAGE, success } from '../support'
import type {
  AuditConnection,
  AuditFilters,
  AuditOperationContext,
  AuditOrder,
  AuditResult,
} from '../types'
import type { UserRole } from '../../../db/schema'

const isIdentifier = (value: string): boolean => z.uuid().safeParse(value).success

export type AuditQueryInput = {
  first?: number | null
  after?: string | null
  actorUserIds?: string[] | null
  actorRole?: UserRole | null
  applicationId?: string | null
  entityType?: string | null
  action?: string[] | null
  outcome?: 'SUCCESS' | 'FAILURE' | null
  from?: Date | null
  to?: Date | null
  order?: AuditOrder | null
}

/**
 * What is wrong with the request, or `null` when nothing is.
 *
 * Separated from building the filters so that reading a request and answering
 * it are two things. Each refusal names what it refused, because "that request
 * could not be understood" is only useful when the caller can tell which part.
 */
const requestRefusal = (input: AuditQueryInput): string | null => {
  const actorUserIds = input.actorUserIds ?? null
  if (actorUserIds && actorUserIds.length > MAX_ACTOR_FILTER) return INVALID_REQUEST_MESSAGE
  if (actorUserIds && !actorUserIds.every(isIdentifier)) return INVALID_REQUEST_MESSAGE
  if ((input.action?.length ?? 0) > MAX_ACTION_FILTER) return INVALID_REQUEST_MESSAGE
  if (input.applicationId && !isIdentifier(input.applicationId)) {
    return INVALID_REQUEST_MESSAGE
  }
  // An inverted range is a mistake rather than an empty result, and saying so
  // is more useful than returning nothing and letting somebody wonder.
  if (input.from && input.to && input.from > input.to) {
    return 'The start of the range is after its end.'
  }
  return null
}

/** The filters a validated request asks for. Pure mapping, no decisions. */
const toFilters = (
  input: AuditQueryInput,
  first: number,
  after: { timestamp: Date; id: string } | null,
): AuditFilters => ({
  first,
  after,
  actorUserIds: input.actorUserIds ?? null,
  actorRole: input.actorRole ?? null,
  applicationId: input.applicationId ?? null,
  entityType: input.entityType ?? null,
  action: input.action ?? null,
  outcome: input.outcome ?? null,
  from: input.from ?? null,
  to: input.to ?? null,
  order: input.order ?? null,
})

export const auditEvents = async (
  input: AuditQueryInput,
  context: AuditOperationContext,
): Promise<AuditResult<AuditConnection>> => {
  // Authority first. Nothing below may describe anybody's activity to a caller
  // who has not proved they may read it.
  const reader = await authenticatedWithCapability(context, 'AUDIT_READ')
  if (!reader) return failure(AUDIT_REQUIRED_MESSAGE)

  const first = pageSize(input.first)
  if (first === null) return failure(INVALID_REQUEST_MESSAGE)
  // Refuses a cursor minted under a different ordering, which would otherwise
  // seek the right column from the wrong direction and return a wrong page
  // with no error at all.
  const after = decodeCursor(input.after, 'createdAt')
  if (after === 'INVALID') return failure(INVALID_REQUEST_MESSAGE)

  const refusal = requestRefusal(input)
  if (refusal) return failure(refusal)

  return success(await listAuditEvents(context.db, toFilters(input, first, after)))
}

/** The action names a filter can offer, taken from what was actually recorded. */
export const auditActionNames = async (
  context: AuditOperationContext,
): Promise<AuditResult<string[]>> => {
  const reader = await authenticatedWithCapability(context, 'AUDIT_READ')
  if (!reader) return failure(AUDIT_REQUIRED_MESSAGE)
  return success(await listAuditActions(context.db))
}
