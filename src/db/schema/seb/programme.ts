/**
 * Versioned Mission SEP policy/application cycles.
 *
 * A cycle is more than a pair of dates: it is the policy contract pinned by
 * every application started in that window.
 *
 * **Rules are rows, not a JSON document, because rows can be referenced.** That
 * is the whole reason and it survives any engine: a document cannot be a
 * foreign-key target, and the template's entire job is to be pointed at — a
 * document slot names a file field, a revision request names a stage, an option
 * belongs to a field. Against a JSON column every one of those becomes an
 * assertion in application code. Rows also give cross-row uniqueness ("two
 * fields may not share a key in one version") as a one-line index, and let an
 * administrator diff two cycle versions in SQL rather than in a service that
 * would then be the only thing that knows what a template is.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { instant, paise, versionedSoftDeleteColumns } from '../shared'
import { sebPipeline, sebPipelineVersion } from './pipeline'

export const programmeCycleStatuses = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'] as const
export const programmeCycleChangeTypes = [
  'CREATED',
  'UPDATED',
  'OPENED',
  'GUIDANCE_CHANGED',
  'CLOSING_CHANGED',
  'CLOSED',
  'ARCHIVED',
] as const
export const programmeJurisdictions = ['TRIPURA', 'TTAADC'] as const
export const fundingCeilingStates = ['UNRESOLVED', 'RESOLVED'] as const
export const fundingCeilingScopes = [
  'APPLICATION',
  'PHASE',
  'ENTERPRISE',
  'FUNDING_CASE',
] as const
export const programmeCycleEventTypes = [
  'OPENED',
  'GUIDANCE_CHANGED',
  'CLOSING_CHANGED',
  'CLOSED',
  'ARCHIVED',
] as const

/** Current searchable and applicant-visible state of one programme window. */
export const sebProgrammeCycle = pgTable(
  'seb_programme_cycle',
  {
    id: text('id').primaryKey(),
    cycleCode: text('cycle_code').notNull().unique(),
    displayName: text('display_name').notNull(),
    cycleYear: integer('cycle_year').notNull(),
    policyReference: text('policy_reference'),
    applicantGuidance: text('applicant_guidance'),
    status: text('status', { enum: programmeCycleStatuses }).notNull().default('DRAFT'),
    opensAt: instant('opens_at'),
    closesAt: instant('closes_at'),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    check('seb_programme_cycle_year_check', sql`${table.cycleYear} >= 1`),
    check('seb_programme_cycle_current_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_programme_cycle_status_check',
      sql`${table.status} IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')`,
    ),
    check(
      'seb_programme_cycle_window_check',
      sql`${table.opensAt} IS NULL OR ${table.closesAt} IS NULL OR ${table.closesAt} > ${table.opensAt}`,
    ),
    /* The cycle list's own ordering, and its status filter. `status_idx` is led
       by status, so it could not serve a list ordered by updated_at. */
    index('seb_programme_cycle_updated_idx')
      .on(table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_programme_cycle_status_updated_idx')
      .on(table.status, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    /* Prefix search on the code somebody would type. See the reference-number
       index in `application.ts` for why the opclass matters. */
    index('seb_programme_cycle_code_search_idx').on(
      sql`lower(${table.cycleCode}) text_pattern_ops`,
    ),
    index('seb_programme_cycle_status_idx')
      .on(table.status, table.opensAt, table.closesAt)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

/**
 * Immutable complete policy snapshot. Applications reference this exact
 * version so a later cycle correction cannot silently change old eligibility.
 */
export const sebProgrammeCycleVersion = pgTable(
  'seb_programme_cycle_version',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    cycleCode: text('cycle_code').notNull(),
    displayName: text('display_name').notNull(),
    cycleYear: integer('cycle_year').notNull(),
    policyReference: text('policy_reference'),
    applicantGuidance: text('applicant_guidance'),
    status: text('status', { enum: programmeCycleStatuses }).notNull(),
    opensAt: instant('opens_at'),
    closesAt: instant('closes_at'),

    // These scalar rules are deliberately configurable per cycle. The 2026
    // values come from the policy PDF, while later years can change safely.
    minimumApplicantAge: integer('minimum_applicant_age'),
    maximumApplicantAge: integer('maximum_applicant_age'),
    categoryAMaximumMonths: integer('category_a_maximum_months'),
    majorityOwnershipRequired: boolean('majority_ownership_required'),
    jurisdiction: text('jurisdiction', { enum: programmeJurisdictions }),
    fundingCeilingState: text('funding_ceiling_state', {
      enum: fundingCeilingStates,
    }),
    fundingCeilingAmountPaise: paise('funding_ceiling_amount_paise'),
    fundingCeilingScope: text('funding_ceiling_scope', {
      enum: fundingCeilingScopes,
    }),

    /*
     * The pipeline this cycle's applications are worked in. Chosen while the
     * cycle is a draft; the version is stamped by the write that opens the
     * cycle, from the pipeline's current published version, so a cycle never
     * opens on an unpublished shape and never follows a later edit.
     */
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => sebPipeline.id, { onDelete: 'restrict' }),
    pipelineVersion: integer('pipeline_version'),

    changeType: text('change_type', { enum: programmeCycleChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    // Scheduled lifecycle changes have no human actor. Null is therefore a
    // truthful system transition, not a fabricated attribution to the last
    // administrator who edited the cycle.
    changedByUserId: text('changed_by_user_id')
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    unique('seb_programme_cycle_version_number_uq').on(
      table.programmeCycleId,
      table.version,
    ),
    check('seb_programme_cycle_version_number_check', sql`${table.version} >= 1`),
    foreignKey({
      columns: [table.pipelineId, table.pipelineVersion],
      foreignColumns: [sebPipelineVersion.pipelineId, sebPipelineVersion.version],
      name: 'seb_programme_cycle_version_pipeline_version_fk',
    }).onDelete('restrict'),
    // An open, closed or archived cycle has a pinned version; a draft does not
    // yet, because none is chosen until it opens.
    check(
      'seb_programme_cycle_version_pipeline_pin_check',
      sql`(${table.status} = 'DRAFT' AND ${table.pipelineVersion} IS NULL)
        OR (${table.status} <> 'DRAFT' AND ${table.pipelineVersion} IS NOT NULL)`,
    ),
    check('seb_programme_cycle_version_year_check', sql`${table.cycleYear} >= 1`),
    check(
      'seb_programme_cycle_version_status_check',
      sql`${table.status} IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')`,
    ),
    check(
      'seb_programme_cycle_version_change_type_check',
      sql`${table.changeType} IN ('CREATED', 'UPDATED', 'OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED')`,
    ),
    check(
      'seb_programme_cycle_version_window_check',
      sql`${table.opensAt} IS NULL OR ${table.closesAt} IS NULL OR ${table.closesAt} > ${table.opensAt}`,
    ),
    check(
      'seb_programme_cycle_version_age_check',
      sql`(${table.minimumApplicantAge} IS NULL AND ${table.maximumApplicantAge} IS NULL)
        OR (${table.minimumApplicantAge} >= 0
          AND ${table.maximumApplicantAge} >= ${table.minimumApplicantAge})`,
    ),
    check(
      'seb_programme_cycle_version_months_check',
      sql`${table.categoryAMaximumMonths} IS NULL OR ${table.categoryAMaximumMonths} >= 0`,
    ),
    check(
      'seb_programme_cycle_version_jurisdiction_check',
      sql`${table.jurisdiction} IS NULL OR ${table.jurisdiction} IN ('TRIPURA', 'TTAADC')`,
    ),
    check(
      'seb_programme_cycle_version_ceiling_check',
      sql`(${table.fundingCeilingState} IS NULL
          AND ${table.fundingCeilingAmountPaise} IS NULL
          AND ${table.fundingCeilingScope} IS NULL)
        OR (${table.fundingCeilingState} = 'UNRESOLVED'
          AND ${table.fundingCeilingAmountPaise} IS NULL
          AND ${table.fundingCeilingScope} IS NULL)
        OR (${table.fundingCeilingState} = 'RESOLVED'
          AND ${table.fundingCeilingAmountPaise} > 0
          AND ${table.fundingCeilingAmountPaise} <= 9007199254740991
          AND ${table.fundingCeilingScope} IN ('APPLICATION', 'PHASE', 'ENTERPRISE', 'FUNDING_CASE'))`,
    ),
  ],
)


/**
 * The eligibility rule types a kind may use. The vocabulary is
 * `services/catalogue/workflow.json`'s `eligibilityRules`; this is its database
 * twin, held to it by `check:workflow-catalog`.
 */
export const eligibilityRuleTypes = [
  'PRIOR_APPLICATION_HAS_FLAG',
  'PRIOR_RECORDED_VALUE_AT_LEAST',
  'NO_OPEN_APPLICATION_OF_KIND',
  'MAX_APPLICATIONS_OF_KIND',
  'ENTERPRISE_AGE_AT_LEAST',
] as const

/**
 * A kind of application a cycle accepts — a first application, a second phase,
 * whatever the programme calls them.
 *
 * Nothing about "initial" or "expansion" is known to the code any more: a cycle
 * declares its kinds, and each kind's rules (below) decide who may start one.
 * Frozen into the cycle version like every other rule, so an applicant is
 * judged by the rules in force when they started.
 */
export const sebProgrammeCycleApplicationKind = pgTable(
  'seb_programme_cycle_application_kind',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    kindKey: text('kind_key').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_application_kind_version_fk',
    }).onDelete('restrict'),
    // A constraint rather than an index: the rule rows' foreign key targets it.
    unique('seb_programme_cycle_application_kind_key_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.kindKey,
    ),
    uniqueIndex('seb_programme_cycle_application_kind_order_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.sortOrder,
    ),
    check(
      'seb_programme_cycle_application_kind_key_check',
      sql`${table.kindKey} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      'seb_programme_cycle_application_kind_label_check',
      sql`char_length(${table.label}) BETWEEN 1 AND 80
        AND (${table.description} IS NULL OR char_length(${table.description}) <= 500)`,
    ),
    check('seb_programme_cycle_application_kind_order_check', sql`${table.sortOrder} >= 1`),
  ],
)

/**
 * One condition an enterprise must meet to start an application of a kind.
 * All of a kind's rules must hold. `params` is validated against the rule type's
 * declared parameters when the cycle is saved; the database only proves it is
 * an object.
 */
export const sebProgrammeCycleApplicationKindRule = pgTable(
  'seb_programme_cycle_application_kind_rule',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    kindKey: text('kind_key').notNull(),
    position: integer('position').notNull(),
    ruleType: text('rule_type', { enum: eligibilityRuleTypes }).notNull(),
    params: jsonb('params').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion, table.kindKey],
      foreignColumns: [
        sebProgrammeCycleApplicationKind.programmeCycleId,
        sebProgrammeCycleApplicationKind.programmeCycleVersion,
        sebProgrammeCycleApplicationKind.kindKey,
      ],
      name: 'seb_programme_cycle_application_kind_rule_kind_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_application_kind_rule_position_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.kindKey,
      table.position,
    ),
    check('seb_programme_cycle_application_kind_rule_position_check', sql`${table.position} >= 1`),
    check(
      'seb_programme_cycle_application_kind_rule_type_check',
      sql`${table.ruleType} IN ('PRIOR_APPLICATION_HAS_FLAG', 'PRIOR_RECORDED_VALUE_AT_LEAST', 'NO_OPEN_APPLICATION_OF_KIND', 'MAX_APPLICATIONS_OF_KIND', 'ENTERPRISE_AGE_AT_LEAST')`,
    ),
    check(
      'seb_programme_cycle_application_kind_rule_params_check',
      sql`jsonb_typeof(${table.params}) = 'object' AND octet_length(${table.params}::text) <= 4096`,
    ),
  ],
)

/** Applicant-visible cycle notices, shared instead of copied per application. */
export const sebProgrammeCycleEvent = pgTable(
  'seb_programme_cycle_event',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    eventType: text('event_type', { enum: programmeCycleEventTypes }).notNull(),
    actorUserId: text('actor_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    message: text('message').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    check(
      'seb_programme_cycle_event_type_check',
      sql`${table.eventType} IN ('OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED')`,
    ),
    index('seb_programme_cycle_event_cycle_idx').on(
      table.programmeCycleId,
      table.createdAt,
    ),
  ],
)
