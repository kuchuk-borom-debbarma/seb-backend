/**
 * Moving between the application snapshot the API returns and the draft input
 * it accepts.
 *
 * The two shapes are close but not identical: a snapshot carries derived facts
 * an applicant never types — the phase, the prior award it was built from — and
 * the draft input carries only answers. Converting in one place keeps every
 * screen agreeing about which is which.
 *
 * A draft save replaces the complete snapshot, so a section the applicant did
 * not touch still has to be sent exactly as it was. Anything dropped here would
 * be silently erased.
 */
import type {
  ApplicationByIdQuery,
  ApplicationDraftInput,
} from '#/graphql/generated/operations'
import type { ApplicationSection } from '#/graphql/generated/schema'

type Application = NonNullable<
  ApplicationByIdQuery['seb']['application']['byId']['response']
>

/** The sections an applicant fills in, in the order the form presents them. */
export const FORM_SECTIONS: ApplicationSection[] = [
  'ENTERPRISE',
  'APPLICANT_PROFILE',
  'FINANCIAL',
  'PRIOR_FUNDING',
  'DOCUMENTS',
  'DECLARATION',
]

export const SECTION_TITLES: Record<string, string> = {
  ENTERPRISE: 'The enterprise',
  APPLICANT_PROFILE: 'About you',
  FINANCIAL: 'Project cost and funding',
  PRIOR_FUNDING: 'Previous support and credit',
  DOCUMENTS: 'Evidence',
  DECLARATION: 'Declaration',
  EXPANSION: 'Expansion evidence',
}

/**
 * Builds the draft input from the current snapshot.
 *
 * `EXPANSION` is absent on purpose: those values are derived by the server from
 * the qualifying award and are rejected if a client tries to send them.
 */
export const draftFromSnapshot = (application: Application): ApplicationDraftInput => {
  const snapshot = application.snapshot
  return {
    enterprise: {
      businessName: snapshot.enterprise.businessName,
      establishmentDate: snapshot.enterprise.establishmentDate,
      registrationType: snapshot.enterprise.registrationType,
      registrationNumber: snapshot.enterprise.registrationNumber,
      gstin: snapshot.enterprise.gstin,
      businessSector: snapshot.enterprise.businessSector,
      otherBusinessSector: snapshot.enterprise.otherBusinessSector,
      applicationCategory: snapshot.enterprise.applicationCategory,
      majorityOwnershipConfirmed: snapshot.enterprise.majorityOwnershipConfirmed,
    },
    applicantProfile: {
      primaryApplicantName: snapshot.applicantProfile.primaryApplicantName,
      designation: snapshot.applicantProfile.designation,
      dateOfBirth: snapshot.applicantProfile.dateOfBirth,
      gender: snapshot.applicantProfile.gender,
      businessBlockOrVillage: snapshot.applicantProfile.businessBlockOrVillage,
      businessDistrict: snapshot.applicantProfile.businessDistrict,
      businessPinCode: snapshot.applicantProfile.businessPinCode,
      contactNumber: snapshot.applicantProfile.contactNumber,
      contactEmail: snapshot.applicantProfile.contactEmail,
    },
    financial: {
      totalProjectCostPaise: snapshot.financial.totalProjectCostPaise,
      seedFundRequestedPaise: snapshot.financial.seedFundRequestedPaise,
      bankLoanProposedPaise: snapshot.financial.bankLoanProposedPaise,
      promoterContributionPaise: snapshot.financial.promoterContributionPaise,
    },
    priorFunding: {
      receivedGovernmentFunding: snapshot.priorFunding.receivedGovernmentFunding,
      governmentSchemeName: snapshot.priorFunding.governmentSchemeName,
      governmentFundingAmountPaise: snapshot.priorFunding.governmentFundingAmountPaise,
      governmentFundingSanctionYear: snapshot.priorFunding.governmentFundingSanctionYear,
      hasExistingBankCredit: snapshot.priorFunding.hasExistingBankCredit,
      existingBankName: snapshot.priorFunding.existingBankName,
      existingCreditAmountPaise: snapshot.priorFunding.existingCreditAmountPaise,
      existingCreditStatus: snapshot.priorFunding.existingCreditStatus,
    },
    documents: { nocRequired: snapshot.documents.nocRequired },
    declaration: {
      relationshipType: snapshot.declaration.relationshipType,
      relatedPersonName: snapshot.declaration.relatedPersonName,
      declarationAccepted: snapshot.declaration.declarationAccepted,
      declarationPlace: snapshot.declaration.declarationPlace,
    },
  }
}

/**
 * True when two drafts carry the same answers.
 *
 * Used to skip a save that would change nothing. The API already treats an
 * unchanged draft as a no-op and returns the same version, so this only avoids
 * spending a round trip to be told so. Key order is stable because both sides
 * are built by `draftFromSnapshot`.
 */
export const sameDraft = (
  left: ApplicationDraftInput,
  right: ApplicationDraftInput,
): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Rupees for display, paise on the wire — the Money scalar is always paise. */
export const paiseToRupees = (paise: string | null | undefined): string =>
  paise === null || paise === undefined ? '' : String(Number(paise) / 100)

export const rupeesToPaise = (rupees: string): string | null =>
  rupees.trim() === '' ? null : String(Math.round(Number(rupees) * 100))
