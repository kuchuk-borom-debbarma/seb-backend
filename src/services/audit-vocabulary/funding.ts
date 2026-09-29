/**
 * Public money: the award, what was released against it, how it was used, and
 * what was claimed back.
 *
 * Every event here happened to one application, so each carries that
 * application and names its applicant as the subject. Amounts are recorded as
 * the ledger holds them — integer paise — because a payment the history cannot
 * state the size of is the one question an auditor will ask first.
 */
import { z } from 'zod'
import { rupees } from '../money'
import {
  auditId,
  code,
  empty,
  isoDate,
  isoInstant,
  label,
  paise,
  REASON_CATEGORY_FIELD,
  REASON_FIELD,
  reasonText,
  version,
  VERSION_FIELD,
} from './fields'
import { defineAudit } from './types'


/*
 * Closing and cancelling a recovery case are the same shape — a reason and the
 * version that recorded it — and one controller path chooses between them, so
 * they share one schema.
 */
const recoveryEnd = z.strictObject({ reason: reasonText, version })
const recoveryEndFields = { reason: REASON_FIELD, version: VERSION_FIELD } as const

/**
 * A best-effort message that failed to reach the applicant. The durable record
 * is the award or release itself; what nothing else shows is an applicant who
 * was never told.
 */
const notificationFailed = (subject: string) => defineAudit({
  label: `Could not notify the applicant of ${subject}`,
  category: 'FUNDING',
  writer: 'admin',
  entityTypes: ['SEB_APPLICATION'],
  subject: 'APPLICANT',
  application: 'REQUIRED',
  payload: empty,
  fields: {},
  summary: () => `Could not tell the applicant about ${subject}`,
  example: {},
})

export const fundingVocabulary = {
  'SEB.AWARD_CREATED': defineAudit({
    label: 'Sanctioned a funding award',
    category: 'FUNDING',
    writer: 'admin',
    entityTypes: ['SEB_FUNDING_AWARD'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    // The amount is copied from the decision inside the write and is not known
    // before it; the decision named here is where it came from.
    payload: z.strictObject({ decisionId: auditId, sanctionOrder: label, sanctionDate: isoDate }),
    fields: {
      decisionId: { label: 'Decision', kind: 'ID' },
      sanctionOrder: { label: 'Sanction order', kind: 'TEXT' },
      sanctionDate: { label: 'Sanction date', kind: 'DATE' },
    },
    summary: (p) => `Sanctioned funding under order ${p.sanctionOrder}`,
    example: { decisionId: '00000000-0000-4000-8000-000000000010', sanctionOrder: 'SO/2026/14', sanctionDate: '2026-09-01' },
  }),
  'SEB.AWARD_CHANGED': defineAudit({
    label: 'Changed a funding award',
    category: 'FUNDING',
    writer: 'admin',
    entityTypes: ['SEB_FUNDING_AWARD'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: z.strictObject({
      changeType: z.enum(['AMENDED', 'STATUS_CHANGED']),
      status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED']),
      closureDisposition: z.enum(['RELEASES_COMPLETE', 'REMAINDER_NOT_RELEASED']).optional(),
      amountPaise: paise,
      reasonCategoryId: auditId,
      reason: reasonText,
      version,
    }),
    fields: {
      changeType: { label: 'Change', kind: 'ENUM' },
      status: { label: 'Status', kind: 'ENUM' },
      closureDisposition: { label: 'Closed with', kind: 'ENUM' },
      amountPaise: { label: 'Sanctioned amount', kind: 'MONEY' },
      reasonCategoryId: REASON_CATEGORY_FIELD,
      reason: REASON_FIELD,
      version: VERSION_FIELD,
    },
    summary: (p) =>
      p.changeType === 'AMENDED'
        ? `Amended the award to ${rupees(p.amountPaise)}`
        : `Set the award to ${p.status.toLowerCase()}`,
    example: { changeType: 'STATUS_CHANGED', status: 'SUSPENDED', amountPaise: 50_000_000, reasonCategoryId: 'AWARD_SUSPENDED', reason: 'Audit pending.', version: 2 },
  }),
  'SEB.RELEASE_RECORDED': defineAudit({
    label: 'Released an instalment',
    category: 'FUNDING',
    writer: 'admin',
    entityTypes: ['SEB_DISBURSEMENT'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: z.strictObject({
      awardId: auditId,
      amountPaise: paise,
      occurredAt: isoInstant,
      externalReference: label,
      approvalReference: label,
      ledgerVersion: version,
      physicalVerificationRequired: z.boolean(),
    }),
    fields: {
      awardId: { label: 'Award', kind: 'ID' },
      amountPaise: { label: 'Amount', kind: 'MONEY' },
      occurredAt: { label: 'Paid', kind: 'DATETIME' },
      externalReference: { label: 'Payment reference', kind: 'TEXT' },
      approvalReference: { label: 'Approval reference', kind: 'TEXT' },
      ledgerVersion: { label: 'Ledger version', kind: 'COUNT' },
      physicalVerificationRequired: { label: 'Physical verification required', kind: 'BOOLEAN' },
    },
    summary: (p) => `Released ${rupees(p.amountPaise)}`,
    example: { awardId: '00000000-0000-4000-8000-000000000011', amountPaise: 25_000_000, occurredAt: '2026-09-02T06:30:00.000Z', externalReference: 'UTR123', approvalReference: 'APR/7', ledgerVersion: 1, physicalVerificationRequired: false },
  }),
  'SEB.RELEASE_REVERSED': defineAudit({
    label: 'Reversed a release',
    category: 'FUNDING',
    writer: 'admin',
    entityTypes: ['SEB_DISBURSEMENT'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: z.strictObject({
      releaseId: auditId,
      amountPaise: paise,
      occurredAt: isoInstant,
      externalReference: label,
      reasonCategoryId: auditId,
      ledgerVersion: version,
    }),
    fields: {
      releaseId: { label: 'Release reversed', kind: 'ID' },
      amountPaise: { label: 'Amount', kind: 'MONEY' },
      occurredAt: { label: 'Reversed', kind: 'DATETIME' },
      externalReference: { label: 'Reference', kind: 'TEXT' },
      reasonCategoryId: REASON_CATEGORY_FIELD,
      ledgerVersion: { label: 'Ledger version', kind: 'COUNT' },
    },
    summary: (p) => `Reversed ${rupees(p.amountPaise)} of a release`,
    example: { releaseId: '00000000-0000-4000-8000-000000000012', amountPaise: 1_000_000, occurredAt: '2026-09-03T06:30:00.000Z', externalReference: 'REV-9', reasonCategoryId: 'RELEASE_ERROR', ledgerVersion: 2 },
  }),
  'SEB.ASSESSMENT_RECORDED': defineAudit({
    label: 'Recorded an assessment',
    category: 'FUNDING',
    writer: 'admin',
    entityTypes: ['SEB_AWARD_ASSESSMENT'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: z.strictObject({
      type: code,
      outcome: z.enum(['PASSED', 'FAILED']),
      assessmentNumber: version,
      evidenceReference: label,
      assessedAt: isoInstant,
      obligationId: auditId.optional(),
    }),
    fields: {
      type: { label: 'Assessment', kind: 'ENUM' },
      outcome: { label: 'Outcome', kind: 'ENUM' },
      assessmentNumber: { label: 'Number', kind: 'COUNT' },
      evidenceReference: { label: 'Evidence reference', kind: 'TEXT' },
      assessedAt: { label: 'Assessed', kind: 'DATETIME' },
      obligationId: { label: 'Utilization obligation', kind: 'ID' },
    },
    summary: (p) => `Recorded a ${p.outcome === 'PASSED' ? 'passed' : 'failed'} ${p.type.toLowerCase().replaceAll('_', ' ')} assessment`,
    example: { type: 'UTILIZATION', outcome: 'PASSED', assessmentNumber: 1, evidenceReference: 'UC/2026/3', assessedAt: '2026-09-04T06:30:00.000Z' },
  }),
  'SEB.SANCTION_NOTIFICATION_FAILED': notificationFailed('the sanction'),
  'SEB.RELEASE_NOTIFICATION_FAILED': notificationFailed('a release'),
  'SEB.RECOVERY_OPENED': defineAudit({
    label: 'Opened a recovery case',
    category: 'RECOVERY',
    writer: 'admin',
    entityTypes: ['SEB_RECOVERY_CASE'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: z.strictObject({
      awardId: auditId,
      officialReference: label,
      officialDate: isoDate,
      reasonCategoryId: auditId,
    }),
    fields: {
      awardId: { label: 'Award', kind: 'ID' },
      officialReference: { label: 'Official reference', kind: 'TEXT' },
      officialDate: { label: 'Official date', kind: 'DATE' },
      reasonCategoryId: REASON_CATEGORY_FIELD,
    },
    summary: (p) => `Opened recovery under ${p.officialReference}`,
    example: { awardId: '00000000-0000-4000-8000-000000000011', officialReference: 'REC/2026/1', officialDate: '2026-09-05', reasonCategoryId: 'RECOVERY_MISUSE' },
  }),
  'SEB.RECOVERY_ENTRY_RECORDED': defineAudit({
    label: 'Recorded a recovery entry',
    category: 'RECOVERY',
    writer: 'admin',
    entityTypes: ['SEB_RECOVERY_CASE'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    // The entry type is the point: a waiver and a receipt are the same shape
    // and very different acts, and a trail that could not tell them apart
    // would be no use for the one that matters.
    payload: z.strictObject({
      entryId: auditId,
      entryType: z.enum(['DEMAND', 'RECEIPT', 'WAIVER', 'REVERSAL']),
      component: code,
      amountPaise: paise,
      externalReference: label,
      occurredAt: isoInstant,
      relatedEntryId: auditId.optional(),
      reasonCategoryId: auditId.optional(),
      ledgerVersion: version,
    }),
    fields: {
      entryId: { label: 'Entry', kind: 'ID' },
      entryType: { label: 'Entry', kind: 'ENUM' },
      component: { label: 'Component', kind: 'ENUM' },
      amountPaise: { label: 'Amount', kind: 'MONEY' },
      externalReference: { label: 'Reference', kind: 'TEXT' },
      occurredAt: { label: 'Occurred', kind: 'DATETIME' },
      relatedEntryId: { label: 'Reverses entry', kind: 'ID' },
      reasonCategoryId: REASON_CATEGORY_FIELD,
      ledgerVersion: { label: 'Ledger version', kind: 'COUNT' },
    },
    summary: (p) => `Recorded a ${p.entryType.toLowerCase()} of ${rupees(p.amountPaise)}`,
    example: { entryId: '00000000-0000-4000-8000-000000000013', entryType: 'RECEIPT', component: 'PRINCIPAL', amountPaise: 500_000, externalReference: 'RCPT-4', occurredAt: '2026-09-06T06:30:00.000Z', ledgerVersion: 2 },
  }),
  'SEB.RECOVERY_CLOSED': defineAudit({
    label: 'Closed a recovery case',
    category: 'RECOVERY',
    writer: 'admin',
    entityTypes: ['SEB_RECOVERY_CASE'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: recoveryEnd,
    fields: recoveryEndFields,
    summary: () => 'Closed a recovery case',
    example: { reason: 'Settled in full.', version: 3 },
  }),
  'SEB.RECOVERY_CANCELLED': defineAudit({
    label: 'Cancelled a recovery case',
    category: 'RECOVERY',
    writer: 'admin',
    entityTypes: ['SEB_RECOVERY_CASE'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: recoveryEnd,
    fields: recoveryEndFields,
    summary: () => 'Cancelled a recovery case opened in error',
    example: { reason: 'Opened against the wrong award.', version: 2 },
  }),
} as const
