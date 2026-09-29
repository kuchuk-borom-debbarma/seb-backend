/**
 * The one audit row every service writes, and the one statement that writes it.
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
 * ## What a row says is declared, not improvised
 *
 * Every action names its payload in `audit-vocabulary`. The builder takes the
 * action as a literal type, so a call site passing the wrong payload for its
 * action does not compile, and parses the payload against the action's schema
 * before building anything, so a value the type could not see — a reason over
 * the limit, an address that is not one — fails the write rather than entering
 * the history. That is fail-closed on purpose: the audit row shares a
 * transaction with the business write it records, and a write whose evidence
 * cannot be kept should not happen either.
 *
 * ## What stays with each service
 *
 * Every service keeps its own thin wrapper — `adminAudit`, `auditEvent`,
 * `announcementAudit`, `auditRecord` — narrowed with {@link ActionWrittenBy} to
 * the actions that service may write, so a controller naming another service's
 * action does not compile.
 *
 * ## Request metadata is opt-out, and only for a caller-text-free action
 *
 * The labels below are caller-controlled: a client sends its own `User-Agent`
 * and can send its own `X-Request-ID`. That is acceptable evidence for an
 * ordinary operation and worth having. It is not acceptable for the
 * credential-bearing maintenance paths, which pass `includeRequestMetadata:
 * false` so an unauthenticated caller cannot write chosen text into the history
 * of an operation that runs without a session. Opting out is refused for an
 * action whose payload could itself carry caller text — the vocabulary marks
 * the ones that cannot as `callerTextFree` — because dropping the header while
 * keeping the same text in the payload would be the same hole with a different
 * name.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { Database, Transaction } from '../db'
import { coreAuditEvent, sebApplication, type AuditAction } from '../db/schema'
import { auditVocabulary, type AuditVocabulary } from './audit-vocabulary'
import type { AuditSpec, AuditWriter } from './audit-vocabulary/types'

type Spec<A extends AuditAction> = AuditVocabulary[A]

/** The payload one action records, exactly as its schema declares it. */
export type AuditPayload<A extends AuditAction> = z.input<Spec<A>['payload']>

/** The actions one service may write — how each wrapper narrows. */
export type ActionWrittenBy<W extends AuditWriter> = {
  [A in AuditAction]: Spec<A>['writer'] extends W ? A : never
}[AuditAction]

/**
 * An application-linked action must say which application; any other must
 * not. Required at the type level so the per-application history cannot lose
 * an event to a call site that forgot.
 *
 * `SQL` is allowed so a write that holds only a child row's id — a recovery
 * case — can derive the application inside the same statement instead of
 * reading it first.
 */
type ApplicationLink<A extends AuditAction> = Spec<A>['application'] extends 'REQUIRED'
  ? { applicationId: string | SQL }
  : { applicationId?: undefined }

/** What a caller supplies. Everything else is derived. */
export type AuditEventInput<A extends AuditAction> = {
  action: A
  entityType: Spec<A>['entityTypes'][number]
  entityId?: string | null
  actorUserId?: string | null
  outcome?: 'SUCCESS' | 'FAILURE'
  payload: AuditPayload<A>
  createdAt?: Date
  /** False on the maintenance paths — see the module comment. */
  includeRequestMetadata?: boolean
} & ApplicationLink<A>

/**
 * The row as {@link insertAuditEventWhere} writes it.
 *
 * Not the table's `$inferInsert`: two columns may be SQL evaluated inside the
 * insert — the applicant of an application, an application reached through a
 * child row — so they are derived by the same statement that writes the row,
 * never by a read taken before it.
 */
export type AuditEventRecord = {
  id: string
  actorUserId: string | null
  action: AuditAction
  entityType: string
  entityId: string | null
  outcome: 'SUCCESS' | 'FAILURE'
  requestId: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  subjectUserId: string | SQL | null
  applicationId: string | SQL | null
  /** The parsed payload as JSON text, cast to `jsonb` by the insert. */
  payload: string
}

/**
 * Parses a payload against its action's schema, failing closed.
 *
 * The thrown error names the action and the offending keys and nothing else.
 * Zod's own message quotes the values, and a value here can be an operator's
 * reason or an address — neither belongs in a Worker log.
 */
const parsedPayload = (spec: AuditSpec, action: AuditAction, payload: unknown): unknown => {
  const parsed = spec.payload.safeParse(payload)
  if (parsed.success) return parsed.data
  const keys = parsed.error.issues.map((issue) => issue.path.join('.') || '(payload)')
  throw new Error(`The ${action} audit payload does not match its schema at: ${keys.join(', ')}.`)
}

/** Who the event is about, by the action's declared rule. */
const subjectOf = (
  spec: AuditSpec,
  input: { actorUserId?: string | null; entityId?: string | null },
  applicationId: string | SQL | null,
  payload: Record<string, unknown>,
): string | SQL | null => {
  const rule = spec.subject
  if (rule === 'ACTOR') return input.actorUserId ?? null
  if (rule === 'ENTITY') return input.entityId ?? null
  if (rule === 'NONE') return null
  if (rule === 'APPLICANT') {
    // Inside the insert, so it is the applicant at the instant of the write —
    // the same instant the guarded business statement saw.
    return applicationId === null
      ? null
      : sql`(SELECT ${sebApplication.applicantUserId} FROM ${sebApplication} WHERE ${sebApplication.id} = ${applicationId})`
  }
  const named = payload[rule.payload as string]
  return typeof named === 'string' ? named : null
}

/**
 * Builds one declared, validated audit row.
 *
 * The context is asked only for its request headers, so this is reachable from
 * every service's own operation context without any of them depending on
 * another's.
 */
export const auditEventRow = <A extends AuditAction>(
  context: { requestHeaders: Headers },
  input: AuditEventInput<A>,
): AuditEventRecord => {
  const spec = auditVocabulary[input.action] as AuditSpec
  const labelled = input.includeRequestMetadata ?? true
  if (!labelled && !spec.callerTextFree) {
    throw new Error(`${input.action} may carry caller text, so it cannot drop its request labels.`)
  }
  const payload = parsedPayload(spec, input.action, input.payload) as Record<string, unknown>
  const applicationId = input.applicationId ?? null
  return {
    // Minted here, before any statement runs, because later statements in the
    // same batch prove the write landed by finding this exact row.
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
    createdAt: input.createdAt ?? new Date(),
    subjectUserId: subjectOf(spec, input, applicationId, payload),
    applicationId,
    payload: JSON.stringify(payload),
  }
}

/**
 * Writes one audit row when `predicate` holds, as part of whatever batch the
 * caller is building.
 *
 * **The only statement in the codebase that writes this table.** Every guarded
 * write records itself by putting this in the same batch as the business
 * statement, conditioned on the business statement having landed, so the two
 * are one fact: a losing writer writes no audit row, and a winning one cannot
 * lose its evidence. `check:audit` refuses an `insert(coreAuditEvent)` anywhere
 * else, because a second copy of this list is how twenty-five of them came to
 * write no request labels.
 *
 * drizzle names every column of the table in declaration order, so the
 * expressions below follow `src/db/schema/core/audit.ts` exactly. `changes_json`
 * has never been written; `metadata_json` is the legacy generation's column
 * and stays NULL on a typed row.
 */
export const insertAuditEventWhere = (
  db: Database | Transaction,
  row: AuditEventRecord,
  predicate: SQL,
) =>
  db.insert(coreAuditEvent).select(sql`
    SELECT ${row.id}, ${row.actorUserId}, ${row.action}, ${row.entityType}, ${row.entityId},
      ${row.outcome}, ${row.requestId}, ${row.ipAddress}, ${row.userAgent},
      NULL, NULL, ${row.createdAt},
      ${row.subjectUserId}, ${row.applicationId}, ${row.payload}::jsonb, 1
    WHERE ${predicate}
  `)

/** Writes one audit row unconditionally — a refusal, or a best-effort record. */
export const insertAuditEvent = async (
  db: Database | Transaction,
  row: AuditEventRecord,
): Promise<void> => {
  await insertAuditEventWhere(db, row, sql`TRUE`)
}
