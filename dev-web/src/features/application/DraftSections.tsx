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
import { Explain } from '#/features/guide/Explain'
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
import { formatMoney, humanize } from '#/lib/format'
import { FIELD_LABELS, paiseToRupees, rupeesToPaise } from './draft'

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
  explain,
  children,
}: {
  id: string
  label: string
  hint?: string
  issue?: string
  /** Why this question is asked, for the few where the name does not say. */
  explain?: string
  children: React.ReactNode
}) {
  return (
    <div>
      {/*
        The explanation sits beside the label, not inside it. A control inside a
        <label> becomes part of the field's accessible name — the select would
        have announced as "Category ?".
      */}
      {explain ? (
        <span className="field-label-row">
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          <Explain label={label}>{explain}</Explain>
        </span>
      ) : (
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
      )}
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

/**
 * A required yes/no question.
 *
 * Deliberately not a checkbox. A checkbox has two states and this question has
 * three: yes, no, and not answered yet — and the API tells them apart, treating
 * an unanswered question as a validation issue while "no" is a complete answer.
 * An unticked box looks answered and is not, which is how somebody reaches the
 * submit screen and is told a question they never saw is missing.
 */
function YesNoField({
  name,
  question,
  hint,
  issue,
  value,
  disabled,
  onAnswer,
}: {
  name: string
  question: string
  hint?: string
  issue?: string
  value: boolean | null | undefined
  disabled: boolean
  onAnswer: (answer: boolean) => void
}) {
  return (
    <fieldset className="choice-field" disabled={disabled}>
      <legend className="field-label">{question}</legend>
      <div className="choice-row">
        {ANSWERS.map((answer) => (
          <label className="choice" key={answer.label}>
            <input
              type="radio"
              name={name}
              checked={value === answer.value}
              onChange={() => onAnswer(answer.value)}
              {...(issue ? { 'aria-describedby': `${name}-error` } : {})}
            />
            {answer.label}
          </label>
        ))}
      </div>
      {issue ? (
        <span className="field-error" id={`${name}-error`}>
          {issue}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </fieldset>
  )
}

/**
 * A single statement the applicant confirms.
 *
 * Unlike a yes/no question there is only one acceptable answer, so a checkbox
 * is the honest control: the API's rule is "must be confirmed", not "must be
 * answered". The refusal to confirm is expressed by leaving it unticked, and
 * the API's own message says what that costs.
 */
function Attestation({
  id,
  statement,
  issue,
  checked,
  disabled,
  onChange,
}: {
  id: string
  statement: string
  issue?: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div>
      <div className="checkbox-row">
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          {...(issue ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {})}
        />
        <label htmlFor={id}>{statement}</label>
      </div>
      {issue ? (
        <span className="field-error" id={`${id}-error`}>
          {issue}
        </span>
      ) : null}
    </div>
  )
}

const ANSWERS = [
  { label: 'Yes', value: true },
  { label: 'No', value: false },
] as const

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
    <div className="stack">
      <div className="detail-grid">
        <Field
          id="businessName"
          label={FIELD_LABELS.businessName}
          issue={issues.businessName}
        >
          <input
            id="businessName"
            className="input"
            disabled={disabled}
            value={value.businessName ?? ''}
            onChange={(event) => set('businessName', orNull(event.target.value))}
            {...invalid(issues, 'businessName')}
          />
        </Field>

        <Field
          id="establishmentDate"
          label={FIELD_LABELS.establishmentDate}
          issue={issues.establishmentDate}
        >
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

        <Field
          id="applicationCategory"
          label={FIELD_LABELS.applicationCategory}
          issue={issues.applicationCategory}
          explain="Category decides how much seed funding this enterprise may ask for and how long it must have been trading. The programme cycle sets both, and the desk review checks the enterprise against them."
        >
          <select
            id="applicationCategory"
            className="select"
            disabled={disabled}
            value={value.applicationCategory ?? ''}
            onChange={(event) =>
              set(
                'applicationCategory',
                orNull(event.target.value) as ApplicationCategory | null,
              )
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

        <Field
          id="registrationType"
          label={FIELD_LABELS.registrationType}
          issue={issues.registrationType}
        >
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

        <Field id="gstin" label={FIELD_LABELS.gstin} issue={issues.gstin}>
          <input
            id="gstin"
            className="input"
            disabled={disabled}
            value={value.gstin ?? ''}
            onChange={(event) => set('gstin', orNull(event.target.value))}
            {...invalid(issues, 'gstin')}
          />
        </Field>

        <Field
          id="businessSector"
          label={FIELD_LABELS.businessSector}
          issue={issues.businessSector}
        >
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
            label={FIELD_LABELS.otherBusinessSector}
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
      </div>

      <Attestation
        id="majorityOwnershipConfirmed"
        statement={FIELD_LABELS.majorityOwnershipConfirmed}
        issue={issues.majorityOwnershipConfirmed}
        checked={value.majorityOwnershipConfirmed ?? false}
        disabled={disabled}
        onChange={(checked) => set('majorityOwnershipConfirmed', checked)}
      />
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
      <Field
        id="primaryApplicantName"
        label={FIELD_LABELS.primaryApplicantName}
        issue={issues.primaryApplicantName}
      >
        <input
          id="primaryApplicantName"
          className="input"
          disabled={disabled}
          value={value.primaryApplicantName ?? ''}
          onChange={(event) => set('primaryApplicantName', orNull(event.target.value))}
          {...invalid(issues, 'primaryApplicantName')}
        />
      </Field>

      <Field id="designation" label={FIELD_LABELS.designation} issue={issues.designation}>
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

      <Field id="dateOfBirth" label={FIELD_LABELS.dateOfBirth} issue={issues.dateOfBirth}>
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

      <Field id="gender" label={FIELD_LABELS.gender} issue={issues.gender}>
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
        label={FIELD_LABELS.businessBlockOrVillage}
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

      <Field
        id="businessDistrict"
        label={FIELD_LABELS.businessDistrict}
        issue={issues.businessDistrict}
      >
        <input
          id="businessDistrict"
          className="input"
          disabled={disabled}
          value={value.businessDistrict ?? ''}
          onChange={(event) => set('businessDistrict', orNull(event.target.value))}
          {...invalid(issues, 'businessDistrict')}
        />
      </Field>

      <Field
        id="businessPinCode"
        label={FIELD_LABELS.businessPinCode}
        issue={issues.businessPinCode}
      >
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

      <Field
        id="contactNumber"
        label={FIELD_LABELS.contactNumber}
        issue={issues.contactNumber}
      >
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

      <Field
        id="contactEmail"
        label={FIELD_LABELS.contactEmail}
        issue={issues.contactEmail}
      >
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

  /**
   * Every amount is entered in rupees and sent in paise.
   *
   * The typed value is read back beneath the field in Indian grouping, because
   * a bare "1000000" in a number input is genuinely hard to check and these are
   * the figures the whole application turns on.
   */
  const money = (id: keyof ApplicationDraftInput['financial'], label: string) => (
    <Field
      id={id}
      label={label}
      hint={value[id] ? formatMoney(value[id]) : undefined}
      issue={issues[id]}
    >
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

  /*
   * The API requires the three parts to add up to the total exactly. Doing the
   * arithmetic here — in paise, so there is nothing to round — lets the form say
   * where the applicant is rather than restating the rule and leaving them to
   * check it. It is a reading of what has been typed, not a second validation:
   * the server still decides.
   */
  const parts =
    Number(value.seedFundRequestedPaise ?? 0) +
    Number(value.bankLoanProposedPaise ?? 0) +
    Number(value.promoterContributionPaise ?? 0)
  const total = Number(value.totalProjectCostPaise ?? 0)
  const difference = total - parts

  return (
    <div className="stack">
      <div className="detail-grid">
        {money('totalProjectCostPaise', FIELD_LABELS.totalProjectCostPaise)}
        {money('seedFundRequestedPaise', FIELD_LABELS.seedFundRequestedPaise)}
        {money('bankLoanProposedPaise', FIELD_LABELS.bankLoanProposedPaise)}
        {money('promoterContributionPaise', FIELD_LABELS.promoterContributionPaise)}
      </div>

      {total > 0 || parts > 0 ? (
        <p className="field-hint">
          {difference === 0
            ? `Seed fund, bank loan and your own contribution come to ${formatMoney(String(parts))}, matching the total project cost.`
            : difference > 0
              ? `Seed fund, bank loan and your own contribution come to ${formatMoney(String(parts))}. That is ${formatMoney(String(difference))} short of the total project cost.`
              : `Seed fund, bank loan and your own contribution come to ${formatMoney(String(parts))}. That is ${formatMoney(String(-difference))} more than the total project cost.`}
        </p>
      ) : (
        <p className="field-hint">
          Seed fund, bank loan and your own contribution must add up to the total project
          cost.
        </p>
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
      <YesNoField
        name="receivedGovernmentFunding"
        question={FIELD_LABELS.receivedGovernmentFunding}
        issue={issues.receivedGovernmentFunding}
        value={value.receivedGovernmentFunding}
        disabled={disabled}
        onAnswer={(answer) =>
          // Clearing the details when the answer turns to "no" keeps the draft
          // consistent instead of carrying orphaned values.
          onChange(
            answer
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

      {value.receivedGovernmentFunding ? (
        <div className="detail-grid">
          <Field
            id="governmentSchemeName"
            label={FIELD_LABELS.governmentSchemeName}
            issue={issues.governmentSchemeName}
          >
            <input
              id="governmentSchemeName"
              className="input"
              disabled={disabled}
              value={value.governmentSchemeName ?? ''}
              onChange={(event) =>
                set('governmentSchemeName', orNull(event.target.value))
              }
              {...invalid(issues, 'governmentSchemeName')}
            />
          </Field>
          <Field
            id="governmentFundingAmountPaise"
            label={FIELD_LABELS.governmentFundingAmountPaise}
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
            label={FIELD_LABELS.governmentFundingSanctionYear}
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

      <YesNoField
        name="hasExistingBankCredit"
        question={FIELD_LABELS.hasExistingBankCredit}
        issue={issues.hasExistingBankCredit}
        value={value.hasExistingBankCredit}
        disabled={disabled}
        onAnswer={(answer) =>
          onChange(
            answer
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

      {value.hasExistingBankCredit ? (
        <div className="detail-grid">
          <Field
            id="existingBankName"
            label={FIELD_LABELS.existingBankName}
            issue={issues.existingBankName}
          >
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
            label={FIELD_LABELS.existingCreditAmountPaise}
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
          <Field
            id="existingCreditStatus"
            label={FIELD_LABELS.existingCreditStatus}
            issue={issues.existingCreditStatus}
          >
            <select
              id="existingCreditStatus"
              className="select"
              disabled={disabled}
              value={value.existingCreditStatus ?? ''}
              onChange={(event) =>
                set(
                  'existingCreditStatus',
                  orNull(event.target.value) as CreditStatus | null,
                )
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
  issues,
  disabled,
  onChange,
}: SectionProps<ApplicationDraftInput['documents']>) {
  return (
    <div className="stack">
      <YesNoField
        name="nocRequired"
        question={FIELD_LABELS.nocRequired}
        hint="This decides whether a NOC is required evidence. The files themselves are attached on the evidence screen."
        issue={issues.nocRequired}
        value={value.nocRequired}
        disabled={disabled}
        onAnswer={(answer) => onChange({ ...value, nocRequired: answer })}
      />
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
        <Field
          id="relationshipType"
          label={FIELD_LABELS.relationshipType}
          issue={issues.relationshipType}
        >
          <select
            id="relationshipType"
            className="select"
            disabled={disabled}
            value={value.relationshipType ?? ''}
            onChange={(event) =>
              set(
                'relationshipType',
                orNull(event.target.value) as RelationshipType | null,
              )
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

        <Field
          id="relatedPersonName"
          label={FIELD_LABELS.relatedPersonName}
          issue={issues.relatedPersonName}
        >
          <input
            id="relatedPersonName"
            className="input"
            disabled={disabled}
            value={value.relatedPersonName ?? ''}
            onChange={(event) => set('relatedPersonName', orNull(event.target.value))}
            {...invalid(issues, 'relatedPersonName')}
          />
        </Field>

        <Field
          id="declarationPlace"
          label={FIELD_LABELS.declarationPlace}
          issue={issues.declarationPlace}
        >
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

      <Attestation
        id="declarationAccepted"
        statement={FIELD_LABELS.declarationAccepted}
        issue={issues.declarationAccepted}
        checked={value.declarationAccepted ?? false}
        disabled={disabled}
        onChange={(checked) => set('declarationAccepted', checked)}
      />
    </div>
  )
})
