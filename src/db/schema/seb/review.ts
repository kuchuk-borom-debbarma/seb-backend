/**
 * Staff-only notes on an application.
 *
 * The office's own record about a file, never shown to the applicant. Notes are
 * append-only: a correction is a new note pointing at the one it replaces, so
 * what somebody wrote at the time can always be read back as they wrote it.
 * A stage action can also add one, from a long-text input the pipeline names.
 */
import {
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { sebApplication } from './application'
import { instant } from '../shared'

/** Staff-only append-only note; a correction points to the note it replaces. */
export const sebApplicationInternalNote = pgTable(
  'seb_application_internal_note',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    correctionOfNoteId: text('correction_of_note_id'),
    note: text('note').notNull(),
    authoredByUserId: text('authored_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.correctionOfNoteId],
      foreignColumns: [table.applicationId, table.id],
      name: 'seb_application_internal_note_correction_fk',
    }).onDelete('restrict'),
    unique('seb_application_internal_note_application_id_uq').on(
      table.applicationId,
      table.id,
    ),
    uniqueIndex('seb_application_internal_note_one_correction_uq').on(
      table.correctionOfNoteId,
    ),
    index('seb_application_internal_note_application_idx').on(
      table.applicationId,
      table.createdAt,
    ),
  ],
)
