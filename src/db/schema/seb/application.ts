/**
 * Mission SEP application heads, immutable form snapshots, and submissions.
 *
 * An application belongs simultaneously to its portal owner, canonical
 * enterprise, long-lived funding case, and policy cycle. Composite foreign keys
 * make those scopes database invariants. Enterprise fields are intentionally
 * copied into each form version so later canonical edits cannot rewrite what a
 * reviewer saw at submission time.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { dateOnly, instant, paise, versionedSoftDeleteColumns } from '../shared'
import { sebFundingCase } from './case'
import {
  businessSectors,
  registrationTypes,
  sebEnterprise,
} from './enterprise'
import { sebProgrammeCycle, sebProgrammeCycleVersion } from './programme'

export const applicationStatuses = [
  'DRAFT',
  'SUBMITTED',
  'DESK_REVIEW',
  'REVISION_REQUIRED',
  'PARTNER_BANK_EVALUATION',
  'AWAITING_DECISION',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
  'CANCELLED',
] as const

export const applicationChangeTypes = [
  'INITIAL',
  'SAVE',
  'REVISION',
  'SUBMISSION',
  'RESUBMISSION',
] as const
export const applicationTypes = ['INITIAL', 'EXPANSION'] as const
export const applicationCategories = ['CATEGORY_A', 'CATEGORY_B'] as const
/*
 * There were four more closed sets here — designations, genders, credit
 * statuses and relationships. They named answers the *old fixed form* asked,
 * and they backed no column once the answers became rows: what a cycle asks,
 * and which values it offers, is the cycle's decision and lives in its own
 * template. A cycle that wants any of them declares a `SINGLE_CHOICE` question
 * and enumerates them.
 *
 * `applicationCategories` above stays because it is role-bound — the
 * assessment window and the queue filter read it across many cycles at once,
 * which is precisely what a role exists for.
 */

/** Stable application identity and the indexed head of its current state. */
export const sebApplication = pgTable(
  'seb_application',
  {
    id: text('id').primaryKey(),
    applicantUserId: text('applicant_user_id').notNull(),
    enterpriseId: text('enterprise_id').notNull(),
    fundingCaseId: text('funding_case_id').notNull(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    applicationType: text('application_type', { enum: applicationTypes })
      .notNull()
      .default('INITIAL'),
    phaseNumber: integer('phase_number').notNull().default(1),
    referenceNumber: text('reference_number').unique(),
    ...versionedSoftDeleteColumns(() => coreUser.id),
    status: text('status', { enum: applicationStatuses }).notNull().default('DRAFT'),
    statusVersion: integer('status_version').notNull().default(1),
    statusChangedAt: instant('status_changed_at').notNull(),
    // Assignment is duplicated on the head for fast work queues. Immutable
    // assignment events retain how and why the pointer changed.
    assignedToUserId: text('assigned_to_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    assignedAt: instant('assigned_at'),
    assignmentVersion: integer('assignment_version').notNull().default(0),
    firstSubmittedAt: instant('first_submitted_at'),
  },
  (table) => [
    // The two composite keys make ownership and case membership database
    // invariants rather than assumptions in every future application query.
    foreignKey({
      columns: [table.applicantUserId, table.enterpriseId],
      foreignColumns: [sebEnterprise.portalOwnerUserId, sebEnterprise.id],
      name: 'seb_application_owner_enterprise_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.enterpriseId, table.fundingCaseId],
      foreignColumns: [sebFundingCase.enterpriseId, sebFundingCase.id],
      name: 'seb_application_enterprise_case_fk',
    }).onDelete('restrict'),
    // Application versions repeat the cycle ID so they can bind to both this
    // application and the exact immutable policy-cycle version.
    unique('seb_application_id_cycle_uq').on(table.id, table.programmeCycleId),
    unique('seb_application_case_id_uq').on(table.fundingCaseId, table.id),
    unique('seb_application_owner_id_uq').on(table.applicantUserId, table.id),
    // A phase may be retried in a later cycle, but duplicate attempts inside
    // the same policy window are always a client or concurrency error.
    uniqueIndex('seb_application_case_cycle_phase_uq').on(
      table.fundingCaseId,
      table.programmeCycleId,
      table.phaseNumber,
    ),
    check('seb_application_current_version_check', sql`${table.currentVersion} >= 1`),
    check('seb_application_status_version_check', sql`${table.statusVersion} >= 1`),
    check('seb_application_assignment_version_check', sql`${table.assignmentVersion} >= 0`),
    check(
      'seb_application_assignment_group_check',
      sql`(${table.assignedToUserId} IS NULL AND ${table.assignedAt} IS NULL)
        OR (${table.assignedToUserId} IS NOT NULL AND ${table.assignedAt} IS NOT NULL)`,
    ),
    check(
      'seb_application_status_check',
      sql`${table.status} IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'AWAITING_DECISION', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED', 'CANCELLED')`,
    ),
    check(
      'seb_application_type_check',
      sql`${table.applicationType} IN ('INITIAL', 'EXPANSION')`,
    ),
    check(
      'seb_application_phase_check',
      sql`(${table.applicationType} = 'INITIAL' AND ${table.phaseNumber} = 1)
        OR (${table.applicationType} = 'EXPANSION' AND ${table.phaseNumber} >= 2)`,
    ),
    /*
     * Deletion is a predicate, not a key column.
     *
     * Every list below reads live rows and says so with a literal
     * `deleted_at IS NULL`, so indexing the deleted ones costs writes and cache
     * for rows no query wants. As a partial index the entry simply does not
     * exist for them.
     *
     * **The planner only uses a partial index when it can prove the
     * predicate.** Dropping the `IS NULL` term from a query — or writing it as
     * `IS NOT DISTINCT FROM NULL` — silently falls back to a sequential scan.
     * That is slower rather than wrong, so nothing fails and nobody notices.
     */
    index('seb_application_owner_idx')
      .on(table.applicantUserId, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_application_enterprise_idx')
      .on(table.enterpriseId, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_application_case_phase_idx').on(table.fundingCaseId, table.phaseNumber),
    index('seb_application_cycle_idx')
      .on(table.programmeCycleId, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_application_status_idx')
      .on(table.status, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_application_assignment_idx').on(
      table.assignedToUserId,
      table.status,
      table.statusChangedAt,
    ),
    /*
     * The administrative queue's default ordering, with no cycle or status
     * narrowing it. Every other index containing these columns is led by one
     * the queue does not filter on, so without these two the default console
     * view was a full table scan and a full sort on every page.
     */
    index('seb_application_intake_waiting_idx')
      .on(table.statusChangedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_application_intake_activity_idx')
      .on(table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    /*
     * Prefix search on the reference number an applicant quotes.
     *
     * `text_pattern_ops` is what makes `LIKE 'sep-2026%'` use this index. The
     * default opclass sorts by the database collation, and a collated index
     * cannot answer a pattern match — without the opclass this is a sequential
     * scan that still returns the right rows, so nothing fails.
     *
     * The cost is that this index answers prefix matches and equality only: an
     * ordering or a range over the same expression cannot use it. That is what
     * it is for, and no query orders by a lowercased reference number.
     */
    index('seb_application_reference_search_idx').on(
      sql`lower(${table.referenceNumber}) text_pattern_ops`,
    ),
    index('seb_application_cycle_status_idx').on(
      table.programmeCycleId,
      table.status,
      table.statusChangedAt,
    ),
  ],
)

/**
 * One immutable snapshot of the form, and the facts the server owns about it.
 *
 * **The answers are not here.** They live one row each in
 * `seb_application_version_answer`, keyed to the field the cycle's template
 * declared, because which questions exist is a cycle's decision and no longer
 * the schema's. What stays are the pins that make a snapshot readable — the
 * exact cycle version it was filled against — and the small set of values an
 * applicant must never be able to assert.
 *
 * ## Why the expansion facts are columns and not answers
 *
 * `priorSanctionOrderNumber`, `priorSanctionDate`, `priorNetDisbursedAmountPaise`
 * and `continuousOperationMonths` are derived by the server from the qualifying
 * award and the disbursement ledger, and are re-checked against live aggregates
 * inside the guarded write. As answer rows the only thing preventing an
 * applicant claiming a ten-crore prior sanction would be the engine remembering
 * to strip four keys on every path — a boundary maintained by vigilance rather
 * than by structure. A column the answer path cannot write is the boundary.
 *
 * `declarationAcceptedAt` is here for a related reason: the server re-stamps it
 * on every submission, so as an answer it would be both applicant-writable and
 * different on every save, making every submission differ from the draft it
 * came from and breaking both the no-op check and the change diff.
 */
export const sebApplicationVersion = pgTable(
  'seb_application_version',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    version: integer('version').notNull(),
    // These fields are part of the immutable legal snapshot. Referencing only
    // the mutable application/cycle heads would make old submissions appear to
    // follow later policy or phase corrections.
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    applicationType: text('application_type', { enum: applicationTypes }).notNull(),
    phaseNumber: integer('phase_number').notNull(),
    changeType: text('change_type', { enum: applicationChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),

    // Server-derived prior-award facts. See the header for why these are not
    // answers; the write re-checks them against the live ledger.
    priorSanctionOrderNumber: text('prior_sanction_order_number'),
    priorSanctionDate: dateOnly('prior_sanction_date'),
    priorNetDisbursedAmountPaise: paise('prior_net_disbursed_amount_paise'),
    continuousOperationMonths: integer('continuous_operation_months'),

    // Stamped by the server on submission, never sent by the applicant.
    declarationAcceptedAt: instant('declaration_accepted_at'),

    /*
     * Computed by the server at submission from the enterprise's establishment
     * date and the cycle's `category_a_maximum_months` — CATEGORY_A for an
     * enterprise trading at least that long, CATEGORY_B otherwise. A column
     * rather than an answer because an applicant must not be able to assert
     * it, and a column rather than a live read because the sorting must not
     * drift when the enterprise is later edited: it is part of the legal
     * snapshot, like everything else on this row. Null on drafts, and on
     * cycles that set no threshold.
     */
    applicationCategory: text('application_category', {
      enum: ['CATEGORY_A', 'CATEGORY_B'],
    }),
  },
  (table) => [
    // Written out because `text(col, { enum })` emits no constraint at all —
    // the rule every closed set in this schema keeps.
    check(
      'seb_application_version_category_check',
      sql`${table.applicationCategory} IS NULL
        OR ${table.applicationCategory} IN ('CATEGORY_A', 'CATEGORY_B')`,
    ),
    foreignKey({
      columns: [table.applicationId, table.programmeCycleId],
      foreignColumns: [sebApplication.id, sebApplication.programmeCycleId],
      name: 'seb_application_version_application_cycle_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_application_version_programme_cycle_version_fk',
    }).onDelete('restrict'),
    unique('seb_application_version_number_uq').on(table.applicationId, table.version),
    check('seb_application_version_number_check', sql`${table.version} >= 1`),
    check(
      'seb_application_version_type_check',
      sql`${table.applicationType} IN ('INITIAL', 'EXPANSION')`,
    ),
    check(
      'seb_application_version_phase_check',
      sql`(${table.applicationType} = 'INITIAL' AND ${table.phaseNumber} = 1)
        OR (${table.applicationType} = 'EXPANSION' AND ${table.phaseNumber} >= 2)`,
    ),
    check(
      'seb_application_version_change_type_check',
      sql`${table.changeType} IN ('INITIAL', 'SAVE', 'REVISION', 'SUBMISSION', 'RESUBMISSION')`,
    ),
    /*
     * The target the answer rows key on.
     *
     * `id` alone is already unique, so this adds nothing about the version —
     * it exists so an answer can prove, in SQL, that the cycle version it names
     * is the one its own snapshot pinned. Without it those two columns on the
     * answer row are a free-floating copy that could name a different version
     * than the form was filled on, which is exactly what freezing prevents.
     */
    unique('seb_application_version_cycle_pin_uq').on(
      table.id,
      table.programmeCycleId,
      table.programmeCycleVersion,
    ),
    check(
      'seb_application_version_prior_award_check',
      sql`(${table.priorNetDisbursedAmountPaise} IS NULL
          OR (${table.priorNetDisbursedAmountPaise} >= 0
              AND ${table.priorNetDisbursedAmountPaise} <= 9007199254740991))
        AND (${table.continuousOperationMonths} IS NULL OR ${table.continuousOperationMonths} >= 0)`,
    ),
    /*
     * The queue's category filter and the analytics category grouping both
     * read this column on the frozen submitted version. Partial, because every
     * draft save writes a row with a NULL category — indexing those would
     * grow the index with entries no filter can ever match.
     */
    index('seb_application_version_category_idx')
      .on(table.applicationCategory)
      .where(sql`${table.applicationCategory} IS NOT NULL`),
  ],
)

/** One immutable record for every formal submission or resubmission. */
export const sebApplicationSubmission = pgTable(
  'seb_application_submission',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    submissionNumber: integer('submission_number').notNull(),
    applicationVersion: integer('application_version').notNull(),
    submittedByUserId: text('submitted_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    submittedAt: instant('submitted_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_application_submission_number_uq').on(
      table.applicationId,
      table.submissionNumber,
    ),
    uniqueIndex('seb_application_submission_version_uq').on(
      table.applicationId,
      table.applicationVersion,
    ),
    // Workflow records carry both identifiers so their composite foreign keys
    // can prove that a submission belongs to the same application.
    /* The NEWEST_SUBMISSION ordering and the submitted-between filters both
       seek on this column, which no index reached. */
    index('seb_application_submission_submitted_idx').on(table.submittedAt),
    unique('seb_application_submission_application_id_uq').on(
      table.applicationId,
      table.id,
    ),
    foreignKey({
      columns: [table.applicationId, table.applicationVersion],
      foreignColumns: [sebApplicationVersion.applicationId, sebApplicationVersion.version],
      name: 'seb_application_submission_version_fk',
    }).onDelete('restrict'),
    check('seb_application_submission_number_check', sql`${table.submissionNumber} >= 1`),
  ],
)
