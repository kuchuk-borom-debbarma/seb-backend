/**
 * The activity history as a CSV file.
 *
 * Written by hand rather than with a library because the whole of it is one
 * escaping rule and one safety rule, and both are worth being able to read.
 *
 * **The safety rule is formula injection.** A spreadsheet opens a cell that
 * begins with `=`, `+`, `-` or `@` as a formula, and several of these cells
 * hold text somebody else chose — a User-Agent header, an operator's reason, an
 * applicant's enterprise name. An export is opened by exactly the people with
 * the most access, so a crafted value would run with theirs. Such a cell is
 * prefixed with an apostrophe, which every spreadsheet reads as "this is text".
 */
import type { AuditEvent } from './types'

const FORMULA_START = /^[=+\-@\t\r]/u

/** One cell, neutralized and quoted as RFC 4180 requires. */
export const csvCell = (value: string | null): string => {
  if (value === null) return ''
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

const COLUMNS = [
  'id',
  'created_at',
  'category',
  'action',
  'action_label',
  'outcome',
  'actor_id',
  'actor_email',
  'subject_id',
  'subject_email',
  'entity_type',
  'entity_id',
  'application_id',
  'application_reference',
  'request_id',
  'ip_address',
  'user_agent',
  'summary',
  'details',
  'payload_json',
] as const

/** The details as one readable cell: "Label: value; Label: value". */
const detailsCell = (event: AuditEvent): string =>
  event.details
    .map((detail) => `${detail.label}: ${detail.reference?.label ?? detail.value ?? ''}`)
    .join('; ')

const rowOf = (event: AuditEvent): (string | null)[] => [
  event.id,
  event.createdAt.toISOString(),
  event.category,
  event.action,
  event.actionLabel,
  event.outcome,
  event.actor?.id ?? null,
  event.actor?.email ?? null,
  event.subject?.id ?? null,
  event.subject?.email ?? null,
  event.entityType,
  event.entityId,
  event.application?.id ?? null,
  event.application?.label ?? null,
  event.requestId,
  event.ipAddress,
  event.userAgent,
  event.summary,
  detailsCell(event),
  event.payloadJson,
]

/** The whole file, header first, CRLF line endings as the format specifies. */
export const auditCsv = (events: readonly AuditEvent[]): string =>
  [COLUMNS.join(','), ...events.map((event) => rowOf(event).map(csvCell).join(','))].join('\r\n') + '\r\n'
