/**
 * Turning a stored audit row into something a person reads.
 *
 * Pure: every name it needs has already been read, in one statement, by
 * `resolveReferences`. That split is what keeps a page at three statements —
 * this module decides what to look up, the query looks it all up at once, and
 * this module writes the sentences.
 *
 * Two generations of row come through here. A typed row is read through its
 * action's declaration: labelled fields, references resolved, a summary
 * sentence. A legacy row — written before actions declared their payloads — is
 * shown exactly as it was recorded, key by key, and says so; restating it in
 * the new shape would be the history editing itself.
 */
import { auditSpecOf, auditCategoryOf } from '../audit-vocabulary'
import { auditReferenceKinds, type AuditReferenceKind, type AuditSpec } from '../audit-vocabulary/types'
import type { AuditRow, ReferenceNames, ReferenceRequest } from './queries/audit'
import type { AuditDetail, AuditEvent, AuditReference } from './types'

/** The two authorities decided in code have no role row to be named by. */
const BUILTIN_ROLE_NAMES: Record<string, string> = {
  APPLICANT: 'Applicant',
  SUPER_ADMIN: 'Super administrator',
}

const referenceKinds = new Set<string>(auditReferenceKinds)
const isReferenceKind = (kind: string): kind is AuditReferenceKind => referenceKinds.has(kind)

/** `SEB.DECISION_RECORDED` → "Decision recorded"; `subjectUserId` → "Subject user id". */
export const humanize = (value: string): string => {
  const words = value
    .replace(/^[A-Z]+\./u, '')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/_/gu, ' ')
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A typed row's payload, parsed again on read — or null if it no longer fits. */
const typedPayload = (row: AuditRow): { spec: AuditSpec; payload: Record<string, unknown> } | null => {
  if (row.payloadVersion !== 1) return null
  const spec = auditSpecOf(row.action)
  if (!spec) return null
  /*
   * Parsed rather than trusted. A payload was valid when it was written, but a
   * later build may have changed its action's schema; a summary written for
   * the new shape must not be handed the old one. A row that no longer fits is
   * shown as recorded instead, like a legacy row.
   */
  const parsed = spec.payload.safeParse(row.payload)
  return parsed.success ? { spec, payload: parsed.data as Record<string, unknown> } : null
}

/** Every id a set of rows will need named, in one request for one statement. */
export const referencesWanted = (rows: readonly AuditRow[]): ReferenceRequest => {
  const wanted: ReferenceRequest = {
    USER: new Set(),
    ROLE: new Set(),
    APPLICATION: new Set(),
    ENTERPRISE: new Set(),
    CYCLE: new Set(),
  }
  for (const row of rows) {
    if (row.applicationId) wanted.APPLICATION.add(row.applicationId)
    const typed = typedPayload(row)
    if (!typed) continue
    for (const [key, field] of Object.entries(typed.spec.fields)) {
      const value = typed.payload[key]
      if (typeof value !== 'string' || !isReferenceKind(field.kind)) continue
      if (field.kind === 'ROLE' && value in BUILTIN_ROLE_NAMES) continue
      wanted[field.kind].add(value)
    }
  }
  return wanted
}

/** The fallback for a record that could not be found — never a bare id. */
const UNKNOWN: Record<AuditReferenceKind, string> = {
  USER: 'an unknown person',
  ROLE: 'an unknown role',
  APPLICATION: 'an unknown application',
  ENTERPRISE: 'an unknown enterprise',
  CYCLE: 'an unknown cycle',
}

const referenceOf = (kind: AuditReferenceKind, id: string, names: ReferenceNames): AuditReference => {
  if (kind === 'ROLE' && id in BUILTIN_ROLE_NAMES) {
    return { id, label: BUILTIN_ROLE_NAMES[id] ?? null, exists: true }
  }
  const found = names[kind].has(id)
  return { id, label: found ? (names[kind].get(id) ?? null) : null, exists: found }
}

/** Names a reference in a sentence: its label, or what it is when it has none. */
const namerFor = (names: ReferenceNames) => (kind: AuditReferenceKind, id: string): string => {
  const reference = referenceOf(kind, id, names)
  if (reference.label) return reference.label
  if (kind === 'APPLICATION' && reference.exists) return 'a draft application'
  if (kind === 'ROLE') return humanize(id)
  return UNKNOWN[kind]
}

/** A payload value as text, the one form every kind can be sent in. */
const asText = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

const typedDetails = (spec: AuditSpec, payload: Record<string, unknown>, names: ReferenceNames): AuditDetail[] =>
  Object.entries(spec.fields)
    .filter(([key]) => payload[key] !== undefined)
    .map(([key, field]) => {
      const value = asText(payload[key])
      return {
        key,
        label: field.label,
        kind: field.kind,
        value,
        reference: value !== null && isReferenceKind(field.kind) ? referenceOf(field.kind, value, names) : null,
      }
    })

/** A legacy row's metadata, key by key, exactly as it was stored. */
const legacyDetails = (row: AuditRow): AuditDetail[] => {
  const recorded = row.payloadVersion === 1 ? row.payload : row.metadataJson
  if (recorded === null || recorded === undefined) return []
  let parsed: unknown = recorded
  if (typeof recorded === 'string') {
    try {
      parsed = JSON.parse(recorded)
    } catch {
      return [{ key: 'recorded', label: 'Recorded', kind: 'TEXT', value: recorded, reference: null }]
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [{ key: 'recorded', label: 'Recorded', kind: 'TEXT', value: asText(parsed), reference: null }]
  }
  return Object.entries(parsed).map(([key, value]) => ({
    key,
    label: humanize(key),
    kind: 'TEXT' as const,
    value: asText(value),
    reference: null,
  }))
}

/** One stored row, read. */
export const presentAuditEvent = (row: AuditRow, names: ReferenceNames): AuditEvent => {
  const spec = auditSpecOf(row.action)
  const typed = typedPayload(row)
  const actionLabel = spec?.label ?? humanize(row.action)
  return {
    id: row.id,
    action: row.action,
    actionLabel,
    category: auditCategoryOf(row.action),
    summary: typed ? typed.spec.summary(typed.payload, namerFor(names)) : actionLabel,
    detailed: typed !== null,
    entityType: row.entityType,
    entityId: row.entityId,
    outcome: row.outcome,
    actor: row.actor,
    subject: row.subject,
    application: row.applicationId ? referenceOf('APPLICATION', row.applicationId, names) : null,
    details: typed ? typedDetails(typed.spec, typed.payload, names) : legacyDetails(row),
    payloadJson:
      row.payloadVersion === 1 ? JSON.stringify(row.payload) : row.metadataJson,
    requestId: row.requestId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  }
}
