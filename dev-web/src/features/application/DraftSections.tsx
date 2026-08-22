/**
 * The six sections of the application form.
 *
 * Each section is memoised on its own slice of the draft, so typing in one
 * bounds the re-render to that section — at most nine fields — rather than the
 * whole form. That is the single largest rendering cost in this product, and it
 * is why the sections take `value`/`onChange` for their slice instead of
 * reading a shared object.
 *
 * Which sections accept input is decided entirely by `editableSections`, which
 * the API derives from the same rule its draft-save path enforces. A locked
 * section still shows its answers; it just cannot be changed.
 */
import { memo } from 'react'
import type { ApplicationDraftInput } from '#/graphql/generated/operations'
import type {
  ApplicantDesignation,
  ApplicationCategory,
  BusinessSector,
  CreditStatus,
  Gender,
  RegistrationType,
  RelationshipType,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import { paiseToRupees, rupeesToPaise } from './draft'

const REGISTRATION_TYPES: RegistrationType[] = ['NONE', 'CIN', 'UDYAM']
const CATEGORIES: ApplicationCategory[] = ['CATEGORY_A', 'CATEGORY_B']
const DESIGNATIONS: ApplicantDesignation[] = [
  'PROPRIETOR',
  'MANAGING_PARTNER',
  'DIRECTOR',
  'AUTHORIZED_SIGNATORY',
]
const GENDERS: Gender[] = ['MALE', 'FEMALE', 'OTHER']
const CREDIT_STATUSES: CreditStatus[] = ['STANDARD', 'NPA']
const RELATIONSHIPS: RelationshipType[] = ['SON_OF', 'DAUGHTER_OF', 'WIFE_OF']
const SECTORS: BusinessSector[] = [
  'AGRICULTURE_AND_ALLIED',
  'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  'FOOD_PROCESSING',
  'TOURISM_AND_HOSPITALITY',
  'INFORMATION_TECHNOLOGY',
  'MANUFACTURING_AND_SERVICES',
  'OTHER',
]

const orNull = (value: string): string | null => (value.trim() === '' ? null : value)

/** One labelled control, with the API's own message for the field beneath it. */
function Field({
  id,
  label,
  hint,
  issue,
  children,
}: {
  id: string
  label: string
  hint?: string
  issue?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {issue ? (
        <span className="field-error" id={`${id}-error`}>
          {issue}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  )
}

export type SectionIssues = Record<string, string>

type SectionProps<TSlice> = {
  value: TSlice
  issues: SectionIssues
  disabled: boolean
  onChange: (value: TSlice) => void
}

/** Marks a control invalid so the browser and assistive technology agree. */
const invalid = (issues: SectionIssues, field: string) =>
  issues[field]
    ? ({ 'aria-invalid': true, 'aria-describedby': `${field}-error` } as const)
    : {}

export const EnterpriseSection = memo(function EnterpriseSection({
  value,
  issues,
  disabled,
  onChange,
}: SectionProps<ApplicationDraftInput['enterprise']>) {
  const set = <TKey extends keyof ApplicationDraftInput['enterprise']>(
    key: TKey,
    next: ApplicationDraftInput['enterprise'][TKey],
  ) => onChange({ ...value, [key]: next })

  return (
    <div className="detail-grid">
      <Field id="businessName" label="Business name" issue={issues.businessName}>
        <input
          id="businessName"
          className="input"
          disabled={disabled}
          value={value.businessName ?? ''}
          onChange={(event) => set('businessName', orNull(event.target.value))}
          {...invalid(issues, 'businessName')}
        />
      </Field>

      <Field id="establishmentDate" label="Date established" issue={issues.establishmentDate}>
        <input
          id="establishmentDate"
          className="input"
          type="date"
          disabled={disabled}
          value={value.establishmentDate ?? ''}
          onChange={(event) => set('establishmentDate', orNull(event.target.value))}
          {...invalid(issues, 'establishmentDate')}
        />
      </Field>

      <Field id="applicationCategory" label="Category" issue={issues.applicationCategory}>
        <select
          id="applicationCategory"
          className="select"
          disabled={disabled}
          value={value.applicationCategory ?? ''}
          onChange={(event) =>
            set('applicationCategory', (orNull(event.target.value) as ApplicationCategory | null))
          }
          {...invalid(issues, 'applicationCategory')}
        >
          <option value="">Not stated</option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {humanize(category)}
            </option>
          ))}
        </select>
      </Field>

      <Field id="registrationType" label="Registration" issue={issues.registrationType}>
        <select
          id="registrationType"
          className="select"
          disabled={disabled}
          value={value.registrationType ?? 'NONE'}
          onChange={(event) => {
            const next = event.target.value as RegistrationType
            // An unregistered enterprise must not carry a number.
            onChange({
              ...value,
              registrationType: next,
              registrationNumber: next === 'NONE' ? null : value.registrationNumber,
            })
          }}
        >
          {REGISTRATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {type === 'NONE' ? 'Not registered' : type}
            </option>
          ))}
        </select>
      </Field>

      {value.registrationType && value.registrationType !== 'NONE' ? (
        <Field
          id="registrationNumber"
          label={`${value.registrationType} number`}
          issue={issues.registrationNumber}
        >
          <input
            id="registrationNumber"
            className="input"
            disabled={disabled}
            value={value.registrationNumber ?? ''}
            onChange={(event) => set('registrationNumber', orNull(event.target.value))}
            {...invalid(issues, 'registrationNumber')}
          />
        </Field>
      ) : null}

      <Field id="gstin" label="GSTIN" issue={issues.gstin}>
        <input
          id="gstin"
          className="input"
          disabled={disabled}
          value={value.gstin ?? ''}
          onChange={(event) => set('gstin', orNull(event.target.value))}
          {...invalid(issues, 'gstin')}
        />
      </Field>

      <Field id="businessSector" label="Sector" issue={issues.businessSector}>
        <select
          id="businessSector"
          className="select"
          disabled={disabled}
          value={value.businessSector ?? ''}
          onChange={(event) => {
            const next = orNull(event.target.value) as BusinessSector | null
            onChange({
              ...value,
              businessSector: next,
              otherBusinessSector: next === 'OTHER' ? value.otherBusinessSector : null,
            })
          }}
          {...invalid(issues, 'businessSector')}
        >
          <option value="">Not stated</option>
          {SECTORS.map((sector) => (
            <option key={sector} value={sector}>
              {humanize(sector)}
            </option>
          ))}
        </select>
      </Field>

      {value.businessSector === 'OTHER' ? (
        <Field
          id="otherBusinessSector"
          label="Describe the sector"
          issue={issues.otherBusinessSector}
        >
          <input
            id="otherBusinessSector"
            className="input"
            disabled={disabled}
            value={value.otherBusinessSector ?? ''}
            onChange={(event) => set('otherBusinessSector', orNull(event.target.value))}
            {...invalid(issues, 'otherBusinessSector')}
          />
        </Field>
      ) : null}

      <div className="checkbox-row" style={{ alignSelf: 'end' }}>
        <input
          id="majorityOwnershipConfirmed"
          type="checkbox"
          disabled={disabled}
          checked={value.majorityOwnershipConfirmed ?? false}
          onChange={(event) => set('majorityOwnershipConfirmed', event.target.checked)}
        />
        <label htmlFor="majorityOwnershipConfirmed">
          Majority ownership is held by Scheduled Tribe members
        </label>
      </div>
    </div>
  )
})

export const ApplicantSection = memo(function ApplicantSection({
  value,
  issues,
  disabled,
  onChange,
}: SectionProps<ApplicationDraftInput['applicantProfile']>) {
  const set = <TKey extends keyof ApplicationDraftInput['applicantProfile']>(
    key: TKey,
    next: ApplicationDraftInput['applicantProfile'][TKey],
  ) => onChange({ ...value, [key]: next })

  return (
    <div className="detail-grid">
      <Field id="primaryApplicantName" label="Your full name" issue={issues.primaryApplicantName}>
        <input
          id="primaryApplicantName"
          className="input"
          disabled={disabled}
          value={value.primaryApplicantName ?? ''}
          onChange={(event) => set('primaryApplicantName', orNull(event.target.value))}
          {...invalid(issues, 'primaryApplicantName')}
        />
      </Field>

      <Field id="designation" label="Your role in the enterprise" issue={issues.designation}>
        <select
          id="designation"
          className="select"
          disabled={disabled}
          value={value.designation ?? ''}
          onChange={(event) =>
            set('designation', orNull(event.target.value) as ApplicantDesignation | null)
          }
          {...invalid(issues, 'designation')}
        >
          <option value="">Not stated</option>
          {DESIGNATIONS.map((designation) => (
            <option key={designation} value={designation}>
              {humanize(designation)}
            </option>
          ))}
        </select>
      </Field>

      <Field id="dateOfBirth" label="Date of birth" issue={issues.dateOfBirth}>
        <input
          id="dateOfBirth"
          className="input"
          type="date"
          disabled={disabled}
          value={value.dateOfBirth ?? ''}
          onChange={(event) => set('dateOfBirth', orNull(event.target.value))}
          {...invalid(issues, 'dateOfBirth')}
        />
      </Field>

      <Field id="gender" label="Gender" issue={issues.gender}>
        <select
          id="gender"
          className="select"
          disabled={disabled}
          value={value.gender ?? ''}
          onChange={(event) => set('gender', orNull(event.target.value) as Gender | null)}
          {...invalid(issues, 'gender')}
        >
          <option value="">Not stated</option>
          {GENDERS.map((gender) => (
            <option key={gender} value={gender}>
              {humanize(gender)}
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="businessBlockOrVillage"
        label="Block or village"
        issue={issues.businessBlockOrVillage}
      >
        <input
          id="businessBlockOrVillage"
          className="input"
          disabled={disabled}
          value={value.businessBlockOrVillage ?? ''}
          onChange={(event) => set('businessBlockOrVillage', orNull(event.target.value))}
          {...invalid(issues, 'businessBlockOrVillage')}
        />
      </Field>

      <Field id="businessDistrict" label="District" issue={issues.businessDistrict}>
        <input
          id="businessDistrict"
          className="input"
          disabled={disabled}
          value={value.businessDistrict ?? ''}
          onChange={(event) => set('businessDistrict', orNull(event.target.value))}
          {...invalid(issues, 'businessDistrict')}
        />
      </Field>

      <Field id="businessPinCode" label="PIN code" issue={issues.businessPinCode}>
        <input
          id="businessPinCode"
          className="input tabular"
          inputMode="numeric"
          maxLength={6}
          disabled={disabled}
          value={value.businessPinCode ?? ''}
          onChange={(event) => set('businessPinCode', orNull(event.target.value))}
          {...invalid(issues, 'businessPinCode')}
        />
      </Field>

      <Field id="contactNumber" label="Contact number" issue={issues.contactNumber}>
        <input
          id="contactNumber"
          className="input"
          type="tel"
          disabled={disabled}
          value={value.contactNumber ?? ''}
          onChange={(event) => set('contactNumber', orNull(event.target.value))}
          {...invalid(issues, 'contactNumber')}
        />
      </Field>

      <Field id="contactEmail" label="Contact email" issue={issues.contactEmail}>
        <input
          id="contactEmail"
          className="input"
          type="email"
          disabled={disabled}
          value={value.contactEmail ?? ''}
          onChange={(event) => set('contactEmail', orNull(event.target.value))}
          {...invalid(issues, 'contactEmail')}
        />
      </Field>
    </div>
  )
})

export const FinancialSection = memo(function FinancialSection({
  value,
  issues,
  disabled,
  onChange,
}: SectionProps<ApplicationDraftInput['financial']>) {
  const set = <TKey extends keyof ApplicationDraftInput['financial']>(
    key: TKey,
    next: ApplicationDraftInput['financial'][TKey],
  ) => onChange({ ...value, [key]: next })

  /** Every amount is entered in rupees and sent in paise. */
  const money = (
    id: keyof ApplicationDraftInput['financial'],
    label: string,
    hint?: string,
  ) => (
    <Field id={id} label={label} hint={hint} issue={issues[id]}>
      <input
        id={id}
        className="input tabular"
        type="number"
        min={0}
        step="0.01"
        disabled={disabled}
        value={paiseToRupees(value[id])}
        onChange={(event) => set(id, rupeesToPaise(event.target.value))}
        {...invalid(issues, id)}
      />
    </Field>
  )

  return (
    <div className="detail-grid">
      {money('totalProjectCostPaise', 'Total project cost (₹)')}
      {money('seedFundRequestedPaise', 'Seed fund requested (₹)')}
      {money('bankLoanProposedPaise', 'Bank loan proposed (₹)')}
      {money(
        'promoterContributionPaise',
        'Your own contribution (₹)',
        'The three amounts together must equal the total project cost.',
      )}
    </div>
  )
})

export const PriorFundingSection = memo(function PriorFundingSection({
  value,
  issues,
  disabled,
  onChange,
}: SectionProps<ApplicationDraftInput['priorFunding']>) {
  const set = <TKey extends keyof ApplicationDraftInput['priorFunding']>(
    key: TKey,
    next: ApplicationDraftInput['priorFunding'][TKey],
  ) => onChange({ ...value, [key]: next })

  return (
    <div className="stack">
      <div className="checkbox-row">
        <input
          id="receivedGovernmentFunding"
          type="checkbox"
          disabled={disabled}
          checked={value.receivedGovernmentFunding ?? false}
          onChange={(event) =>
            // Clearing the details when the answer turns to "no" keeps the
            // draft consistent instead of carrying orphaned values.
            onChange(
              event.target.checked
                ? { ...value, receivedGovernmentFunding: true }
                : {
                    ...value,
                    receivedGovernmentFunding: false,
                    governmentSchemeName: null,
                    governmentFundingAmountPaise: null,
                    governmentFundingSanctionYear: null,
                  },
            )
          }
        />
        <label htmlFor="receivedGovernmentFunding">
          This enterprise has received government funding before
        </label>
      </div>

      {value.receivedGovernmentFunding ? (
        <div className="detail-grid">
          <Field id="governmentSchemeName" label="Scheme" issue={issues.governmentSchemeName}>
            <input
              id="governmentSchemeName"
              className="input"
              disabled={disabled}
              value={value.governmentSchemeName ?? ''}
              onChange={(event) => set('governmentSchemeName', orNull(event.target.value))}
              {...invalid(issues, 'governmentSchemeName')}
            />
          </Field>
          <Field
            id="governmentFundingAmountPaise"
            label="Amount received (₹)"
            issue={issues.governmentFundingAmountPaise}
          >
            <input
              id="governmentFundingAmountPaise"
              className="input tabular"
              type="number"
              min={0}
              step="0.01"
              disabled={disabled}
              value={paiseToRupees(value.governmentFundingAmountPaise)}
              onChange={(event) =>
                set('governmentFundingAmountPaise', rupeesToPaise(event.target.value))
              }
              {...invalid(issues, 'governmentFundingAmountPaise')}
            />
          </Field>
          <Field
            id="governmentFundingSanctionYear"
            label="Year sanctioned"
            issue={issues.governmentFundingSanctionYear}
          >
            <input
              id="governmentFundingSanctionYear"
              className="input tabular"
              type="number"
              disabled={disabled}
              value={value.governmentFundingSanctionYear ?? ''}
              onChange={(event) =>
                set(
                  'governmentFundingSanctionYear',
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              {...invalid(issues, 'governmentFundingSanctionYear')}
            />
          </Field>
        </div>
      ) : null}

      <div className="checkbox-row">
        <input
          id="hasExistingBankCredit"
          type="checkbox"
          disabled={disabled}
          checked={value.hasExistingBankCredit ?? false}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { ...value, hasExistingBankCredit: true }
                : {
                    ...value,
                    hasExistingBankCredit: false,
                    existingBankName: null,
                    existingCreditAmountPaise: null,
                    existingCreditStatus: null,
                  },
            )
          }
        />
        <label htmlFor="hasExistingBankCredit">
          This enterprise has existing bank credit
        </label>
      </div>

      {value.hasExistingBankCredit ? (
        <div className="detail-grid">
          <Field id="existingBankName" label="Bank" issue={issues.existingBankName}>
            <input
              id="existingBankName"
              className="input"
              disabled={disabled}
              value={value.existingBankName ?? ''}
              onChange={(event) => set('existingBankName', orNull(event.target.value))}
              {...invalid(issues, 'existingBankName')}
            />
          </Field>
          <Field
            id="existingCreditAmountPaise"
            label="Amount outstanding (₹)"
            issue={issues.existingCreditAmountPaise}
          >
            <input
              id="existingCreditAmountPaise"
              className="input tabular"
              type="number"
              min={0}
              step="0.01"
              disabled={disabled}
              value={paiseToRupees(value.existingCreditAmountPaise)}
              onChange={(event) =>
                set('existingCreditAmountPaise', rupeesToPaise(event.target.value))
              }
              {...invalid(issues, 'existingCreditAmountPaise')}
            />
          </Field>
          <Field id="existingCreditStatus" label="Account status" issue={issues.existingCreditStatus}>
            <select
              id="existingCreditStatus"
              className="select"
              disabled={disabled}
              value={value.existingCreditStatus ?? ''}
              onChange={(event) =>
                set('existingCreditStatus', orNull(event.target.value) as CreditStatus | null)
              }
              {...invalid(issues, 'existingCreditStatus')}
            >
              <option value="">Not stated</option>
              {CREDIT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status === 'NPA' ? 'Non-performing (NPA)' : 'Standard'}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
    </div>
  )
})

export const DocumentsSection = memo(function DocumentsSection({
  value,
  disabled,
  onChange,
}: SectionProps<ApplicationDraftInput['documents']>) {
  return (
    <div className="stack">
      <div className="checkbox-row">
        <input
          id="nocRequired"
          type="checkbox"
          disabled={disabled}
          checked={value.nocRequired ?? false}
          onChange={(event) => onChange({ ...value, nocRequired: event.target.checked })}
        />
        <label htmlFor="nocRequired">
          A no-objection certificate is needed for these premises
        </label>
      </div>
      <p className="field-hint">
        This decides whether a NOC is required evidence. The files themselves are
        attached on the evidence screen.
      </p>
    </div>
  )
})

export const DeclarationSection = memo(function DeclarationSection({
  value,
  issues,
  disabled,
  onChange,
}: SectionProps<ApplicationDraftInput['declaration']>) {
  const set = <TKey extends keyof ApplicationDraftInput['declaration']>(
    key: TKey,
    next: ApplicationDraftInput['declaration'][TKey],
  ) => onChange({ ...value, [key]: next })

  return (
    <div className="stack">
      <div className="detail-grid">
        <Field id="relationshipType" label="Relationship" issue={issues.relationshipType}>
          <select
            id="relationshipType"
            className="select"
            disabled={disabled}
            value={value.relationshipType ?? ''}
            onChange={(event) =>
              set('relationshipType', orNull(event.target.value) as RelationshipType | null)
            }
            {...invalid(issues, 'relationshipType')}
          >
            <option value="">Not stated</option>
            {RELATIONSHIPS.map((relationship) => (
              <option key={relationship} value={relationship}>
                {humanize(relationship)}
              </option>
            ))}
          </select>
        </Field>

        <Field id="relatedPersonName" label="Of (name)" issue={issues.relatedPersonName}>
          <input
            id="relatedPersonName"
            className="input"
            disabled={disabled}
            value={value.relatedPersonName ?? ''}
            onChange={(event) => set('relatedPersonName', orNull(event.target.value))}
            {...invalid(issues, 'relatedPersonName')}
          />
        </Field>

        <Field id="declarationPlace" label="Place" issue={issues.declarationPlace}>
          <input
            id="declarationPlace"
            className="input"
            disabled={disabled}
            value={value.declarationPlace ?? ''}
            onChange={(event) => set('declarationPlace', orNull(event.target.value))}
            {...invalid(issues, 'declarationPlace')}
          />
        </Field>
      </div>

      <div className="checkbox-row">
        <input
          id="declarationAccepted"
          type="checkbox"
          disabled={disabled}
          checked={value.declarationAccepted ?? false}
          onChange={(event) => set('declarationAccepted', event.target.checked)}
        />
        <label htmlFor="declarationAccepted">
          I declare that everything in this application is true and complete.
        </label>
      </div>
    </div>
  )
})
