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

/**
 * What each section is called on screen.
 *
 * Typed over the section enum rather than as an open record, so adding a
 * section to the API fails the build here instead of rendering a blank heading.
 */
export const SECTION_TITLES: Record<ApplicationSection, string> = {
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

/**
 * The title of a section named by a string the type system cannot narrow — an
 * API record that reports its section as plain text. Falls back to the raw name
 * rather than rendering nothing.
 */
export const sectionTitle = (section: string): string =>
  SECTION_TITLES[section as ApplicationSection] ?? section.replaceAll('_', ' ')

/**
 * What each question is called, in the applicant's words.
 *
 * One map, read by both the form and the validation report. They used to name
 * the same question differently — the report derived "Primary applicant name"
 * from the field while the form asked "Your full name" — which left somebody
 * hunting the form for a label that was not on it.
 *
 * Fields the applicant never types are absent on purpose: the expansion values
 * are derived by the server, and a document is named by its type rather than by
 * a form field.
 */
export const FIELD_LABELS = {
  // The enterprise
  businessName: 'Business name',
  establishmentDate: 'Date established',
  applicationCategory: 'Category',
  registrationType: 'Registration',
  registrationNumber: 'Registration number',
  gstin: 'GSTIN',
  businessSector: 'Sector',
  otherBusinessSector: 'Describe the sector',
  majorityOwnershipConfirmed: 'Majority ownership is held by Scheduled Tribe members',

  // About you
  primaryApplicantName: 'Your full name',
  designation: 'Your role in the enterprise',
  dateOfBirth: 'Date of birth',
  gender: 'Gender',
  businessBlockOrVillage: 'Block or village',
  businessDistrict: 'District',
  businessPinCode: 'PIN code',
  contactNumber: 'Contact number',
  contactEmail: 'Contact email',

  // Project cost and funding
  totalProjectCostPaise: 'Total project cost (₹)',
  seedFundRequestedPaise: 'Seed fund requested (₹)',
  bankLoanProposedPaise: 'Bank loan proposed (₹)',
  promoterContributionPaise: 'Your own contribution (₹)',

  // Previous support and credit
  receivedGovernmentFunding: 'Has this enterprise received government funding before?',
  governmentSchemeName: 'Scheme',
  governmentFundingAmountPaise: 'Amount received (₹)',
  governmentFundingSanctionYear: 'Year sanctioned',
  hasExistingBankCredit: 'Does this enterprise have existing bank credit?',
  existingBankName: 'Bank',
  existingCreditAmountPaise: 'Amount outstanding (₹)',
  existingCreditStatus: 'Account status',

  // Evidence
  nocRequired: 'Is a no-objection certificate needed for these premises?',

  // Declaration
  relationshipType: 'Relationship',
  relatedPersonName: 'Of (name)',
  declarationAccepted:
    'I declare that everything in this application is true and complete.',
  declarationPlace: 'Place',
} as const satisfies Record<string, string>

/**
 * The label for a field, falling back to the field's own name.
 *
 * The fallback matters: the API may report an issue against a field this client
 * does not render, and showing the raw name is more use than showing nothing.
 */
export const fieldLabel = (field: string): string =>
  (FIELD_LABELS as Record<string, string>)[field] ??
  field.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase()
