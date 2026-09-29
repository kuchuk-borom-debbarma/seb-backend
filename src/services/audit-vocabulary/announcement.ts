/**
 * The public announcement banner: what the programme tells visitors.
 *
 * A card's title is public text, so it is recorded where it makes an entry
 * readable; its body is not copied — it lives on the card and changes with it.
 * An operator's reason is kept bounded here and whole on the card's record.
 */
import { z } from 'zod'
import { count, label, REASON_FIELD, reasonText, version, VERSION_FIELD } from './fields'
import { defineAudit } from './types'

export const announcementVocabulary = {
  'SEB.ANNOUNCEMENT_CREATED': defineAudit({
    label: 'Created an announcement',
    category: 'ANNOUNCEMENT',
    writer: 'announcement',
    entityTypes: ['SEB_ANNOUNCEMENT'],
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({ title: label, published: z.boolean() }),
    fields: {
      title: { label: 'Title', kind: 'TEXT' },
      published: { label: 'Published', kind: 'BOOLEAN' },
    },
    summary: (p) => `Created ${p.published ? 'and published ' : ''}the announcement “${p.title}”`,
    example: { title: 'Applications are open', published: true },
  }),
  'SEB.ANNOUNCEMENT_UPDATED': defineAudit({
    label: 'Changed an announcement',
    category: 'ANNOUNCEMENT',
    writer: 'announcement',
    entityTypes: ['SEB_ANNOUNCEMENT'],
    subject: 'NONE',
    application: 'NONE',
    // One action for an edit and for publishing or withdrawing, told apart by
    // `change`; only the latter two ask the operator why.
    payload: z.strictObject({
      change: z.enum(['EDITED', 'PUBLISHED', 'UNPUBLISHED']),
      version,
      reason: reasonText.optional(),
    }),
    fields: {
      change: { label: 'Change', kind: 'ENUM' },
      version: VERSION_FIELD,
      reason: REASON_FIELD,
    },
    summary: (p) =>
      p.change === 'PUBLISHED'
        ? 'Published an announcement'
        : p.change === 'UNPUBLISHED'
          ? 'Withdrew an announcement from the site'
          : 'Edited an announcement',
    example: { change: 'UNPUBLISHED', version: 3, reason: 'Date changed.' },
  }),
  'SEB.ANNOUNCEMENT_REMOVED': defineAudit({
    label: 'Removed an announcement',
    category: 'ANNOUNCEMENT',
    writer: 'announcement',
    entityTypes: ['SEB_ANNOUNCEMENT'],
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({ reason: reasonText }),
    fields: { reason: REASON_FIELD },
    summary: () => 'Removed an announcement',
    example: { reason: 'The event was cancelled.' },
  }),
  'SEB.ANNOUNCEMENT_REORDERED': defineAudit({
    label: 'Reordered the announcements',
    category: 'ANNOUNCEMENT',
    writer: 'announcement',
    entityTypes: ['SEB_ANNOUNCEMENT_BOARD'],
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({ count }),
    fields: { count: { label: 'Cards', kind: 'COUNT' } },
    summary: (p) => `Reordered ${p.count} ${p.count === 1 ? 'announcement' : 'announcements'}`,
    example: { count: 4 },
  }),
} as const
