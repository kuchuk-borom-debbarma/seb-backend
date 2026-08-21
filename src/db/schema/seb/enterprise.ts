/**
 * Canonical enterprise records shared by every Mission SEP application.
 *
 * The mutable head keeps the fields needed for fast lists and uniqueness checks.
 * Every accepted change also writes a complete immutable version so applications
 * can preserve their submitted snapshot independently of the live enterprise.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { coreUser } from '../core/auth'
import { versionedSoftDeleteColumns } from '../shared'

export const enterpriseStatuses = ['PROPOSED', 'ACTIVE', 'INACTIVE'] as const
export const enterpriseChangeTypes = ['CREATED', 'UPDATED', 'CORRECTED'] as const
export const registrationTypes = ['NONE', 'CIN', 'UDYAM'] as const
export const businessSectors = [
  'AGRICULTURE_AND_ALLIED',
  'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  'FOOD_PROCESSING',
  'TOURISM_AND_HOSPITALITY',
  'INFORMATION_TECHNOLOGY',
  'MANUFACTURING_AND_SERVICES',
  'OTHER',
] as const

/** Stable enterprise identity with exactly one current portal owner. */
export const sebEnterprise = sqliteTable(
  'seb_enterprise',
  {
    id: text('id').primaryKey(),
    portalOwnerUserId: text('portal_owner_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),

    // Current values are duplicated from the latest immutable version for
    // efficient lists, ownership checks, and registration uniqueness.
    currentName: text('current_name').notNull(),
    registrationType: text('registration_type', { enum: registrationTypes })
      .notNull()
      .default('NONE'),
    registrationNumber: text('registration_number'),
    gstin: text('gstin').unique(),
    status: text('status', { enum: enterpriseStatuses }).notNull().default('PROPOSED'),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    uniqueIndex('seb_enterprise_owner_id_uq').on(table.portalOwnerUserId, table.id),
    uniqueIndex('seb_enterprise_registration_uq').on(
      table.registrationType,
      table.registrationNumber,
    ),
    check('seb_enterprise_current_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_enterprise_status_check',
      sql`${table.status} IN ('PROPOSED', 'ACTIVE', 'INACTIVE')`,
    ),
    check(
      'seb_enterprise_registration_check',
      sql`(${table.registrationType} = 'NONE' AND ${table.registrationNumber} IS NULL)
        OR (${table.registrationType} IN ('CIN', 'UDYAM') AND ${table.registrationNumber} IS NOT NULL)`,
    ),
    index('seb_enterprise_owner_idx').on(
      table.portalOwnerUserId,
      table.deletedAt,
      table.updatedAt,
    ),
  ],
)

/** Complete immutable canonical profile for one enterprise version. */
export const sebEnterpriseVersion = sqliteTable(
  'seb_enterprise_version',
  {
    id: text('id').primaryKey(),
    enterpriseId: text('enterprise_id')
      .notNull()
      .references(() => sebEnterprise.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    changeType: text('change_type', { enum: enterpriseChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),

    name: text('name').notNull(),
    establishmentDate: text('establishment_date'),
    registrationType: text('registration_type', { enum: registrationTypes }).notNull(),
    registrationNumber: text('registration_number'),
    gstin: text('gstin'),
    businessSector: text('business_sector', { enum: businessSectors }),
    otherBusinessSector: text('other_business_sector'),
    businessBlockOrVillage: text('business_block_or_village'),
    businessDistrict: text('business_district'),
    businessPinCode: text('business_pin_code'),
    contactNumber: text('contact_number'),
    contactEmail: text('contact_email'),
    status: text('status', { enum: enterpriseStatuses }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_enterprise_version_number_uq').on(table.enterpriseId, table.version),
    check('seb_enterprise_version_number_check', sql`${table.version} >= 1`),
    check(
      'seb_enterprise_version_change_type_check',
      sql`${table.changeType} IN ('CREATED', 'UPDATED', 'CORRECTED')`,
    ),
    check(
      'seb_enterprise_version_status_check',
      sql`${table.status} IN ('PROPOSED', 'ACTIVE', 'INACTIVE')`,
    ),
    check(
      'seb_enterprise_version_registration_check',
      sql`(${table.registrationType} = 'NONE' AND ${table.registrationNumber} IS NULL)
        OR (${table.registrationType} IN ('CIN', 'UDYAM') AND ${table.registrationNumber} IS NOT NULL)`,
    ),
    check(
      'seb_enterprise_version_sector_check',
      sql`${table.businessSector} IS NULL OR ${table.businessSector} IN ('AGRICULTURE_AND_ALLIED', 'HANDLOOM_TEXTILE_AND_HANDICRAFTS', 'FOOD_PROCESSING', 'TOURISM_AND_HOSPITALITY', 'INFORMATION_TECHNOLOGY', 'MANUFACTURING_AND_SERVICES', 'OTHER')`,
    ),
  ],
)
