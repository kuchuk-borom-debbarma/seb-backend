/**
 * The programme office working a file: desk review, the partner bank, and the
 * programme's decision.
 *
 * Every event here happened to an application, so every one carries the
 * application and names its applicant as the subject — the per-application
 * history and "everything done to this person" are then one indexed read each.
 *
 * What is recorded is what the officer decided and the figures they recorded
 * it with. What they *wrote* is not: a note, a message to the applicant and a
 * revision request stay on their own rows, which are the record of them.
 * Operator reasons are the exception, bounded by `auditReason`, because "why"
 * is the question the history is most often opened to answer.
 */
import { z } from 'zod'
import { bankOutcomes, decisionOutcomes, deskReviewOutcomes } from '../../db/schema'
import {
  auditId,
  count,
  isoDate,
  label,
  paise,
  REASON_CATEGORY_FIELD,
  REASON_FIELD,
  reasonText,
  version,
} from './fields'
import { defineAudit, type AuditFieldSpec } from './types'

/** Every casework event hangs off one application and is about its applicant. */
const onTheFile = { subject: 'APPLICANT', application: 'REQUIRED' } as const

/*
 * A correction supersedes a recorded outcome or decision and says why. One
 * extension shared by both, so the two corrections cannot drift apart in how
 * they record the thing they replace.
 */
const correctionOf = <K extends string>(supersedesKey: K) => ({
  shape: {
    [supersedesKey]: auditId,
    correctionReasonCategoryId: auditId,
    reason: reasonText,
  } as { [P in K]: typeof auditId } & { correctionReasonCategoryId: typeof auditId; reason: typeof reasonText },
  fields: {
    [supersedesKey]: { label: 'Supersedes', kind: 'ID' },
    correctionReasonCategoryId: REASON_CATEGORY_FIELD,
    reason: REASON_FIELD,
  } as { [P in K]: AuditFieldSpec } & { correctionReasonCategoryId: AuditFieldSpec; reason: AuditFieldSpec },
})

const REVISION_COUNT_FIELD: AuditFieldSpec = { label: 'Stages sent back', kind: 'COUNT' }

/* -------------------------------------------------------------- the bank */

const bankOutcome = z.strictObject({
  referralId: auditId,
  outcome: z.enum(bankOutcomes),
  decisionReference: label,
  decisionDate: isoDate,
  availableLoanAmountPaise: paise.optional(),
  revisionCount: count,
})

const bankOutcomeFields = {
  referralId: { label: 'Referral', kind: 'ID' },
  outcome: { label: 'Bank outcome', kind: 'ENUM' },
  decisionReference: { label: "Bank's reference", kind: 'TEXT' },
  decisionDate: { label: "Bank's decision date", kind: 'DATE' },
  availableLoanAmountPaise: { label: 'Loan available', kind: 'MONEY' },
  revisionCount: REVISION_COUNT_FIELD,
} as const

const bankCorrection = correctionOf('supersedesOutcomeId')

/* ---------------------------------------------------------- the decision */

const decision = z.strictObject({
  outcome: z.enum(decisionOutcomes),
  reference: label,
  date: isoDate,
  approvedAmountPaise: paise.optional(),
  requestedAmountPaise: paise,
  reasonCategoryId: auditId.optional(),
  revisionCount: count,
})

const decisionFields = {
  outcome: { label: 'Decision', kind: 'ENUM' },
  reference: { label: 'Decision reference', kind: 'TEXT' },
  date: { label: 'Decision date', kind: 'DATE' },
  approvedAmountPaise: { label: 'Approved amount', kind: 'MONEY' },
  requestedAmountPaise: { label: 'Requested amount', kind: 'MONEY' },
  reasonCategoryId: REASON_CATEGORY_FIELD,
  revisionCount: REVISION_COUNT_FIELD,
} as const

const decisionCorrection = correctionOf('supersedesDecisionId')

const DECISION_WORDS: Record<z.infer<typeof decision>['outcome'], string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REVISION_REQUIRED: 'Sent back for revision',
}

export const caseworkVocabulary = {
  /* ------------------------------------------------------------ review */
  'SEB.INTERNAL_NOTE_ADDED': defineAudit({
    label: 'Added an internal note',
    category: 'REVIEW',
    writer: 'admin',
    entityTypes: ['SEB_APPLICATION_INTERNAL_NOTE'],
    ...onTheFile,
    // The note's text is office-only and stays on the note row.
    payload: z.strictObject({ correctionOfNoteId: auditId.optional() }),
    fields: { correctionOfNoteId: { label: 'Corrects note', kind: 'ID' } },
    summary: (p) => (p.correctionOfNoteId ? 'Corrected an internal note' : 'Added an internal note'),
    example: {},
  }),
  'SEB.DESK_REVIEW_STARTED': defineAudit({
    label: 'Started a desk review',
    category: 'REVIEW',
    writer: 'admin',
    entityTypes: ['SEB_APPLICATION'],
    ...onTheFile,
    payload: z.strictObject({ statusVersion: version }),
    fields: { statusVersion: { label: 'Status version', kind: 'COUNT' } },
    summary: () => 'Started the desk review',
    example: { statusVersion: 3 },
  }),
  'SEB.DESK_REVIEW_COMPLETED': defineAudit({
    label: 'Completed a desk review',
    category: 'REVIEW',
    writer: 'admin',
    entityTypes: ['SEB_DESK_REVIEW'],
    ...onTheFile,
    payload: z.strictObject({
      outcome: z.enum(deskReviewOutcomes),
      submissionId: auditId,
      checkCount: count,
      failedCheckCount: count,
      identifierCount: count,
      revisionCount: count,
      reasonCategoryId: auditId.optional(),
    }),
    fields: {
      outcome: { label: 'Outcome', kind: 'ENUM' },
      submissionId: { label: 'Submission', kind: 'ID' },
      checkCount: { label: 'Checks recorded', kind: 'COUNT' },
      failedCheckCount: { label: 'Checks failed', kind: 'COUNT' },
      identifierCount: { label: 'Identifiers transcribed', kind: 'COUNT' },
      revisionCount: REVISION_COUNT_FIELD,
      reasonCategoryId: REASON_CATEGORY_FIELD,
    },
    summary: (p) => p.outcome === 'ADVANCE_TO_BANK'
      ? 'Completed the desk review and referred the file onward'
      : p.outcome === 'REQUEST_REVISION'
        ? `Completed the desk review and sent ${p.revisionCount} ${p.revisionCount === 1 ? 'stage' : 'stages'} back`
        : 'Completed the desk review and rejected the application',
    example: {
      outcome: 'REQUEST_REVISION', submissionId: '00000000-0000-4000-8000-000000000010',
      checkCount: 9, failedCheckCount: 1, identifierCount: 2, revisionCount: 1,
    },
  }),
  'SEB.REVISION_CANCELLED': defineAudit({
    label: 'Withdrew a revision request',
    category: 'REVIEW',
    writer: 'admin',
    entityTypes: ['SEB_APPLICATION'],
    ...onTheFile,
    payload: z.strictObject({ revisionRequestId: auditId, reason: reasonText }),
    fields: { revisionRequestId: { label: 'Revision request', kind: 'ID' }, reason: REASON_FIELD },
    summary: () => 'Withdrew a revision request made in error',
    example: { revisionRequestId: '00000000-0000-4000-8000-000000000011', reason: 'Asked for the wrong stage.' },
  }),
  'SEB.SELF_REVIEW_DISCLOSED': defineAudit({
    label: 'Acted on their own application',
    category: 'REVIEW',
    writer: 'admin',
    entityTypes: ['SEB_DESK_REVIEW', 'SEB_PROGRAMME_DECISION'],
    ...onTheFile,
    payload: z.strictObject({ stage: z.enum(['DESK_REVIEW', 'DECISION', 'DECISION_CORRECTION']) }),
    fields: { stage: { label: 'At', kind: 'ENUM' } },
    summary: (p) => p.stage === 'DESK_REVIEW'
      ? 'Reviewed their own application, and said so'
      : p.stage === 'DECISION'
        ? 'Decided their own application, and said so'
        : 'Corrected the decision on their own application, and said so',
    example: { stage: 'DECISION' },
  }),
  'SEB.REVISION_NOTIFICATION_FAILED': defineAudit({
    label: 'Could not tell the applicant about a revision',
    category: 'REVIEW',
    writer: 'admin',
    entityTypes: ['SEB_APPLICATION'],
    ...onTheFile,
    payload: z.strictObject({ stageCount: count }),
    fields: { stageCount: REVISION_COUNT_FIELD },
    summary: () => 'The revision email to the applicant could not be sent',
    example: { stageCount: 2 },
  }),

  /* -------------------------------------------------------------- bank */
  'SEB.BANK_REFERRED': defineAudit({
    label: 'Referred an application to a partner bank',
    category: 'BANK',
    writer: 'admin',
    entityTypes: ['SEB_PARTNER_BANK_REFERRAL'],
    ...onTheFile,
    payload: z.strictObject({
      bankName: label,
      bankBranch: label.optional(),
      referralReference: label,
      referralDate: isoDate,
      submissionId: auditId,
    }),
    fields: {
      bankName: { label: 'Bank', kind: 'TEXT' },
      bankBranch: { label: 'Branch', kind: 'TEXT' },
      referralReference: { label: 'Referral reference', kind: 'TEXT' },
      referralDate: { label: 'Referral date', kind: 'DATE' },
      submissionId: { label: 'Submission', kind: 'ID' },
    },
    summary: (p) => `Referred the application to ${p.bankName}`,
    example: {
      bankName: 'Tripura Gramin Bank', referralReference: 'TGB/2026/14',
      referralDate: '2026-09-01', submissionId: '00000000-0000-4000-8000-000000000012',
    },
  }),
  'SEB.BANK_REFERRAL_CANCELLED': defineAudit({
    label: 'Cancelled a bank referral',
    category: 'BANK',
    writer: 'admin',
    entityTypes: ['SEB_PARTNER_BANK_REFERRAL'],
    ...onTheFile,
    payload: z.strictObject({ reasonCategoryId: auditId, reason: reasonText }),
    fields: { reasonCategoryId: REASON_CATEGORY_FIELD, reason: REASON_FIELD },
    summary: () => 'Cancelled the referral to the partner bank',
    example: { reasonCategoryId: '00000000-0000-4000-8000-000000000013', reason: 'Referred to the wrong bank.' },
  }),
  'SEB.BANK_OUTCOME_RECORDED': defineAudit({
    label: "Recorded a bank's outcome",
    category: 'BANK',
    writer: 'admin',
    entityTypes: ['SEB_PARTNER_BANK_OUTCOME'],
    ...onTheFile,
    payload: bankOutcome,
    fields: bankOutcomeFields,
    summary: (p) => `Recorded the bank's outcome: ${p.outcome.toLowerCase().replaceAll('_', ' ')}`,
    example: {
      referralId: '00000000-0000-4000-8000-000000000014', outcome: 'RECOMMENDED',
      decisionReference: 'TGB/D/7', decisionDate: '2026-09-10', availableLoanAmountPaise: 25000000, revisionCount: 0,
    },
  }),
  'SEB.BANK_OUTCOME_CORRECTED': defineAudit({
    label: "Corrected a bank's outcome",
    category: 'BANK',
    writer: 'admin',
    entityTypes: ['SEB_PARTNER_BANK_OUTCOME'],
    ...onTheFile,
    payload: bankOutcome.extend(bankCorrection.shape),
    fields: { ...bankOutcomeFields, ...bankCorrection.fields },
    summary: (p) => `Corrected the bank's outcome to ${p.outcome.toLowerCase().replaceAll('_', ' ')}`,
    example: {
      referralId: '00000000-0000-4000-8000-000000000014', outcome: 'NOT_RECOMMENDED',
      decisionReference: 'TGB/D/7A', decisionDate: '2026-09-12', revisionCount: 0,
      supersedesOutcomeId: '00000000-0000-4000-8000-000000000015',
      correctionReasonCategoryId: '00000000-0000-4000-8000-000000000016', reason: 'Transcribed the wrong letter.',
    },
  }),

  /* ---------------------------------------------------------- decision */
  'SEB.DECISION_RECORDED': defineAudit({
    label: 'Recorded a programme decision',
    category: 'DECISION',
    writer: 'admin',
    entityTypes: ['SEB_PROGRAMME_DECISION'],
    ...onTheFile,
    payload: decision.extend({ submissionId: auditId }),
    fields: { ...decisionFields, submissionId: { label: 'Submission', kind: 'ID' } },
    summary: (p) => `${DECISION_WORDS[p.outcome]} the application`,
    example: {
      outcome: 'APPROVED', reference: 'MSEP/DEC/2026/4', date: '2026-09-20',
      approvedAmountPaise: 50000000, requestedAmountPaise: 50000000, revisionCount: 0,
      submissionId: '00000000-0000-4000-8000-000000000017',
    },
  }),
  'SEB.DECISION_CORRECTED': defineAudit({
    label: 'Corrected a programme decision',
    category: 'DECISION',
    writer: 'admin',
    entityTypes: ['SEB_PROGRAMME_DECISION'],
    ...onTheFile,
    payload: decision.extend(decisionCorrection.shape),
    fields: { ...decisionFields, ...decisionCorrection.fields },
    summary: (p) => `Corrected the decision to: ${DECISION_WORDS[p.outcome].toLowerCase()}`,
    example: {
      outcome: 'REJECTED', reference: 'MSEP/DEC/2026/4A', date: '2026-09-22',
      requestedAmountPaise: 50000000, revisionCount: 0,
      reasonCategoryId: '00000000-0000-4000-8000-000000000018',
      supersedesDecisionId: '00000000-0000-4000-8000-000000000019',
      correctionReasonCategoryId: '00000000-0000-4000-8000-000000000020', reason: 'Recorded against the wrong file.',
    },
  }),
  'SEB.APPROVAL_NOTIFICATION_FAILED': defineAudit({
    label: 'Could not tell the applicant about an approval',
    category: 'DECISION',
    writer: 'admin',
    entityTypes: ['SEB_APPLICATION'],
    ...onTheFile,
    payload: z.strictObject({ decisionReference: label }),
    fields: { decisionReference: { label: 'Decision reference', kind: 'TEXT' } },
    summary: () => 'The approval email to the applicant could not be sent',
    example: { decisionReference: 'MSEP/DEC/2026/4' },
  }),
} as const
