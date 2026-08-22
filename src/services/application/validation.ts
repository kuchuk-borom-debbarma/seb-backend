/**
 * Pure application-form normalization and validation.
 *
 * Keeping policy rules free of D1/R2 calls makes boundary behavior explicit
 * and lets both the validation query and submission mutation use exactly the
 * same rules.
 */
import {
  applicationCategories,
  applicantDesignations,
  businessSectors,
  creditStatuses,
  genders,
  registrationTypes,
  relationshipTypes,
} from '../../db/schema'
import type {
  ApplicationDraftInput,
  ApplicationSection,
  ApplicationSnapshot,
  DocumentType,
  ValidationIssue,
  ValidationReport,
  EnterpriseProfileInput,
} from './types'

const MAX_MONEY_PAISE = Number.MAX_SAFE_INTEGER
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const PHONE_PATTERN = /^\+?[1-9]\d{7,14}$/u
const PIN_PATTERN = /^\d{6}$/u
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/u
const MAX_SHORT_TEXT = 200
const MAX_ADDRESS_TEXT = 500
const MAX_EMAIL_LENGTH = 254

const requiredKeys = {
  enterprise: [
    'businessName',
    'establishmentDate',
    'registrationType',
    'registrationNumber',
    'gstin',
    'businessSector',
    'otherBusinessSector',
    'applicationCategory',
    'majorityOwnershipConfirmed',
  ],
  applicantProfile: [
    'primaryApplicantName',
    'designation',
    'dateOfBirth',
    'gender',
    'businessBlockOrVillage',
    'businessDistrict',
    'businessPinCode',
    'contactNumber',
    'contactEmail',
  ],
  financial: [
    'totalProjectCostPaise',
    'seedFundRequestedPaise',
    'bankLoanProposedPaise',
    'promoterContributionPaise',
  ],
  priorFunding: [
    'receivedGovernmentFunding',
    'governmentSchemeName',
    'governmentFundingAmountPaise',
    'governmentFundingSanctionYear',
    'hasExistingBankCredit',
    'existingBankName',
    'existingCreditAmountPaise',
    'existingCreditStatus',
  ],
  documents: ['nocRequired'],
  declaration: [
    'relationshipType',
    'relatedPersonName',
    'declarationAccepted',
    'declarationPlace',
  ],
} as const

const issue = (
  section: ApplicationSection,
  field: string,
  code: string,
  message: string,
): ValidationIssue => ({ section, field, code, message })

const cleanText = (value: string | null): string | null => {
  if (value === null) return null
  const cleaned = value.trim().replace(/\s+/gu, ' ')
  return cleaned === '' ? null : cleaned
}

const cleanUpper = (value: string | null): string | null => cleanText(value)?.toUpperCase() ?? null

/** Returns a UTC date only when the input is an actual ISO calendar date. */
export const parseDateOnly = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null
}

const fullCalendarYears = (from: Date, to: Date): number => {
  let years = to.getUTCFullYear() - from.getUTCFullYear()
  const anniversary = new Date(
    Date.UTC(to.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  )
  if (anniversary.getTime() > to.getTime()) years -= 1
  return years
}

export const addUtcCalendarMonths = (value: Date, months: number): Date => {
  const day = value.getUTCDate()
  const target = new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months + 1,
      0,
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  )
  target.setUTCDate(Math.min(day, target.getUTCDate()))
  return target
}

export const fullUtcCalendarMonths = (from: Date, to: Date): number => {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    to.getUTCMonth() -
    from.getUTCMonth()
  if (addUtcCalendarMonths(from, months).getTime() > to.getTime()) months -= 1
  return Math.max(0, months)
}

const hasAllSnapshotKeys = (input: ApplicationDraftInput): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const sections: Array<keyof typeof requiredKeys> = [
    'enterprise',
    'applicantProfile',
    'financial',
    'priorFunding',
    'documents',
    'declaration',
  ]
  for (const section of sections) {
    const value = input[section] as unknown
    if (!value || typeof value !== 'object') {
      issues.push(issue('ENTERPRISE', section, 'MISSING_SECTION', `The ${section} section is required.`))
      continue
    }
    for (const key of requiredKeys[section]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        const applicationSection: ApplicationSection =
          section === 'applicantProfile'
            ? 'APPLICANT_PROFILE'
            : section === 'priorFunding'
              ? 'PRIOR_FUNDING'
              : section === 'documents'
                ? 'DOCUMENTS'
                : section.toUpperCase() as ApplicationSection
        issues.push(
          issue(
            applicationSection,
            key,
            'MISSING_SNAPSHOT_FIELD',
            `The replacement snapshot must include ${key}.`,
          ),
        )
      }
    }
  }
  return issues
}

const validEnum = <T extends string>(value: T | null, allowed: readonly T[]): boolean =>
  value === null || allowed.includes(value)

const validateTextLength = (
  issues: ValidationIssue[],
  section: ApplicationSection,
  field: string,
  value: string | null,
  maximum: number,
) => {
  if (value !== null && value.length > maximum) {
    issues.push(
      issue(section, field, 'TOO_LONG', `This field must contain at most ${maximum} characters.`),
    )
  }
}

const validateEnums = (input: ApplicationDraftInput): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const { enterprise, applicantProfile, priorFunding, declaration } = input
  if (!validEnum(enterprise.registrationType, registrationTypes)) {
    issues.push(issue('ENTERPRISE', 'registrationType', 'INVALID_ENUM', 'Select a valid registration type.'))
  }
  if (!validEnum(enterprise.businessSector, businessSectors)) {
    issues.push(issue('ENTERPRISE', 'businessSector', 'INVALID_ENUM', 'Select a valid business sector.'))
  }
  if (!validEnum(enterprise.applicationCategory, applicationCategories)) {
    issues.push(issue('ENTERPRISE', 'applicationCategory', 'INVALID_ENUM', 'Select a valid application category.'))
  }
  if (!validEnum(applicantProfile.designation, applicantDesignations)) {
    issues.push(issue('APPLICANT_PROFILE', 'designation', 'INVALID_ENUM', 'Select a valid designation.'))
  }
  if (!validEnum(applicantProfile.gender, genders)) {
    issues.push(issue('APPLICANT_PROFILE', 'gender', 'INVALID_ENUM', 'Select a valid gender.'))
  }
  if (!validEnum(priorFunding.existingCreditStatus, creditStatuses)) {
    issues.push(issue('PRIOR_FUNDING', 'existingCreditStatus', 'INVALID_ENUM', 'Select a valid credit status.'))
  }
  if (!validEnum(declaration.relationshipType, relationshipTypes)) {
    issues.push(issue('DECLARATION', 'relationshipType', 'INVALID_ENUM', 'Select a valid relationship.'))
  }
  return issues
}

const validateDatesAndContacts = (input: ApplicationDraftInput): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const { enterprise, applicantProfile } = input
  for (const [field, value] of [
    ['establishmentDate', enterprise.establishmentDate],
    ['dateOfBirth', applicantProfile.dateOfBirth],
  ] as const) {
    if (value !== null && parseDateOnly(value) === null) {
      issues.push(
        issue(
          field === 'dateOfBirth' ? 'APPLICANT_PROFILE' : 'ENTERPRISE',
          field,
          'INVALID_DATE',
          'Enter a real date in YYYY-MM-DD format.',
        ),
      )
    }
  }

  if (enterprise.gstin !== null && !GSTIN_PATTERN.test(enterprise.gstin)) {
    issues.push(issue('ENTERPRISE', 'gstin', 'INVALID_GSTIN', 'Enter a valid GSTIN.'))
  }
  if (
    applicantProfile.contactEmail !== null &&
    !EMAIL_PATTERN.test(applicantProfile.contactEmail)
  ) {
    issues.push(issue('APPLICANT_PROFILE', 'contactEmail', 'INVALID_EMAIL', 'Enter a valid email address.'))
  }
  if (
    applicantProfile.contactNumber !== null &&
    !PHONE_PATTERN.test(applicantProfile.contactNumber)
  ) {
    issues.push(issue('APPLICANT_PROFILE', 'contactNumber', 'INVALID_PHONE', 'Enter a valid phone number.'))
  }
  if (
    applicantProfile.businessPinCode !== null &&
    !PIN_PATTERN.test(applicantProfile.businessPinCode)
  ) {
    issues.push(issue('APPLICANT_PROFILE', 'businessPinCode', 'INVALID_PIN', 'Enter a six-digit PIN code.'))
  }
  return issues
}

const validateMoneyAndFlags = (input: ApplicationDraftInput): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const { financial, priorFunding, documents } = input
  const moneyEntries = Object.entries(financial).concat([
    ['governmentFundingAmountPaise', priorFunding.governmentFundingAmountPaise],
    ['existingCreditAmountPaise', priorFunding.existingCreditAmountPaise],
  ]) as Array<[string, number | null]>
  for (const [field, value] of moneyEntries) {
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY_PAISE)
    ) {
      issues.push(issue(field in financial ? 'FINANCIAL' : 'PRIOR_FUNDING', field, 'INVALID_MONEY', 'Money must be a non-negative integer number of paise.'))
    }
  }
  if (
    priorFunding.governmentFundingSanctionYear !== null &&
    (!Number.isInteger(priorFunding.governmentFundingSanctionYear) ||
      priorFunding.governmentFundingSanctionYear < 1900 ||
      priorFunding.governmentFundingSanctionYear > 9999)
  ) {
    issues.push(issue('PRIOR_FUNDING', 'governmentFundingSanctionYear', 'INVALID_YEAR', 'Enter a valid four-digit year.'))
  }
  if (documents.nocRequired !== null && typeof documents.nocRequired !== 'boolean') {
    issues.push(issue('DOCUMENTS', 'nocRequired', 'INVALID_BOOLEAN', 'NOC applicability must be true or false.'))
  }
  return issues
}

const validateTextFields = (input: ApplicationDraftInput): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const { enterprise, applicantProfile, priorFunding, declaration } = input
  for (const [section, field, value, maximum] of [
    ['ENTERPRISE', 'businessName', enterprise.businessName, MAX_SHORT_TEXT],
    ['ENTERPRISE', 'registrationNumber', enterprise.registrationNumber, MAX_SHORT_TEXT],
    ['ENTERPRISE', 'otherBusinessSector', enterprise.otherBusinessSector, MAX_SHORT_TEXT],
    ['APPLICANT_PROFILE', 'primaryApplicantName', applicantProfile.primaryApplicantName, MAX_SHORT_TEXT],
    ['APPLICANT_PROFILE', 'businessBlockOrVillage', applicantProfile.businessBlockOrVillage, MAX_ADDRESS_TEXT],
    ['APPLICANT_PROFILE', 'businessDistrict', applicantProfile.businessDistrict, MAX_SHORT_TEXT],
    ['APPLICANT_PROFILE', 'contactEmail', applicantProfile.contactEmail, MAX_EMAIL_LENGTH],
    ['PRIOR_FUNDING', 'governmentSchemeName', priorFunding.governmentSchemeName, MAX_SHORT_TEXT],
    ['PRIOR_FUNDING', 'existingBankName', priorFunding.existingBankName, MAX_SHORT_TEXT],
    ['DECLARATION', 'relatedPersonName', declaration.relatedPersonName, MAX_SHORT_TEXT],
    ['DECLARATION', 'declarationPlace', declaration.declarationPlace, MAX_SHORT_TEXT],
  ] as const) validateTextLength(issues, section, field, value, maximum)
  return issues
}

const validateOptionalFormats = (input: ApplicationDraftInput): ValidationIssue[] => [
  ...validateEnums(input),
  ...validateDatesAndContacts(input),
  ...validateMoneyAndFlags(input),
  ...validateTextFields(input),
]

export const normalizeDraftInput = (
  input: ApplicationDraftInput,
): { value: ApplicationDraftInput | null; issues: ValidationIssue[] } => {
  const keyIssues = hasAllSnapshotKeys(input)
  if (keyIssues.length > 0) return { value: null, issues: keyIssues }

  const value: ApplicationDraftInput = {
    enterprise: {
      ...input.enterprise,
      businessName: cleanText(input.enterprise.businessName),
      establishmentDate: cleanText(input.enterprise.establishmentDate),
      registrationNumber: cleanUpper(input.enterprise.registrationNumber),
      gstin: cleanUpper(input.enterprise.gstin),
      otherBusinessSector: cleanText(input.enterprise.otherBusinessSector),
    },
    applicantProfile: {
      ...input.applicantProfile,
      primaryApplicantName: cleanText(input.applicantProfile.primaryApplicantName),
      dateOfBirth: cleanText(input.applicantProfile.dateOfBirth),
      businessBlockOrVillage: cleanText(input.applicantProfile.businessBlockOrVillage),
      businessDistrict: cleanText(input.applicantProfile.businessDistrict),
      businessPinCode: cleanText(input.applicantProfile.businessPinCode),
      contactNumber: cleanText(input.applicantProfile.contactNumber)?.replace(/[\s()-]/gu, '') ?? null,
      contactEmail: cleanText(input.applicantProfile.contactEmail)?.toLowerCase() ?? null,
    },
    financial: { ...input.financial },
    priorFunding: {
      ...input.priorFunding,
      governmentSchemeName: cleanText(input.priorFunding.governmentSchemeName),
      existingBankName: cleanText(input.priorFunding.existingBankName),
    },
    documents: { ...input.documents },
    declaration: {
      ...input.declaration,
      relatedPersonName: cleanText(input.declaration.relatedPersonName),
      declarationPlace: cleanText(input.declaration.declarationPlace),
    },
  }
  return { value, issues: validateOptionalFormats(value) }
}

export const normalizeEnterpriseProfile = (
  input: EnterpriseProfileInput,
): { value: EnterpriseProfileInput | null; message: string | null } => {
  const value: EnterpriseProfileInput = {
    ...input,
    name: cleanText(input.name) ?? '',
    establishmentDate: cleanText(input.establishmentDate),
    registrationNumber: cleanUpper(input.registrationNumber),
    gstin: cleanUpper(input.gstin),
    otherBusinessSector: cleanText(input.otherBusinessSector),
    businessBlockOrVillage: cleanText(input.businessBlockOrVillage),
    businessDistrict: cleanText(input.businessDistrict),
    businessPinCode: cleanText(input.businessPinCode),
    contactNumber: cleanText(input.contactNumber)?.replace(/[\s()-]/gu, '') ?? null,
    contactEmail: cleanText(input.contactEmail)?.toLowerCase() ?? null,
  }
  if (value.name.length < 2 || value.name.length > 200) {
    return { value: null, message: 'Enterprise name must contain 2 to 200 characters.' }
  }
  if (!registrationTypes.includes(value.registrationType)) {
    return { value: null, message: 'Select a valid registration type.' }
  }
  if (
    (value.registrationType === 'NONE' && value.registrationNumber !== null) ||
    (value.registrationType !== 'NONE' && value.registrationNumber === null)
  ) return { value: null, message: 'Registration details do not match the registration type.' }
  if (value.establishmentDate !== null && parseDateOnly(value.establishmentDate) === null) {
    return { value: null, message: 'Enter a real establishment date in YYYY-MM-DD format.' }
  }
  if (value.gstin !== null && !GSTIN_PATTERN.test(value.gstin)) {
    return { value: null, message: 'Enter a valid GSTIN.' }
  }
  if (value.businessSector !== null && !businessSectors.includes(value.businessSector)) {
    return { value: null, message: 'Select a valid business sector.' }
  }
  if (value.businessSector === 'OTHER' && value.otherBusinessSector === null) {
    return { value: null, message: 'Describe the other business sector.' }
  }
  if (value.businessPinCode !== null && !PIN_PATTERN.test(value.businessPinCode)) {
    return { value: null, message: 'Enter a six-digit PIN code.' }
  }
  if (value.contactNumber !== null && !PHONE_PATTERN.test(value.contactNumber)) {
    return { value: null, message: 'Enter a valid phone number.' }
  }
  if (value.contactEmail !== null && !EMAIL_PATTERN.test(value.contactEmail)) {
    return { value: null, message: 'Enter a valid email address.' }
  }
  for (const [field, text, maximum] of [
    ['registration number', value.registrationNumber, MAX_SHORT_TEXT],
    ['other business sector', value.otherBusinessSector, MAX_SHORT_TEXT],
    ['block or village', value.businessBlockOrVillage, MAX_ADDRESS_TEXT],
    ['district', value.businessDistrict, MAX_SHORT_TEXT],
    ['email address', value.contactEmail, MAX_EMAIL_LENGTH],
  ] as const) {
    if (text !== null && text.length > maximum) {
      return { value: null, message: `Enterprise ${field} must contain at most ${maximum} characters.` }
    }
  }
  return { value, message: null }
}

const requireValue = (
  issues: ValidationIssue[],
  section: ApplicationSection,
  field: string,
  value: unknown,
) => {
  if (value === null || value === undefined || value === '') {
    issues.push(issue(section, field, 'REQUIRED', 'This field is required.'))
  }
}

const validateEnterpriseSubmission = (
  snapshot: ApplicationSnapshot,
  issues: ValidationIssue[],
  now: Date,
) => {
  const { enterprise } = snapshot
  for (const [field, value] of [
    ['businessName', enterprise.businessName],
    ['registrationType', enterprise.registrationType],
    ['businessSector', enterprise.businessSector],
    ['applicationCategory', enterprise.applicationCategory],
  ] as const) requireValue(issues, 'ENTERPRISE', field, value)
  if (enterprise.majorityOwnershipConfirmed !== true) {
    issues.push(issue('ENTERPRISE', 'majorityOwnershipConfirmed', 'MUST_CONFIRM', 'Majority ownership must be confirmed.'))
  }
  if (enterprise.registrationType === 'NONE' && enterprise.registrationNumber !== null) {
    issues.push(issue('ENTERPRISE', 'registrationNumber', 'MUST_BE_EMPTY', 'An unregistered enterprise cannot have a registration number.'))
  }
  if (
    enterprise.registrationType !== null &&
    enterprise.registrationType !== 'NONE' &&
    enterprise.registrationNumber === null
  ) requireValue(issues, 'ENTERPRISE', 'registrationNumber', null)
  if (enterprise.businessSector === 'OTHER') {
    requireValue(issues, 'ENTERPRISE', 'otherBusinessSector', enterprise.otherBusinessSector)
  }

  const establishment = enterprise.establishmentDate
    ? parseDateOnly(enterprise.establishmentDate)
    : null
  if (establishment && establishment.getTime() > now.getTime()) {
    issues.push(issue('ENTERPRISE', 'establishmentDate', 'FUTURE_DATE', 'Establishment date cannot be in the future.'))
  }
  if (enterprise.applicationCategory === 'CATEGORY_B' && establishment === null) {
    requireValue(issues, 'ENTERPRISE', 'establishmentDate', null)
  }
  if (!establishment || !enterprise.applicationCategory) return

  const ageBoundary = addUtcCalendarMonths(establishment, 24)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const categoryMismatch =
    (enterprise.applicationCategory === 'CATEGORY_A' && today > ageBoundary.getTime()) ||
    (enterprise.applicationCategory === 'CATEGORY_B' && today <= ageBoundary.getTime())
  if (categoryMismatch) {
    issues.push(issue(
      'ENTERPRISE',
      'applicationCategory',
      'CATEGORY_MISMATCH',
      enterprise.applicationCategory === 'CATEGORY_A'
        ? 'Category A enterprises must be proposed or at most 24 months old.'
        : 'Category B enterprises must be older than 24 months.',
    ))
  }
}

const validateApplicantSubmission = (
  snapshot: ApplicationSnapshot,
  issues: ValidationIssue[],
  now: Date,
) => {
  for (const [field, value] of Object.entries(snapshot.applicantProfile)) {
    requireValue(issues, 'APPLICANT_PROFILE', field, value)
  }
  const birthDate = snapshot.applicantProfile.dateOfBirth
    ? parseDateOnly(snapshot.applicantProfile.dateOfBirth)
    : null
  if (!birthDate) return
  const age = fullCalendarYears(birthDate, now)
  if (birthDate.getTime() > now.getTime() || age < 18 || age > 60) {
    issues.push(issue('APPLICANT_PROFILE', 'dateOfBirth', 'AGE_INELIGIBLE', 'Applicant age must be from 18 through 60.'))
  }
}

const validateFinancialSubmission = (
  snapshot: ApplicationSnapshot,
  issues: ValidationIssue[],
) => {
  const { financial } = snapshot
  if (financial.totalProjectCostPaise === null || financial.totalProjectCostPaise <= 0) {
    issues.push(issue('FINANCIAL', 'totalProjectCostPaise', 'MUST_BE_POSITIVE', 'Total project cost must be positive.'))
  }
  if (financial.seedFundRequestedPaise === null || financial.seedFundRequestedPaise <= 0) {
    issues.push(issue('FINANCIAL', 'seedFundRequestedPaise', 'MUST_BE_POSITIVE', 'Requested seed fund must be positive.'))
  }
  requireValue(issues, 'FINANCIAL', 'bankLoanProposedPaise', financial.bankLoanProposedPaise)
  requireValue(issues, 'FINANCIAL', 'promoterContributionPaise', financial.promoterContributionPaise)
}

const hasGovernmentDetails = (snapshot: ApplicationSnapshot): boolean => {
  const value = snapshot.priorFunding
  return value.governmentSchemeName !== null ||
    value.governmentFundingAmountPaise !== null ||
    value.governmentFundingSanctionYear !== null
}

const hasCreditDetails = (snapshot: ApplicationSnapshot): boolean => {
  const value = snapshot.priorFunding
  return value.existingBankName !== null ||
    value.existingCreditAmountPaise !== null ||
    value.existingCreditStatus !== null
}

const validatePriorFundingSubmission = (
  snapshot: ApplicationSnapshot,
  issues: ValidationIssue[],
) => {
  const { priorFunding } = snapshot
  requireValue(issues, 'PRIOR_FUNDING', 'receivedGovernmentFunding', priorFunding.receivedGovernmentFunding)
  if (priorFunding.receivedGovernmentFunding === true) {
    requireValue(issues, 'PRIOR_FUNDING', 'governmentSchemeName', priorFunding.governmentSchemeName)
    if ((priorFunding.governmentFundingAmountPaise ?? 0) <= 0) {
      requireValue(issues, 'PRIOR_FUNDING', 'governmentFundingAmountPaise', null)
    }
    requireValue(issues, 'PRIOR_FUNDING', 'governmentFundingSanctionYear', priorFunding.governmentFundingSanctionYear)
  } else if (priorFunding.receivedGovernmentFunding === false && hasGovernmentDetails(snapshot)) {
    issues.push(issue('PRIOR_FUNDING', 'receivedGovernmentFunding', 'CONDITIONAL_FIELDS', 'Clear government-funding details when the answer is no.'))
  }

  requireValue(issues, 'PRIOR_FUNDING', 'hasExistingBankCredit', priorFunding.hasExistingBankCredit)
  if (priorFunding.hasExistingBankCredit === true) {
    requireValue(issues, 'PRIOR_FUNDING', 'existingBankName', priorFunding.existingBankName)
    if ((priorFunding.existingCreditAmountPaise ?? 0) <= 0) {
      requireValue(issues, 'PRIOR_FUNDING', 'existingCreditAmountPaise', null)
    }
    requireValue(issues, 'PRIOR_FUNDING', 'existingCreditStatus', priorFunding.existingCreditStatus)
  } else if (priorFunding.hasExistingBankCredit === false && hasCreditDetails(snapshot)) {
    issues.push(issue('PRIOR_FUNDING', 'hasExistingBankCredit', 'CONDITIONAL_FIELDS', 'Clear bank-credit details when the answer is no.'))
  }
}

/**
 * Derives evidence slots from the frozen form values. Both the friendly
 * validator and the atomic submission predicate use this exact function so a
 * concurrent document mutation cannot exploit rule drift between layers.
 */
export const requiredDocumentTypesForSnapshot = (
  snapshot: Pick<ApplicationDraftInput, 'enterprise' | 'documents'>,
): DocumentType[] => {
  const requiredDocuments: DocumentType[] = [
    'IDENTITY_AGE_PROOF',
    'ST_CERTIFICATE',
    'ADDRESS_PROOF',
    'DPR',
    'BANK_DETAILS',
  ]
  if (snapshot.enterprise.registrationType !== null && snapshot.enterprise.registrationType !== 'NONE') {
    requiredDocuments.push('BUSINESS_REGISTRATION')
  }
  if (snapshot.enterprise.gstin !== null) requiredDocuments.push('GST_REGISTRATION')
  if (snapshot.documents.nocRequired === true) requiredDocuments.push('NOC')
  return requiredDocuments
}

const validateDocumentSubmission = (
  snapshot: ApplicationSnapshot,
  activeDocumentTypes: ReadonlySet<DocumentType>,
  issues: ValidationIssue[],
) => {
  requireValue(issues, 'DOCUMENTS', 'nocRequired', snapshot.documents.nocRequired)
  const requiredDocuments = requiredDocumentTypesForSnapshot(snapshot)
  for (const documentType of requiredDocuments) {
    if (!activeDocumentTypes.has(documentType)) {
      issues.push(issue('DOCUMENTS', documentType, 'DOCUMENT_REQUIRED', `Upload ${documentType.replaceAll('_', ' ').toLowerCase()}.`))
    }
  }
}

const validateDeclarationSubmission = (
  snapshot: ApplicationSnapshot,
  issues: ValidationIssue[],
) => {
  for (const [field, value] of [
    ['relationshipType', snapshot.declaration.relationshipType],
    ['relatedPersonName', snapshot.declaration.relatedPersonName],
    ['declarationPlace', snapshot.declaration.declarationPlace],
  ] as const) requireValue(issues, 'DECLARATION', field, value)
  if (snapshot.declaration.declarationAccepted !== true) {
    issues.push(issue('DECLARATION', 'declarationAccepted', 'MUST_ACCEPT', 'Accept the declaration before submission.'))
  }
}

/** Validates one normalized snapshot for formal submission. */
export const validateSubmissionSnapshot = (
  snapshot: ApplicationSnapshot,
  activeDocumentTypes: ReadonlySet<DocumentType>,
  now: Date,
): ValidationReport => {
  const issues = validateOptionalFormats(snapshot)
  validateEnterpriseSubmission(snapshot, issues, now)
  validateApplicantSubmission(snapshot, issues, now)
  validateFinancialSubmission(snapshot, issues)
  validatePriorFundingSubmission(snapshot, issues)
  validateDocumentSubmission(snapshot, activeDocumentTypes, issues)
  validateDeclarationSubmission(snapshot, issues)
  return { valid: issues.length === 0, issues }
}
