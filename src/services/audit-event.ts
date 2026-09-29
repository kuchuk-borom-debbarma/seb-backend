/**
 * The one audit row every service writes.
 *
 * Four services each built this row for themselves, and the four bodies were
 * identical apart from which fields they made mandatory. That is not four
 * decisions — it is one decision copied, and the copy that matters is the
 * request labels: which headers become the audit trail's record of *where a
 * request came from* is a single choice about evidence. Made in four places, a
 * change to it lands in three, and nothing says which one was missed.
 *
 * The same argument as `envelope.ts`, about a different shape.
 *
 * ## What stays with each service
 *
 * Every service keeps its own thin wrapper — `adminAudit`, `auditEvent`,
 * `announcementAudit`, `auditRecord` — because each narrows `action` and
 * `entityType` to the vocabulary that service may write, and a controller
 * naming an action from another service should not compile. What is shared is
 * the row: which columns are filled, from where, and that metadata is stored
 * as JSON rather than as columns nothing queries.
 *
 * ## Request metadata is opt-out, and one caller opts out
 *
 * The labels below are caller-controlled: a client sends its own `User-Agent`
 * and can send its own `X-Request-ID`. That is acceptable evidence for an
 * ordinary operation and worth having. It is not acceptable for the
 * credential-bearing maintenance paths, which pass `includeRequestMetadata:
 * false` so an unauthenticated caller cannot write chosen text into the
 * history of an operation that runs without a session.
 */
import type { coreAuditEvent } from '../db/schema'

/** The audit row as the database takes it. */
export type AuditEventRow = typeof coreAuditEvent.$inferInsert

/**
 * What a caller supplies. Everything else is derived.
 *
 * `metadata` is deliberately narrow — strings, numbers, booleans and nulls, and
 * no nesting. An audit row records that something happened and against what; it
 * is not a second copy of the business record, which would drift from the first
 * and be believed anyway.
 */
export type AuditEventInput = {
  action: string
  entityType: string
  entityId?: string | null
  actorUserId?: string | null
  outcome?: 'SUCCESS' | 'FAILURE'
  metadata?: Record<string, string | number | boolean | null>
  createdAt?: Date
  /** False on the maintenance paths — see the module comment. */
  includeRequestMetadata?: boolean
}

/**
 * Builds one allow-listed audit row.
 *
 * The context is asked only for its request headers, so this is reachable from
 * every service's own operation context without any of them depending on
 * another's.
 */
export const auditEventRow = (
  context: { requestHeaders: Headers },
  input: AuditEventInput,
): AuditEventRow => {
  const labelled = input.includeRequestMetadata ?? true
  return {
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    outcome: input.outcome ?? 'SUCCESS',
    // `CF-Ray` is Cloudflare's own and cannot be forged at the edge; the
    // fallback is the caller's, and is why the maintenance paths opt out.
    requestId: labelled
      ? context.requestHeaders.get('CF-Ray') ?? context.requestHeaders.get('X-Request-ID')
      : null,
    ipAddress: labelled ? context.requestHeaders.get('CF-Connecting-IP') : null,
    userAgent: labelled ? context.requestHeaders.get('User-Agent') : null,
    // Nothing writes a change set yet. The column exists for the day something
    // does, and a builder that invented one would be recording a guess.
    changesJson: null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: input.createdAt ?? new Date(),
  }
}
