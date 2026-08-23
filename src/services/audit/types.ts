/**
 * Reading the audit history.
 *
 * The history has been written since the first release and read by nobody: it
 * is what answers "who changed this, and when", and until now the only way to
 * ask was a SQL client. This service is the read side, and it is deliberately
 * only a read side — nothing here writes an audit row. Every service writes its
 * own, inside the same batch as the change it describes, which is what makes
 * the two impossible to separate.
 */
import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'
import type { UserRole } from '../../db/schema'

export type AuditOperationContext = {
  db: Database
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type AuditResult<T> = {
  success: boolean
  message: string | null
  response: T | null
}

/** Newest first is the default because recent activity is what gets read. */
export type AuditOrder = 'NEWEST_FIRST' | 'OLDEST_FIRST'

/**
 * How a caller narrows the history.
 *
 * Every filter is optional and they combine with AND. `actorUserIds` and
 * `actorRole` are the two halves of "selected people, or everybody holding a
 * role" — supplying both narrows to selected people who also hold that role,
 * which is a coherent question rather than a contradiction.
 */
export type AuditFilters = {
  first: number
  after: { timestamp: Date; id: string } | null
  actorUserIds?: readonly string[] | null
  actorRole?: UserRole | null
  applicationId?: string | null
  entityType?: string | null
  action?: readonly string[] | null
  outcome?: 'SUCCESS' | 'FAILURE' | null
  from?: Date | null
  to?: Date | null
  order?: AuditOrder | null
}

/**
 * One recorded event.
 *
 * The actor arrives resolved — id, address and the roles held now — because a
 * bare id is unreadable and a client that had to look each one up would turn a
 * page of fifty into fifty-one requests.
 *
 * `roles` are the roles held **now**, not at the time of the event. The grant
 * history could answer the second question and this deliberately does not try:
 * a column labelled "roles" that sometimes meant one and sometimes the other
 * would be worse than one that always means the same thing.
 */
export type AuditActor = {
  id: string
  email: string
  roles: UserRole[]
}

export type AuditEvent = {
  id: string
  action: string
  entityType: string
  entityId: string | null
  outcome: 'SUCCESS' | 'FAILURE'
  actor: AuditActor | null
  requestId: string | null
  ipAddress: string | null
  userAgent: string | null
  /** Stored JSON text, passed through rather than parsed and reshaped. */
  metadata: string | null
  createdAt: Date
}

/** One page of history, in the shape the GraphQL connection returns. */
export type AuditConnection = {
  nodes: AuditEvent[]
  pageInfo: { endCursor: string | null; hasNextPage: boolean; totalCount: number }
}
