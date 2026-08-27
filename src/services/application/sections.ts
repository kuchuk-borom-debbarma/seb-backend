/**
 * Which snapshot fields belong to which form section.
 *
 * Two features need this and must agree: the administrative workspace showing
 * what changed between two submissions, and the applicant's review of what they
 * are about to resubmit. A second copy would let one of them omit a field and
 * quietly report "no change" for an edit that really happened.
 *
 * The keys are `ApplicationSection` values and the entries are column names on
 * an application version, so adding a field to a snapshot without listing it
 * here is a compile error rather than a silent gap.
 */
import type { sebApplicationVersion } from '../../db/schema'
import type { ApplicationSection } from './types'

type SnapshotRecord = typeof sebApplicationVersion.$inferSelect
type SnapshotField = keyof SnapshotRecord

const sectionFields: Record<ApplicationSection, readonly SnapshotField[]> = {
  ENTERPRISE: [
    'businessName', 'establishmentDate', 'registrationType', 'registrationNumber',
    'gstin', 'businessSector', 'otherBusinessSector', 'applicationCategory',
    'majorityOwnershipConfirmed',
  ],
  APPLICANT_PROFILE: [
    'primaryApplicantName', 'designation', 'dateOfBirth', 'gender',
    'businessBlockOrVillage', 'businessDistrict', 'businessPinCode', 'contactNumber',
    'contactEmail',
  ],
  FINANCIAL: [
    'totalProjectCostPaise', 'seedFundRequestedPaise', 'bankLoanProposedPaise',
    'promoterContributionPaise',
  ],
  PRIOR_FUNDING: [
    'receivedGovernmentFunding', 'governmentSchemeName', 'governmentFundingAmountPaise',
    'governmentFundingSanctionYear', 'hasExistingBankCredit', 'existingBankName',
    'existingCreditAmountPaise', 'existingCreditStatus',
  ],
  EXPANSION: [
    'priorSanctionOrderNumber', 'priorSanctionDate', 'priorNetDisbursedAmountPaise',
    'continuousOperationMonths',
  ],
  DOCUMENTS: ['nocRequired'],
}

/**
 * Names the sections whose answers differ between two snapshots.
 *
 * Compared field by field rather than by serializing the rows, because two
 * snapshots always differ in their id, version, and creation time, and a
 * whole-row comparison would report every section as changed.
 */
export const changedSections = (
  previous: SnapshotRecord,
  current: SnapshotRecord,
): ApplicationSection[] =>
  (Object.keys(sectionFields) as ApplicationSection[]).filter((section) =>
    sectionFields[section].some((field) => {
      const before = previous[field]
      const after = current[field]
      // Dates are compared by instant; `!==` on two Date objects is always true.
      if (before instanceof Date || after instanceof Date) {
        return (before as Date | null)?.getTime() !== (after as Date | null)?.getTime()
      }
      return before !== after
    }),
  )
