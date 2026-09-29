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
import type { Envelope } from '../envelope'

/*
 * Re-exported so a caller naming one of the aliases below can name its shape
 * too. Without this the alias would resolve to a type nothing else can reach.
 */
export type { Envelope } from '../envelope'
import type { Loaders } from '../../loaders'

// Re-exported because the operation contexts below name it.
export type { Loaders } from '../../loaders'
import type { Database } from '../../db'

export type AuditOperationContext = {
  db: Database
  /** Per-request batched lookups. Never shared between requests. */
  loaders: Loaders
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type AuditResult<T> = Envelope<T>

/** Newest first is the default because recent activity is what gets read. */
export type AuditOrder = 'NEWEST_FIRST' | 'OLDEST_FIRST'

export type { AuditCategory, AuditDetailKind } from '../audit-vocabulary/types'
import type { AuditCategory, AuditDetailKind } from '../audit-vocabulary/types'

/**
 * How a caller narrows the history. Shared by the page and by the export, so
 * an export always contains exactly the rows the screen was showing.
 *
 * Every filter is optional and they combine with AND. Three of them are about
 * people and answer different questions:
 *
 * - `actorUserIds` — what these people did;
 * - `subjectUserIds` — what was done to these people;
 * - `involvingUserId` — either, for one person: their whole history.
 *
 * `actorRole` narrows to actors holding a role *now*, which is the question a
 * role-scoped reviewer asks; the grant history answers the other one.
 */
export type AuditFilter = {
  actorUserIds?: readonly string[] | null
  actorRole?: string | null
  subjectUserIds?: readonly string[] | null
  involvingUserId?: string | null
  categories?: readonly AuditCategory[] | null
  actions?: readonly string[] | null
  entityTypes?: readonly string[] | null
  entityId?: string | null
  /** Everything that happened to one application: its documents, review, decision and money too. */
  applicationId?: string | null
  /** The same, named by the reference number an officer actually has in hand. */
  applicationReference?: string | null
  outcome?: 'SUCCESS' | 'FAILURE' | null
  from?: Date | null
  to?: Date | null
  requestId?: string | null
}

/** A validated page request. */
export type AuditPageRequest = {
  first: number
  after: { timestamp: Date; id: string } | null
  order: AuditOrder
  filter: AuditFilter
}

/**
 * A person as the history shows them.
 *
 * `roles` are the roles held **now**, not at the time of the event. The grant
 * history could answer the second question and this deliberately does not try:
 * a column labelled "roles" that sometimes meant one and sometimes the other
 * would be worse than one that always means the same thing.
 */
export type AuditActor = {
  id: string
  email: string
  roles: string[]
}

/** Another record an event names, resolved to something a person recognizes. */
export type AuditReference = {
  id: string
  /** An address, a role's name, a reference number — or null when unknown. */
  label: string | null
  /** False when the record no longer exists, so the screen does not link to nothing. */
  exists: boolean
}

/** One labelled value from an event's payload. */
export type AuditDetail = {
  key: string
  label: string
  kind: AuditDetailKind
  /** As recorded, as text: money in paise, dates in ISO form. Null when absent. */
  value: string | null
  reference: AuditReference | null
}

/** One recorded event, read. */
export type AuditEvent = {
  id: string
  action: string
  actionLabel: string
  category: AuditCategory
  /** One sentence a person can read without the details beside it. */
  summary: string
  /** True for a row written with a declared payload; false for one written before. */
  detailed: boolean
  entityType: string
  entityId: string | null
  outcome: 'SUCCESS' | 'FAILURE'
  actor: AuditActor | null
  subject: AuditActor | null
  application: AuditReference | null
  details: AuditDetail[]
  /** The stored payload, or a legacy row's metadata, as JSON text. */
  payloadJson: string | null
  requestId: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
}

/** One page of history, in the shape the GraphQL connection returns. */
export type AuditConnection = {
  nodes: AuditEvent[]
  pageInfo: { endCursor: string | null; hasNextPage: boolean; totalCount: number }
}

/** One event and the others its request produced. */
export type AuditEventDetail = {
  event: AuditEvent
  /** Same request id within ten minutes, oldest first, at most fifty. */
  sameRequest: AuditEvent[]
}

/** An action name a filter can offer, as the screen labels it. */
export type AuditActionName = {
  action: string
  label: string
  category: AuditCategory
}

/** The file an export produced. */
export type AuditExport = {
  filename: string
  csv: string
  rowCount: number
  /** True when the filter matched more rows than one export carries. */
  truncated: boolean
}
