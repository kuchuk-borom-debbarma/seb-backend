/**
 * What an applicant does with their own records: the enterprise they apply
 * for, the application itself, and the evidence attached to it.
 *
 * Every act here is the applicant's own, so the subject is the actor. What is
 * recorded is the fact of the act and the handful of values that say which
 * version it produced — never the answers, a file's name, where it is stored,
 * or anything it contains. The application and the document hold those; the
 * history says when and by whom they changed.
 */
import { z } from 'zod'
import { code, count, reasonText, REASON_FIELD, version, VERSION_FIELD } from './fields'
import { defineAudit } from './types'

const enterpriseStatus = z.enum(['PROPOSED', 'ACTIVE'])

/*
 * Deletion and restoration share one shape — a reason on the way out, none on
 * the way back — because each pair is chosen by a ternary at its call site,
 * and one schema is what lets the compiler check whichever branch runs.
 */
const deletionChange = z.strictObject({ reason: reasonText.optional() })
const deletionFields = { reason: REASON_FIELD } as const

const submission = z.strictObject({
  referenceNumber: code,
  version,
  applicationCategory: z.enum(['CATEGORY_A', 'CATEGORY_B']).optional(),
  // Only on a resubmission: how many stages the correction request unlocked.
  revisionStageCount: count.optional(),
})

const submissionFields = {
  referenceNumber: { label: 'Reference', kind: 'TEXT' },
  version: VERSION_FIELD,
  applicationCategory: { label: 'Category', kind: 'ENUM' },
  revisionStageCount: { label: 'Stages corrected', kind: 'COUNT' },
} as const

const documentChange = z.strictObject({ fieldKey: code })

/** A document slot's key, which is the form's question key, not a file name. */
const FIELD_KEY_FIELD = { label: 'Document', kind: 'TEXT' } as const

export const applicationVocabulary = {
  'SEB.ENTERPRISE_CREATED': defineAudit({
    label: 'Registered an enterprise',
    category: 'ENTERPRISE',
    writer: 'application',
    entityTypes: ['SEB_ENTERPRISE'],
    subject: 'ACTOR',
    application: 'NONE',
    // Not the name: the enterprise's identity is business data the enterprise
    // row owns, and the history names the enterprise by reference instead —
    // the read side shows its current name beside the row.
    payload: z.strictObject({ status: enterpriseStatus }),
    fields: { status: { label: 'Status', kind: 'ENUM' } },
    summary: (p) => `Registered ${p.status === 'PROPOSED' ? 'a proposed' : 'an'} enterprise`,
    example: { status: 'ACTIVE' },
  }),
  'SEB.ENTERPRISE_UPDATED': defineAudit({
    label: 'Updated an enterprise',
    category: 'ENTERPRISE',
    writer: 'application',
    entityTypes: ['SEB_ENTERPRISE'],
    subject: 'ACTOR',
    application: 'NONE',
    payload: z.strictObject({ version, status: enterpriseStatus }),
    fields: { version: VERSION_FIELD, status: { label: 'Status', kind: 'ENUM' } },
    summary: (p) => `Updated an enterprise to version ${p.version}`,
    example: { version: 2, status: 'ACTIVE' },
  }),
  'SEB.ENTERPRISE_DELETED': defineAudit({
    label: 'Removed an enterprise',
    category: 'ENTERPRISE',
    writer: 'application',
    entityTypes: ['SEB_ENTERPRISE'],
    subject: 'ACTOR',
    application: 'NONE',
    payload: deletionChange,
    fields: deletionFields,
    summary: () => 'Removed an enterprise',
    example: { reason: 'Registered twice by mistake.' },
  }),
  'SEB.ENTERPRISE_RESTORED': defineAudit({
    label: 'Restored an enterprise',
    category: 'ENTERPRISE',
    writer: 'application',
    entityTypes: ['SEB_ENTERPRISE'],
    subject: 'ACTOR',
    application: 'NONE',
    payload: deletionChange,
    fields: deletionFields,
    summary: () => 'Restored an enterprise',
    example: {},
  }),
  'SEB.APPLICATION_STARTED': defineAudit({
    label: 'Started an application',
    category: 'APPLICATION',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: z.strictObject({
      type: z.enum(['INITIAL', 'EXPANSION']),
      phaseNumber: z.number().int().positive(),
      enterpriseId: z.string().min(1),
      programmeCycleId: z.string().min(1),
    }),
    fields: {
      type: { label: 'Type', kind: 'ENUM' },
      phaseNumber: { label: 'Phase', kind: 'COUNT' },
      enterpriseId: { label: 'Enterprise', kind: 'ENTERPRISE' },
      programmeCycleId: { label: 'Cycle', kind: 'CYCLE' },
    },
    summary: (p, name) =>
      `Started ${p.type === 'EXPANSION' ? `a phase ${p.phaseNumber} expansion` : 'an initial application'} in ${name('CYCLE', p.programmeCycleId)}`,
    example: {
      type: 'INITIAL',
      phaseNumber: 1,
      enterpriseId: '00000000-0000-4000-8000-000000000010',
      programmeCycleId: '00000000-0000-4000-8000-000000000011',
    },
  }),
  'SEB.APPLICATION_SAVED': defineAudit({
    label: 'Saved an application draft',
    category: 'APPLICATION',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    // The answers are never copied: the version row holds them, and this says
    // which version the save produced.
    payload: z.strictObject({ version }),
    fields: { version: VERSION_FIELD },
    summary: (p) => `Saved draft version ${p.version}`,
    example: { version: 3 },
  }),
  'SEB.APPLICATION_DELETED': defineAudit({
    label: 'Deleted an application draft',
    category: 'APPLICATION',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: deletionChange,
    fields: deletionFields,
    summary: () => 'Deleted an application draft',
    example: { reason: 'Started in the wrong cycle.' },
  }),
  'SEB.APPLICATION_RESTORED': defineAudit({
    label: 'Restored an application draft',
    category: 'APPLICATION',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: deletionChange,
    fields: deletionFields,
    summary: () => 'Restored an application draft',
    example: {},
  }),
  'SEB.APPLICATION_SUBMITTED': defineAudit({
    label: 'Submitted an application',
    category: 'APPLICATION',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: submission,
    fields: submissionFields,
    summary: (p) => `Submitted application ${p.referenceNumber}`,
    example: { referenceNumber: 'SEP-2026-000123', version: 4, applicationCategory: 'CATEGORY_A' },
  }),
  'SEB.APPLICATION_RESUBMITTED': defineAudit({
    label: 'Resubmitted an application',
    category: 'APPLICATION',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: submission,
    fields: submissionFields,
    summary: (p) => `Resubmitted application ${p.referenceNumber} with corrections`,
    example: { referenceNumber: 'SEP-2026-000123', version: 6, revisionStageCount: 2 },
  }),
  'SEB.SUBMISSION_CONFIRMATION_FAILED': defineAudit({
    label: 'Could not send a submission confirmation',
    category: 'APPLICATION',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: z.strictObject({}),
    fields: {},
    summary: () => 'The submission confirmation could not be delivered',
    example: {},
  }),
  'SEB.DOCUMENT_UPLOAD_ISSUED': defineAudit({
    label: 'Began uploading a document',
    category: 'DOCUMENT',
    writer: 'application',
    entityTypes: ['SEB_DOCUMENT_UPLOAD_INTENT'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    // No file name and no storage key: the first is the applicant's text and
    // the second is where the file lives. The intent row keeps both.
    payload: z.strictObject({
      fieldKey: code,
      contentType: code,
      sizeBytes: count,
    }),
    fields: {
      fieldKey: FIELD_KEY_FIELD,
      contentType: { label: 'File type', kind: 'TEXT' },
      sizeBytes: { label: 'Size (bytes)', kind: 'COUNT' },
    },
    summary: (p) => `Began uploading ${p.fieldKey}`,
    example: { fieldKey: 'ST_CERTIFICATE', contentType: 'application/pdf', sizeBytes: 182_044 },
  }),
  'SEB.DOCUMENT_FINALIZED': defineAudit({
    label: 'Attached a document',
    category: 'DOCUMENT',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION_DOCUMENT'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: z.strictObject({
      fieldKey: code,
      version,
      contentType: code,
      sizeBytes: count,
    }),
    fields: {
      fieldKey: FIELD_KEY_FIELD,
      version: VERSION_FIELD,
      contentType: { label: 'File type', kind: 'TEXT' },
      sizeBytes: { label: 'Size (bytes)', kind: 'COUNT' },
    },
    summary: (p) => `Attached version ${p.version} of ${p.fieldKey}`,
    example: { fieldKey: 'ST_CERTIFICATE', version: 1, contentType: 'application/pdf', sizeBytes: 182_044 },
  }),
  'SEB.DOCUMENT_DELETED': defineAudit({
    label: 'Removed a document',
    category: 'DOCUMENT',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION_DOCUMENT'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: documentChange,
    fields: { fieldKey: FIELD_KEY_FIELD },
    summary: (p) => `Removed ${p.fieldKey}`,
    example: { fieldKey: 'ST_CERTIFICATE' },
  }),
  'SEB.DOCUMENT_RESTORED': defineAudit({
    label: 'Restored a document',
    category: 'DOCUMENT',
    writer: 'application',
    entityTypes: ['SEB_APPLICATION_DOCUMENT'],
    subject: 'ACTOR',
    application: 'REQUIRED',
    payload: documentChange,
    fields: { fieldKey: FIELD_KEY_FIELD },
    summary: (p) => `Restored ${p.fieldKey}`,
    example: { fieldKey: 'ST_CERTIFICATE' },
  }),
} as const
