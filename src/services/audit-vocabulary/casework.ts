/**
 * The programme office working a file, beyond the configured stage actions:
 * notes, withdrawn revision requests, and the disclosures and failures that
 * surround an action.
 *
 * Every event here happened to an application, so every one carries the
 * application and names its applicant as the subject — the per-application
 * history and "everything done to this person" are then one indexed read each.
 *
 * What is recorded is the fact of the act. What the officer *wrote* is not: a
 * note, a message to the applicant and a revision request stay on their own
 * rows, which are the record of them. Operator reasons are the exception,
 * bounded by `auditReason`, because "why" is the question the history is most
 * often opened to answer.
 */
import { z } from 'zod'
import { auditId, code, count, REASON_FIELD, reasonText } from './fields'
import { defineAudit, type AuditFieldSpec } from './types'

/** Every casework event hangs off one application and is about its applicant. */
const onTheFile = { subject: 'APPLICANT', application: 'REQUIRED' } as const

const REVISION_COUNT_FIELD: AuditFieldSpec = { label: 'Stages sent back', kind: 'COUNT' }

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
  'SEB.REVISION_CANCELLED': defineAudit({
    label: 'Withdrew a revision request',
    category: 'STAGE',
    writer: 'pipeline',
    entityTypes: ['SEB_APPLICATION'],
    ...onTheFile,
    payload: z.strictObject({ revisionRequestId: auditId, reason: reasonText }),
    fields: { revisionRequestId: { label: 'Revision request', kind: 'ID' }, reason: REASON_FIELD },
    summary: () => 'Withdrew a revision request made in error',
    example: { revisionRequestId: '00000000-0000-4000-8000-000000000011', reason: 'Asked for the wrong stage.' },
  }),
  'SEB.SELF_REVIEW_DISCLOSED': defineAudit({
    label: 'Acted on their own application',
    category: 'STAGE',
    writer: 'pipeline',
    entityTypes: ['SEB_APPLICATION_STAGE_ACTION'],
    ...onTheFile,
    /*
     * Stages and actions are configured, so they are codes rather than a closed
     * set. Rows written against the old desk-review and decision steps no
     * longer parse and are shown as recorded.
     */
    payload: z.strictObject({ stageKey: code, actionKey: code }),
    fields: { stageKey: { label: 'Stage', kind: 'ENUM' }, actionKey: { label: 'Action', kind: 'ENUM' } },
    summary: (p) => `Took ${p.actionKey} at ${p.stageKey} on their own application, and said so`,
    example: { stageKey: 'TTC_REVIEW', actionKey: 'FORWARD' },
  }),
  'SEB.REVISION_NOTIFICATION_FAILED': defineAudit({
    label: 'Could not tell the applicant about a revision',
    category: 'STAGE',
    writer: 'pipeline',
    entityTypes: ['SEB_APPLICATION'],
    ...onTheFile,
    payload: z.strictObject({ stageCount: count }),
    fields: { stageCount: REVISION_COUNT_FIELD },
    summary: () => 'The revision email to the applicant could not be sent',
    example: { stageCount: 2 },
  }),
} as const
