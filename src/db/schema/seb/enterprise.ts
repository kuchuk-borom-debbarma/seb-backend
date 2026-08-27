/**
 * Canonical enterprise records shared by every Mission SEP application.
 *
 * The mutable head keeps the fields needed for fast lists and uniqueness checks.
 * Every accepted change also writes a complete immutable version so applications
 * can preserve their submitted snapshot independently of the live enterprise.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { dateOnly, instant, versionedSoftDeleteColumns } from '../shared'

export const enterpriseStatuses = ['PROPOSED', 'ACTIVE', 'INACTIVE'] as const
export const enterpriseChangeTypes = ['CREATED', 'UPDATED', 'CORRECTED'] as const
export const registrationTypes = [
  'PRIVATE_LIMITED',
  'LLP',
  'SOLE_PROPRIETORSHIP',
  'OPC',
] as const
/*
 * A closed set rather than free text: eligibility screening groups and filters
 * by district, and Tripura has exactly these eight — prose spellings of the
 * same place would silently split them.
 */
export const tripuraDistricts = [
  'DHALAI',
  'GOMATI',
  'KHOWAI',
  'NORTH_TRIPURA',
  'SEPAHIJALA',
  'SOUTH_TRIPURA',
  'UNAKOTI',
  'WEST_TRIPURA',
] as const
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
export const sebEnterprise = pgTable(
  'seb_enterprise',
  {
    id: text('id').primaryKey(),
    portalOwnerUserId: text('portal_owner_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),

    // Current values are duplicated from the latest immutable version for
    // efficient lists, ownership checks, and registration uniqueness.
    currentName: text('current_name').notNull(),
    registrationType: text('registration_type', { enum: registrationTypes }).notNull(),
    registrationNumber: text('registration_number'),
    gstin: text('gstin').unique(),
    status: text('status', { enum: enterpriseStatuses }).notNull().default('PROPOSED'),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    unique('seb_enterprise_owner_id_uq').on(table.portalOwnerUserId, table.id),
    uniqueIndex('seb_enterprise_registration_uq').on(
      table.registrationType,
      table.registrationNumber,
    ),
    check('seb_enterprise_current_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_enterprise_status_check',
      sql`${table.status} IN ('PROPOSED', 'ACTIVE', 'INACTIVE')`,
    ),
    /*
     * Companies, LLPs and OPCs hold a statutory number (CIN/LLPIN) from the
     * moment of incorporation, so claiming the type without one is a
     * contradiction. A sole proprietorship has no incorporation instrument —
     * it may have nothing to quote, or a number it happens to hold.
     */
    check(
      'seb_enterprise_registration_check',
      sql`(${table.registrationType} = 'SOLE_PROPRIETORSHIP')
        OR (${table.registrationType} IN ('PRIVATE_LIMITED', 'LLP', 'OPC') AND ${table.registrationNumber} IS NOT NULL)`,
    ),
    /*
     * One name per owner, and the prefix search, in one index.
     *
     * **Unique per owner, deliberately not globally.** Unrelated businesses do
     * share trading names, and refusing the second one would leave a legitimate
     * applicant with nothing they could do about it. What is unique across the
     * whole programme is the GSTIN and the registration number — those are
     * identifiers; a name is a label.
     *
     * Partial, so a deleted enterprise does not reserve its name forever. That
     * matches the cap, which also counts only live ones: deleting one has to
     * actually free the slot, name included.
     *
     * The opclass is what lets the same index answer `LIKE 'term%'` — see the
     * reference-number index in `application.ts`. Searching an owner's deleted
     * enterprises falls outside it and scans, which is one person's handful of
     * rows on a path almost nobody takes.
     */
    uniqueIndex('seb_enterprise_owner_name_uq')
      .on(table.portalOwnerUserId, sql`lower(${table.currentName}) text_pattern_ops`)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_enterprise_owner_idx')
      .on(table.portalOwnerUserId, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

/** Complete immutable canonical profile for one enterprise version. */
export const sebEnterpriseVersion = pgTable(
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
    createdAt: instant('created_at').notNull(),

    name: text('name').notNull(),
    establishmentDate: dateOnly('establishment_date'),
    registrationType: text('registration_type', { enum: registrationTypes }).notNull(),
    registrationNumber: text('registration_number'),
    gstin: text('gstin'),
    businessSector: text('business_sector', { enum: businessSectors }),
    otherBusinessSector: text('other_business_sector'),
    businessBlockOrVillage: text('business_block_or_village'),
    businessDistrict: text('business_district', { enum: tripuraDistricts }),
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
    // Same rule as the head's registration CHECK; see the comment there.
    check(
      'seb_enterprise_version_registration_check',
      sql`(${table.registrationType} = 'SOLE_PROPRIETORSHIP')
        OR (${table.registrationType} IN ('PRIVATE_LIMITED', 'LLP', 'OPC') AND ${table.registrationNumber} IS NOT NULL)`,
    ),
    // Written out because text(col, { enum }) emits no SQL constraint of its
    // own — the type annotation without this CHECK would enforce nothing.
    check(
      'seb_enterprise_version_district_check',
      sql`${table.businessDistrict} IS NULL OR ${table.businessDistrict} IN ('DHALAI', 'GOMATI', 'KHOWAI', 'NORTH_TRIPURA', 'SEPAHIJALA', 'SOUTH_TRIPURA', 'UNAKOTI', 'WEST_TRIPURA')`,
    ),
    check(
      'seb_enterprise_version_sector_check',
      sql`${table.businessSector} IS NULL OR ${table.businessSector} IN ('AGRICULTURE_AND_ALLIED', 'HANDLOOM_TEXTILE_AND_HANDICRAFTS', 'FOOD_PROCESSING', 'TOURISM_AND_HOSPITALITY', 'INFORMATION_TECHNOLOGY', 'MANUFACTURING_AND_SERVICES', 'OTHER')`,
    ),
    /*
     * The intake queue filters and the analytics groupings read the sector and
     * the district live from the enterprise's current version. Whole-column
     * rather than partial: NULL is rare here — only a profile saved before
     * these questions — so excluding it would buy nothing.
     */
    index('seb_enterprise_version_sector_idx').on(table.businessSector),
    index('seb_enterprise_version_district_idx').on(table.businessDistrict),
  ],
)
