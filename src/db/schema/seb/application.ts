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
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { coreUser } from '../core/auth'
import { versionedSoftDeleteColumns } from '../shared'
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
  'TTM_REVIEW',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
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
export const applicantDesignations = [
  'PROPRIETOR',
  'MANAGING_PARTNER',
  'DIRECTOR',
  'AUTHORIZED_SIGNATORY',
] as const
export const genders = ['MALE', 'FEMALE', 'OTHER'] as const
export const creditStatuses = ['STANDARD', 'NPA'] as const
export const relationshipTypes = ['SON_OF', 'DAUGHTER_OF', 'WIFE_OF'] as const

/** Stable application identity and the indexed head of its current state. */
export const sebApplication = sqliteTable(
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
    firstSubmittedAt: integer('first_submitted_at', { mode: 'timestamp_ms' }),
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
    uniqueIndex('seb_application_id_cycle_uq').on(table.id, table.programmeCycleId),
    uniqueIndex('seb_application_case_id_uq').on(table.fundingCaseId, table.id),
    uniqueIndex('seb_application_owner_id_uq').on(table.applicantUserId, table.id),
    // A phase may be retried in a later cycle, but duplicate attempts inside
    // the same policy window are always a client or concurrency error.
    uniqueIndex('seb_application_case_cycle_phase_uq').on(
      table.fundingCaseId,
      table.programmeCycleId,
      table.phaseNumber,
    ),
    check('seb_application_current_version_check', sql`${table.currentVersion} >= 1`),
    check('seb_application_status_version_check', sql`${table.statusVersion} >= 1`),
    check(
      'seb_application_status_check',
      sql`${table.status} IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'TTM_REVIEW', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED')`,
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
    index('seb_application_owner_idx').on(
      table.applicantUserId,
      table.deletedAt,
      table.updatedAt,
    ),
    index('seb_application_enterprise_idx').on(
      table.enterpriseId,
      table.deletedAt,
      table.updatedAt,
    ),
    index('seb_application_case_phase_idx').on(table.fundingCaseId, table.phaseNumber),
    index('seb_application_cycle_idx').on(
      table.programmeCycleId,
      table.deletedAt,
      table.updatedAt,
    ),
    index('seb_application_status_idx').on(table.status, table.deletedAt, table.updatedAt),
  ],
)

/**
 * Complete immutable snapshots of the seven-section application form.
 * Form fields are nullable while an application is a draft; submission-time
 * completeness and conditional rules belong to the future application service.
 */
export const sebApplicationVersion = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),

    // Section 1: enterprise and registration details.
    businessName: text('business_name'),
    establishmentDate: text('establishment_date'),
    registrationType: text('registration_type', { enum: registrationTypes }),
    registrationNumber: text('registration_number'),
    gstin: text('gstin'),
    businessSector: text('business_sector', { enum: businessSectors }),
    otherBusinessSector: text('other_business_sector'),
    applicationCategory: text('application_category', { enum: applicationCategories }),
    majorityOwnershipConfirmed: integer('majority_ownership_confirmed', { mode: 'boolean' }),

    // Section 2: applicant/promoter contact profile. The ST certificate number
    // is deliberately absent; eligibility evidence is supplied as a document.
    primaryApplicantName: text('primary_applicant_name'),
    designation: text('designation', { enum: applicantDesignations }),
    dateOfBirth: text('date_of_birth'),
    gender: text('gender', { enum: genders }),
    businessBlockOrVillage: text('business_block_or_village'),
    businessDistrict: text('business_district'),
    businessPinCode: text('business_pin_code'),
    contactNumber: text('contact_number'),
    contactEmail: text('contact_email'),

    // Section 3: all currency is stored as integer paise.
    totalProjectCostPaise: integer('total_project_cost_paise'),
    seedFundRequestedPaise: integer('seed_fund_requested_paise'),
    bankLoanProposedPaise: integer('bank_loan_proposed_paise'),
    promoterContributionPaise: integer('promoter_contribution_paise'),

    // Section 4: previous grants and commercial credit.
    receivedGovernmentFunding: integer('received_government_funding', { mode: 'boolean' }),
    governmentSchemeName: text('government_scheme_name'),
    governmentFundingAmountPaise: integer('government_funding_amount_paise'),
    governmentFundingSanctionYear: integer('government_funding_sanction_year'),
    hasExistingBankCredit: integer('has_existing_bank_credit', { mode: 'boolean' }),
    existingBankName: text('existing_bank_name'),
    existingCreditAmountPaise: integer('existing_credit_amount_paise'),
    existingCreditStatus: text('existing_credit_status', { enum: creditStatuses }),

    // Section 5: server-derived prior-award facts copied into the immutable
    // snapshot. Applicants cannot override the linked award or ledger totals.
    priorSanctionOrderNumber: text('prior_sanction_order_number'),
    priorSanctionDate: text('prior_sanction_date'),
    priorNetDisbursedAmountPaise: integer('prior_net_disbursed_amount_paise'),
    continuousOperationMonths: integer('continuous_operation_months'),

    // Section 6: the form says "NOC, if applicable". Keeping the applicant's
    // applicability declaration in the snapshot makes the document rule
    // deterministic when an old submission is reviewed.
    nocRequired: integer('noc_required', { mode: 'boolean' }),

    // Section 7: applicant declaration. The files themselves live separately.
    relationshipType: text('relationship_type', { enum: relationshipTypes }),
    relatedPersonName: text('related_person_name'),
    declarationAccepted: integer('declaration_accepted', { mode: 'boolean' }),
    declarationAcceptedAt: integer('declaration_accepted_at', { mode: 'timestamp_ms' }),
    declarationPlace: text('declaration_place'),
  },
  (table) => [
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
    uniqueIndex('seb_application_version_number_uq').on(table.applicationId, table.version),
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
    check(
      'seb_application_version_registration_type_check',
      sql`${table.registrationType} IS NULL OR ${table.registrationType} IN ('NONE', 'CIN', 'UDYAM')`,
    ),
    check(
      'seb_application_version_sector_check',
      sql`${table.businessSector} IS NULL OR ${table.businessSector} IN ('AGRICULTURE_AND_ALLIED', 'HANDLOOM_TEXTILE_AND_HANDICRAFTS', 'FOOD_PROCESSING', 'TOURISM_AND_HOSPITALITY', 'INFORMATION_TECHNOLOGY', 'MANUFACTURING_AND_SERVICES', 'OTHER')`,
    ),
    check(
      'seb_application_version_category_check',
      sql`${table.applicationCategory} IS NULL OR ${table.applicationCategory} IN ('CATEGORY_A', 'CATEGORY_B')`,
    ),
    check(
      'seb_application_version_designation_check',
      sql`${table.designation} IS NULL OR ${table.designation} IN ('PROPRIETOR', 'MANAGING_PARTNER', 'DIRECTOR', 'AUTHORIZED_SIGNATORY')`,
    ),
    check(
      'seb_application_version_gender_check',
      sql`${table.gender} IS NULL OR ${table.gender} IN ('MALE', 'FEMALE', 'OTHER')`,
    ),
    check(
      'seb_application_version_credit_status_check',
      sql`${table.existingCreditStatus} IS NULL OR ${table.existingCreditStatus} IN ('STANDARD', 'NPA')`,
    ),
    check(
      'seb_application_version_relationship_check',
      sql`${table.relationshipType} IS NULL OR ${table.relationshipType} IN ('SON_OF', 'DAUGHTER_OF', 'WIFE_OF')`,
    ),
    check(
      'seb_application_version_money_check',
      sql`(${table.totalProjectCostPaise} IS NULL OR ${table.totalProjectCostPaise} >= 0)
        AND (${table.seedFundRequestedPaise} IS NULL OR ${table.seedFundRequestedPaise} >= 0)
        AND (${table.bankLoanProposedPaise} IS NULL OR ${table.bankLoanProposedPaise} >= 0)
        AND (${table.promoterContributionPaise} IS NULL OR ${table.promoterContributionPaise} >= 0)
        AND (${table.governmentFundingAmountPaise} IS NULL OR ${table.governmentFundingAmountPaise} >= 0)
        AND (${table.existingCreditAmountPaise} IS NULL OR ${table.existingCreditAmountPaise} >= 0)
        AND (${table.priorNetDisbursedAmountPaise} IS NULL OR ${table.priorNetDisbursedAmountPaise} >= 0)`,
    ),
    // SQLite has no native Boolean storage class. These checks prevent values
    // such as 2 or -1 from being silently decoded by Drizzle as `true`.
    check(
      'seb_application_version_boolean_check',
      sql`(${table.majorityOwnershipConfirmed} IS NULL OR ${table.majorityOwnershipConfirmed} IN (0, 1))
        AND (${table.receivedGovernmentFunding} IS NULL OR ${table.receivedGovernmentFunding} IN (0, 1))
        AND (${table.hasExistingBankCredit} IS NULL OR ${table.hasExistingBankCredit} IN (0, 1))
        AND (${table.nocRequired} IS NULL OR ${table.nocRequired} IN (0, 1))
        AND (${table.declarationAccepted} IS NULL OR ${table.declarationAccepted} IN (0, 1))`,
    ),
    check(
      'seb_application_version_operation_months_check',
      sql`${table.continuousOperationMonths} IS NULL OR ${table.continuousOperationMonths} >= 0`,
    ),
  ],
)

/** One immutable record for every formal submission or resubmission. */
export const sebApplicationSubmission = sqliteTable(
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
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }).notNull(),
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
    uniqueIndex('seb_application_submission_application_id_uq').on(
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
