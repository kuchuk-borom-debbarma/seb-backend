/**
 * Shaping the programme: a cycle's policy year, its lifecycle, its guidance,
 * and the policy document it publishes.
 *
 * None of these is about a person or an application, so none carries a
 * subject or an application. What each records is the version it produced and
 * the operator's reason — never the guidance text itself, which lives on the
 * version row and would be a second, drifting copy here.
 */
import { z } from 'zod'
import { auditId, count, isoInstant, label, REASON_FIELD, reasonText, version, VERSION_FIELD } from './fields'
import { defineAudit, type AuditFieldSpecs } from './types'

const CYCLE_ENTITY = ['SEB_PROGRAMME_CYCLE'] as const

/*
 * Opening, closing and archiving are one transition with three targets, chosen
 * by one query helper — so they share one schema, and a call site picking the
 * action with a ternary is checked against the shape it actually writes.
 * `scheduled` tells the hourly close apart from an operator's.
 */
const lifecycle = z.strictObject({ version, reason: reasonText, scheduled: z.boolean() })
const lifecycleFields = {
  version: VERSION_FIELD,
  reason: REASON_FIELD,
  scheduled: { label: 'Closed by the schedule', kind: 'BOOLEAN' },
} as const

/*
 * Guidance and the closing time are revised through one helper on an open
 * cycle. `closesAt` is present only when the closing time is what changed, and
 * `null` there means the closing time was removed.
 */
const openRevision = z.strictObject({
  version,
  reason: reasonText,
  closesAt: isoInstant.nullable().optional(),
})
const openRevisionFields = {
  version: VERSION_FIELD,
  reason: REASON_FIELD,
  closesAt: { label: 'Closes', kind: 'DATETIME' },
} as const

/* Soft deletion and restoration of a draft: the reason exists only on delete. */
const draftRemoval = z.strictObject({ reason: reasonText.optional() })
const draftRemovalFields = { reason: REASON_FIELD } as const

/** A spec about the cycle row itself — every lifecycle and revision act. */
const cycleSpec = <S extends z.ZodObject>(spec: {
  label: string
  payload: S
  fields: AuditFieldSpecs<z.infer<S>>
  summary: (payload: z.infer<S>) => string
  example: z.infer<S>
}) => defineAudit({
  ...spec,
  category: 'PROGRAMME',
  writer: 'admin',
  entityTypes: CYCLE_ENTITY,
  subject: 'NONE',
  application: 'NONE',
})

export const programmeVocabulary = {
  'SEB.CYCLE_CREATED': cycleSpec({
    label: 'Created a programme cycle',
    payload: z.strictObject({
      cycleCode: z.string().min(1).max(32),
      displayName: label,
      cycleYear: z.number().int().min(2000).max(9999),
    }),
    fields: {
      cycleCode: { label: 'Code', kind: 'TEXT' },
      displayName: { label: 'Name', kind: 'TEXT' },
      cycleYear: { label: 'Year', kind: 'COUNT' },
    },
    summary: (p) => `Created the cycle ${p.displayName}`,
    example: { cycleCode: 'SEP-2026', displayName: 'Mission SEP 2026', cycleYear: 2026 },
  }),
  'SEB.CYCLE_UPDATED': cycleSpec({
    label: 'Revised a draft cycle',
    payload: z.strictObject({ version, reason: reasonText }),
    fields: { version: VERSION_FIELD, reason: REASON_FIELD },
    summary: (p) => `Revised a draft cycle to version ${p.version}`,
    example: { version: 2, reason: 'Corrected the age limits.' },
  }),
  'SEB.CYCLE_OPENED': cycleSpec({
    label: 'Opened a cycle',
    payload: lifecycle,
    fields: lifecycleFields,
    summary: () => 'Opened a cycle for applications',
    example: { version: 3, reason: 'Approved by the committee.', scheduled: false },
  }),
  'SEB.CYCLE_CLOSED': cycleSpec({
    label: 'Closed a cycle',
    payload: lifecycle,
    fields: lifecycleFields,
    summary: (p) => (p.scheduled ? 'Closed a cycle at its closing time' : 'Closed a cycle'),
    example: { version: 4, reason: 'SCHEDULED_CLOSING_TIME_REACHED', scheduled: true },
  }),
  'SEB.CYCLE_ARCHIVED': cycleSpec({
    label: 'Archived a cycle',
    payload: lifecycle,
    fields: lifecycleFields,
    summary: () => 'Archived a cycle',
    example: { version: 5, reason: 'Year complete.', scheduled: false },
  }),
  'SEB.CYCLE_GUIDANCE_CHANGED': cycleSpec({
    label: 'Changed an open cycle’s guidance',
    payload: openRevision,
    fields: openRevisionFields,
    summary: () => 'Changed the guidance an open cycle shows',
    example: { version: 4, reason: 'Clarified the bank documents.' },
  }),
  'SEB.CYCLE_CLOSING_CHANGED': cycleSpec({
    label: 'Moved an open cycle’s closing time',
    payload: openRevision,
    fields: openRevisionFields,
    summary: (p) => (p.closesAt ? 'Moved the closing time' : 'Removed the closing time'),
    example: { version: 4, reason: 'Extended by a week.', closesAt: '2026-10-15T12:30:00.000Z' },
  }),
  'SEB.CYCLE_DELETED': cycleSpec({
    label: 'Deleted a draft cycle',
    payload: draftRemoval,
    fields: draftRemovalFields,
    summary: () => 'Deleted a draft cycle',
    example: { reason: 'Created by mistake.' },
  }),
  'SEB.CYCLE_RESTORED': cycleSpec({
    label: 'Restored a draft cycle',
    payload: draftRemoval,
    fields: draftRemovalFields,
    summary: () => 'Restored a draft cycle',
    example: {},
  }),
  'SEB.CYCLE_POLICY_UPLOAD_ISSUED': defineAudit({
    label: 'Authorized a policy document upload',
    category: 'PROGRAMME',
    writer: 'admin',
    entityTypes: ['SEB_CYCLE_POLICY_UPLOAD_INTENT'],
    subject: 'NONE',
    application: 'NONE',
    // No object key and no file name: the key is a storage address and the
    // name is whatever the uploader's disk called it.
    payload: z.strictObject({ cycleId: auditId, sizeBytes: count }),
    fields: {
      cycleId: { label: 'Cycle', kind: 'CYCLE' },
      sizeBytes: { label: 'Size (bytes)', kind: 'COUNT' },
    },
    summary: (p, name) => `Authorized a policy document upload for ${name('CYCLE', p.cycleId)}`,
    example: { cycleId: '00000000-0000-4000-8000-000000000020', sizeBytes: 482_113 },
  }),
  'SEB.CYCLE_POLICY_FINALIZED': defineAudit({
    label: 'Published a policy document',
    category: 'PROGRAMME',
    writer: 'admin',
    entityTypes: ['SEB_CYCLE_POLICY_DOCUMENT'],
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({ cycleId: auditId, version }),
    fields: { cycleId: { label: 'Cycle', kind: 'CYCLE' }, version: VERSION_FIELD },
    summary: (p, name) => `Published version ${p.version} of the policy document for ${name('CYCLE', p.cycleId)}`,
    example: { cycleId: '00000000-0000-4000-8000-000000000020', version: 1 },
  }),
} as const
