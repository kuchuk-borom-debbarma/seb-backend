/**
 * Reading the audit history, and taking a copy of it.
 *
 * Two permissions guard everything here. `audit`/`read` opens the history;
 * `audit`/`export` additionally lets a reader take a file of it away. Both are
 * catalogue pairs like any other, so the office may compose a role holding
 * either, but both are worth composing deliberately: the history carries more
 * about people than any other read in the portal — who did what, from which
 * address, with which browser, across every applicant and every member of
 * staff — and an export outlives every permission that allowed it.
 *
 * Every operation establishes authority before it reads anything, including
 * before it validates: a refusal that depended on the request would tell an
 * unauthorized caller something about what they asked for.
 */
import { z } from 'zod'
import { authenticatedWithPermission } from '../../auth'
import { decodeCursor, encodeCursor, pageSize, type SortKey } from '../../application/pagination'
import { auditEventRow, insertAuditEvent } from '../../audit-event'
import { auditSpecOf, auditCategoryOf } from '../../audit-vocabulary'
import { auditReason } from '../../audit-vocabulary/fields'
import { auditCategories } from '../../audit-vocabulary/types'
import { failure, success } from '../../envelope'
import { auditCsv } from '../csv'
import { humanize, presentAuditEvent, referencesWanted } from '../present'
import {
  exportAuditRows,
  findAuditPeople,
  findAuditRow,
  listAuditEvents,
  listRecordedActions,
  listSameRequestRows,
  MAX_ACTION_FILTER,
  MAX_ENTITY_TYPE_FILTER,
  MAX_EXPORT_ROWS,
  MAX_PEOPLE_FILTER,
  resolveReferences,
  type AuditRow,
} from '../queries/audit'
import { AUDIT_REQUIRED_MESSAGE, INVALID_REQUEST_MESSAGE } from '../support'
import type {
  AuditActionName,
  AuditActor,
  AuditConnection,
  AuditEvent,
  AuditEventDetail,
  AuditExport,
  AuditFilter,
  AuditOperationContext,
  AuditOrder,
  AuditResult,
} from '../types'

/** The filter as a caller sends it: every field optional and unvalidated. */
export type AuditFilterInput = {
  actorUserIds?: string[] | null
  actorRole?: string | null
  subjectUserIds?: string[] | null
  involvingUserId?: string | null
  categories?: string[] | null
  actions?: string[] | null
  entityTypes?: string[] | null
  entityId?: string | null
  applicationId?: string | null
  applicationReference?: string | null
  outcome?: 'SUCCESS' | 'FAILURE' | null
  from?: Date | null
  to?: Date | null
  requestId?: string | null
}

export type AuditQueryInput = {
  first?: number | null
  after?: string | null
  order?: AuditOrder | null
  filter?: AuditFilterInput | null
}

const uuid = z.uuid()
const shortText = (max: number) => z.string().trim().min(1).max(max)
const category = z.enum(auditCategories)

/**
 * The filter a request may ask for, bounded.
 *
 * Each bound is a backstop well above real use — nobody picks fifty people —
 * that stops one request describing arbitrary work. Identifiers are checked as
 * identifiers so a malformed one is a refusal the caller can act on, not an
 * empty page they cannot explain.
 */
const filterSchema = z.strictObject({
  actorUserIds: z.array(uuid).max(MAX_PEOPLE_FILTER).nullish(),
  actorRole: shortText(64).nullish(),
  subjectUserIds: z.array(uuid).max(MAX_PEOPLE_FILTER).nullish(),
  involvingUserId: uuid.nullish(),
  categories: z.array(category).max(auditCategories.length).nullish(),
  actions: z.array(shortText(100)).max(MAX_ACTION_FILTER).nullish(),
  entityTypes: z.array(shortText(64)).max(MAX_ENTITY_TYPE_FILTER).nullish(),
  // Not a UUID: `'BOARD'` is a real entity id.
  entityId: shortText(128).nullish(),
  applicationId: uuid.nullish(),
  applicationReference: shortText(64).nullish(),
  outcome: z.enum(['SUCCESS', 'FAILURE']).nullish(),
  from: z.date().nullish(),
  to: z.date().nullish(),
  requestId: shortText(128).nullish(),
})

/** A validated filter, or the sentence that says what was wrong with it. */
const validFilter = (input: AuditFilterInput | null | undefined): AuditFilter | string => {
  const parsed = filterSchema.safeParse(input ?? {})
  if (!parsed.success) return INVALID_REQUEST_MESSAGE
  const filter = parsed.data as AuditFilter
  // An inverted range is a mistake rather than an empty result, and saying so
  // is more useful than returning nothing and letting somebody wonder.
  if (filter.from && filter.to && filter.from > filter.to) {
    return 'The start of the range is after its end.'
  }
  return filter
}

/** The cursor key for a direction — see `SortKey`. */
const cursorKey = (order: AuditOrder): SortKey => (order === 'NEWEST_FIRST' ? 'auditNewest' : 'auditOldest')

/** Rows read, named in one statement, and written out as events. */
const presented = async (context: AuditOperationContext, rows: readonly AuditRow[]): Promise<AuditEvent[]> => {
  const names = await resolveReferences(context.db, referencesWanted(rows))
  return rows.map((row) => presentAuditEvent(row, names))
}

const readerOf = (context: AuditOperationContext) => authenticatedWithPermission(context, 'audit', 'read')

/** One page of the history. */
export const auditEvents = async (
  input: AuditQueryInput,
  context: AuditOperationContext,
): Promise<AuditResult<AuditConnection>> => {
  // Authority first. Nothing below may describe anybody's activity to a caller
  // who has not proved they may read it.
  if (!(await readerOf(context))) return failure(AUDIT_REQUIRED_MESSAGE)

  const first = pageSize(input.first)
  if (first === null) return failure(INVALID_REQUEST_MESSAGE)
  const order = input.order ?? 'NEWEST_FIRST'
  const after = decodeCursor(input.after, cursorKey(order))
  if (after === 'INVALID') return failure(INVALID_REQUEST_MESSAGE)
  const filter = validFilter(input.filter)
  if (typeof filter === 'string') return failure(filter)

  const page = await listAuditEvents(context.db, { first, after, order, filter })
  const last = page.rows.at(-1)
  return success({
    nodes: await presented(context, page.rows),
    pageInfo: {
      endCursor: last ? encodeCursor(cursorKey(order), last.createdAt, last.id) : null,
      hasNextPage: page.hasNextPage,
      totalCount: page.totalCount,
    },
  })
}

/** One event, with the others its request produced. */
export const auditEvent = async (
  id: string,
  context: AuditOperationContext,
): Promise<AuditResult<AuditEventDetail>> => {
  if (!(await readerOf(context))) return failure(AUDIT_REQUIRED_MESSAGE)
  if (!shortText(128).safeParse(id).success) return failure(INVALID_REQUEST_MESSAGE)
  const row = await findAuditRow(context.db, id)
  if (!row) return failure('That entry was not found.')
  const sameRequest = await listSameRequestRows(context.db, row)
  // Named together, so the entry and its neighbours cost one reference read.
  const [event, ...others] = await presented(context, [row, ...sameRequest])
  return success({ event: event as AuditEvent, sameRequest: others })
}

/**
 * People for the history's person filter: one exact address, or ids already
 * in the URL.
 */
export const auditPeople = async (
  input: { email?: string | null; ids?: string[] | null },
  context: AuditOperationContext,
): Promise<AuditResult<AuditActor[]>> => {
  if (!(await readerOf(context))) return failure(AUDIT_REQUIRED_MESSAGE)
  // Exactly one of the two, so the question is never ambiguous.
  if (Boolean(input.email) === Boolean(input.ids?.length)) return failure(INVALID_REQUEST_MESSAGE)
  if (input.email) {
    const email = z.email().max(254).safeParse(input.email.trim().toLowerCase())
    if (!email.success) return failure('Enter a whole email address.')
    return success(await findAuditPeople(context.db, { email: email.data }))
  }
  const ids = z.array(uuid).max(MAX_PEOPLE_FILTER).safeParse(input.ids)
  if (!ids.success) return failure(INVALID_REQUEST_MESSAGE)
  return success(await findAuditPeople(context.db, { ids: ids.data }))
}

/** The actions that occur in the history, labelled and grouped for a filter. */
export const auditActionNames = async (
  context: AuditOperationContext,
): Promise<AuditResult<AuditActionName[]>> => {
  if (!(await readerOf(context))) return failure(AUDIT_REQUIRED_MESSAGE)
  const recorded = await listRecordedActions(context.db)
  return success(
    recorded.map((action) => ({
      action,
      label: auditSpecOf(action)?.label ?? humanize(action),
      category: auditCategoryOf(action),
    })),
  )
}

/**
 * The filter as the export's audit row records it: dates as ISO text, empty
 * fields left out, so the record reads as what was actually asked.
 */
const recordedFilter = (filter: AuditFilter): Record<string, string | string[]> =>
  Object.fromEntries(
    Object.entries(filter)
      .filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
      .map(([key, value]) => [key, value instanceof Date ? value.toISOString() : (value as string | string[])]),
  )

/**
 * The filtered history as a CSV file.
 *
 * **There is no export without its record.** The audit row is written before
 * the file is returned, and a failure writing it fails the export: a copy of
 * the history that left without being recorded is exactly what this row exists
 * to prevent. The rows themselves are not copied into it — they are still in
 * the table — but who took them, which filter chose them and why are recorded
 * nowhere else.
 */
export const exportAuditEvents = async (
  input: { filter?: AuditFilterInput | null; purpose: string },
  context: AuditOperationContext,
): Promise<AuditResult<AuditExport>> => {
  const exporter = await authenticatedWithPermission(context, 'audit', 'export')
  if (!exporter) return failure(AUDIT_REQUIRED_MESSAGE)
  // Exporting is reading and then more, so it needs both pairs. A role given
  // only `export` would otherwise take away what it may not look at.
  if (!(await readerOf(context))) return failure(AUDIT_REQUIRED_MESSAGE)

  const purpose = auditReason(input.purpose)
  if (!purpose) return failure('Say why this history is being exported.')
  const filter = validFilter(input.filter)
  if (typeof filter === 'string') return failure(filter)

  const rows = await exportAuditRows(context.db, filter)
  const truncated = rows.length > MAX_EXPORT_ROWS
  const kept = rows.slice(0, MAX_EXPORT_ROWS)
  const events = await presented(context, kept)
  const exportedAt = new Date()

  await insertAuditEvent(
    context.db,
    auditEventRow(context, {
      action: 'AUDIT.EXPORTED',
      entityType: 'CORE_AUDIT_EXPORT',
      entityId: crypto.randomUUID(),
      actorUserId: exporter.user.id,
      payload: { purpose, filters: recordedFilter(filter), rowCount: kept.length, truncated, format: 'CSV' },
      createdAt: exportedAt,
    }),
  )

  return success({
    filename: `activity-history-${exportedAt.toISOString().slice(0, 19).replaceAll(':', '-')}.csv`,
    csv: auditCsv(events),
    rowCount: kept.length,
    truncated,
  })
}
