/**
 * What an applicant answered, one row per answer.
 *
 * ## Why rows rather than a document
 *
 * A JSON column would store the same values, and the engine would have to be
 * the only thing standing between an answer and a question nobody asked. As
 * rows, the composite key onto `seb_programme_cycle_form_field` makes **an
 * answer for a field this cycle version never declared impossible in SQL** —
 * not merely refused by whichever code path remembered to check.
 *
 * The second key is the one that is easy to leave out and expensive to omit: it
 * pins `(programme_cycle_id, programme_cycle_version)` to the *version row's
 * own* pin. Without it these two columns are a free-floating copy, and an
 * answer could name a field from a different cycle version than the form it was
 * filled on — which is precisely the property the freezing exists to provide.
 *
 * ## What these keys do NOT prove
 *
 * **They say nothing about who owns the application.** An answer row carries no
 * owner, and neither key can reach one: the first proves the row names a real
 * application version with a consistent cycle pin, the second proves the field
 * exists in that version's template. Both hold perfectly well for somebody
 * else's application.
 *
 * So ownership is entirely a service-layer guard, and it has to be repeated
 * inside the write predicate like every other authorization term here — a
 * controller check alone would leave the window between reading an application
 * and writing an answer to it. This is verified, not assumed: inserting an
 * answer against another applicant's version is accepted by the database.
 *
 * ## Sparse, and what that means
 *
 * A field that was never answered, or whose answer was cleared, has **no row**.
 * Absent and empty are therefore the same state, which matches how the form has
 * always behaved: every draft answer was nullable and null meant unanswered.
 * The consequence to know is that "the applicant sent every key" is a rule the
 * engine enforces, not something a row count can prove.
 *
 * ## The two integers
 *
 * `entry_index` is 0 for an ordinary field and 1..n inside a repeat group;
 * `value_ordinal` is 0 for a single value and 1..n for one selection of a
 * multiple-choice answer. Between them they carry repetition and multi-value
 * without a third table, and both are part of the uniqueness so a group entry
 * cannot silently overwrite its sibling.
 *
 * ## One text column
 *
 * Deliberate, and a real trade. The field's declared type says how to read the
 * value, so the database cannot tell a valid amount from prose — that check
 * lives in the form engine. What rows buy is the referential integrity above,
 * which a document could not have at any price.
 */
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { instant } from '../shared'
import { sebApplicationVersion } from './application'
import { sebProgrammeCycleFormField } from './form-template'

export const sebApplicationVersionAnswer = pgTable(
  'seb_application_version_answer',
  {
    id: text('id').primaryKey(),
    applicationVersionId: text('application_version_id').notNull(),
    /* Carried so the template key below can exist, and held honest by the
       version key beside it. */
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    fieldKey: text('field_key').notNull(),
    entryIndex: integer('entry_index').notNull().default(0),
    valueOrdinal: integer('value_ordinal').notNull().default(0),
    /* Never null: a cleared answer is the absence of a row, so a null here
       would be a second spelling of the same state. */
    valueText: text('value_text').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.applicationVersionId,
        table.programmeCycleId,
        table.programmeCycleVersion,
      ],
      foreignColumns: [
        sebApplicationVersion.id,
        sebApplicationVersion.programmeCycleId,
        sebApplicationVersion.programmeCycleVersion,
      ],
      name: 'seb_application_version_answer_version_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion, table.fieldKey],
      foreignColumns: [
        sebProgrammeCycleFormField.programmeCycleId,
        sebProgrammeCycleFormField.programmeCycleVersion,
        sebProgrammeCycleFormField.fieldKey,
      ],
      name: 'seb_application_version_answer_field_fk',
    }).onDelete('restrict'),
    unique('seb_application_version_answer_slot_uq').on(
      table.applicationVersionId,
      table.fieldKey,
      table.entryIndex,
      table.valueOrdinal,
    ),
    check(
      'seb_application_version_answer_entry_check',
      sql`${table.entryIndex} >= 0 AND ${table.valueOrdinal} >= 0`,
    ),
    /*
     * The administrative queue's answer filters — sector and category — read a
     * role-bound key and compare its value. Leading with the key makes that a
     * range seek rather than a scan of every answer ever given.
     *
     * Every query using it must spell the predicate the same way; the shared
     * helper in the query layer is what keeps that true, and an `EXPLAIN` is
     * what proves it rather than assuming.
     */
    index('seb_application_version_answer_field_value_idx').on(
      table.fieldKey,
      table.valueText,
      table.applicationVersionId,
    ),
    /* Reading one application's answers back, which every form render does. */
    index('seb_application_version_answer_version_idx').on(
      table.applicationVersionId,
      table.fieldKey,
      table.entryIndex,
      table.valueOrdinal,
    ),
  ],
)
