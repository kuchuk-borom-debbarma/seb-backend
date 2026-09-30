/**
 * The history's own act: taking it out of the system.
 */
import { z } from 'zod'
import { count, reasonText, REASON_FIELD } from './fields'
import { defineAudit } from './types'

export const exportVocabulary = {
  'AUDIT.EXPORTED': defineAudit({
    label: 'Exported the activity history',
    category: 'AUDIT',
    writer: 'audit',
    entityTypes: ['CORE_AUDIT_EXPORT'],
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({
      // Required and kept: an export is the one read that leaves the system,
      // so the reason for it is part of the record, not a courtesy.
      purpose: reasonText,
      // The filter exactly as it was applied, so the same rows can be found
      // again — the rows themselves are still here and are not copied.
      filters: z.record(z.string(), z.json()),
      rowCount: count,
      truncated: z.boolean(),
      format: z.literal('CSV'),
    }),
    fields: {
      purpose: { ...REASON_FIELD, label: 'Purpose' },
      filters: { label: 'Filters', kind: 'FILTERS' },
      rowCount: { label: 'Rows', kind: 'COUNT' },
      truncated: { label: 'Cut at the row limit', kind: 'BOOLEAN' },
      format: { label: 'Format', kind: 'ENUM' },
    },
    summary: (p) => `Exported ${p.rowCount} ${p.rowCount === 1 ? 'entry' : 'entries'} of the activity history`,
    example: { purpose: 'Quarterly review', filters: { categories: ['REVIEW'] }, rowCount: 12, truncated: false, format: 'CSV' },
  }),
} as const
