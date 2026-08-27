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
import {
  AlertTriangle,
  Award,
  Ban,
  Briefcase,
  Building,
  Building2,
  Calendar,
  CheckCircle2,
  Coins,
  Compass,
  FileCode,
  FileSignature,
  FileText,
  HelpCircle,
  IndianRupee,
  Landmark,
  Layers,
  Mail,
  Mailbox,
  MapPin,
  Phone,
  Receipt,
  ShieldCheck,
  User,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react'
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
import styles from './DraftSections.module.css'

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
  icon,
  required,
  hint,
  issue,
  explain,
  children,
}: {
  id: string
  label: string
  icon?: React.ReactNode
  required?: boolean
  hint?: string
  issue?: string
  /** Why this question is asked, for the few where the name does not say. */
  explain?: string
  children: React.ReactNode
}) {
  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldLabelRow}>
        <label className={styles.fieldLabel} htmlFor={id}>
          {icon ? <span className={styles.fieldIcon}>{icon}</span> : null}
          <span>{label}</span>
          {required ? <span className={styles.requiredAsterisk}>*</span> : null}
        </label>
        {explain ? <Explain label={label}>{explain}</Explain> : null}
      </div>
      {children}
      {issue ? (
        <span className={styles.fieldError} id={`${id}-error`}>
          <AlertTriangle size={13} aria-hidden="true" />
          {issue}
        </span>
      ) : hint ? (
        <span className={styles.fieldHint}>{hint}</span>
      ) : null}
    </div>
  )
}

/** Segmented radio card buttons for choice fields. */
function RadioCardsField<TValue extends string>({
  id,
  label,
  icon,
  required,
  issue,
  hint,
  explain,
  options,
  value,
  disabled,
  onChange,
}: {
  id: string
  label: string
  icon?: React.ReactNode
  required?: boolean
  issue?: string
  hint?: string
  explain?: string
  options: Array<{ label: string; value: TValue; icon?: React.ReactNode }>
  value: TValue | null | undefined
  disabled: boolean
  onChange: (value: TValue) => void
}) {
  return (
    <div className={styles.fieldGroup} id={id}>
      <div className={styles.fieldLabelRow}>
        <span className={styles.fieldLabel}>
          {icon ? <span className={styles.fieldIcon}>{icon}</span> : null}
          <span>{label}</span>
          {required ? <span className={styles.requiredAsterisk}>*</span> : null}
        </span>
        {explain ? <Explain label={label}>{explain}</Explain> : null}
      </div>
      <div className={styles.radioCardsRow}>
        {options.map((option) => {
          const selected = (value ?? '') === option.value
          return (
            <label
              key={option.value || 'empty'}
              className={`${styles.radioCard} ${selected ? styles.radioCardSelected : ''}`}
              data-disabled={disabled ? 'true' : undefined}
            >
              <input
                type="radio"
                name={id}
                value={option.value}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(option.value)}
                className="visually-hidden"
                {...(issue ? { 'aria-describedby': `${id}-error` } : {})}
              />
              <span
                className={`${styles.radioDot} ${selected ? styles.radioDotSelected : ''}`}
              >
                {selected ? <span className={styles.radioInnerDot} /> : null}
              </span>
              {option.icon ? (
                <span className={styles.radioOptionIcon}>{option.icon}</span>
              ) : null}
              <span className={styles.radioCardLabel}>{option.label}</span>
            </label>
          )
        })}
      </div>
      {issue ? (
        <span className={styles.fieldError} id={`${id}-error`}>
          <AlertTriangle size={13} aria-hidden="true" />
          {issue}
        </span>
      ) : hint ? (
        <span className={styles.fieldHint}>{hint}</span>
      ) : null}
    </div>
  )
}

/** A required yes/no question using segmented radio cards. */
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
    <fieldset
      className={styles.fieldGroup}
      id={name}
      tabIndex={-1}
      disabled={disabled}
      style={{ border: 0, padding: 0, margin: 0 }}
    >
      <legend className={styles.fieldLabel}>{question}</legend>
      <div className={styles.radioCardsRow}>
        {ANSWERS.map((answer) => {
          const selected = value === answer.value
          return (
            <label
              className={`${styles.radioCard} ${selected ? styles.radioCardSelected : ''}`}
              key={answer.label}
              data-disabled={disabled ? 'true' : undefined}
            >
              <input
                type="radio"
                name={name}
                checked={selected}
                disabled={disabled}
                onChange={() => onAnswer(answer.value)}
                className="visually-hidden"
                {...(issue ? { 'aria-describedby': `${name}-error` } : {})}
              />
              <span
                className={`${styles.radioDot} ${selected ? styles.radioDotSelected : ''}`}
              >
                {selected ? <span className={styles.radioInnerDot} /> : null}
              </span>
              <span className={styles.radioOptionIcon}>
                {answer.value ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              </span>
              <span className={styles.radioCardLabel}>{answer.label}</span>
            </label>
          )
        })}
      </div>
      {issue ? (
        <span className={styles.fieldError} id={`${name}-error`}>
          <AlertTriangle size={13} aria-hidden="true" />
          {issue}
        </span>
      ) : hint ? (
        <span className={styles.fieldHint}>{hint}</span>
      ) : null}
    </fieldset>
  )
}

/** A single statement the applicant confirms. */
function Attestation({
  id,
  statement,
  icon,
  issue,
  checked,
  disabled,
  onChange,
  highlight = false,
}: {
  id: string
  statement: string
  icon?: React.ReactNode
  issue?: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  highlight?: boolean
}) {
  return (
    <div
      className={
        highlight
          ? `${styles.attestationCard} ${checked ? styles.attestationCardChecked : ''}`
          : styles.attestationPlain
      }
    >
      <label className={styles.attestationLabel} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className={styles.checkboxInput}
          {...(issue ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {})}
        />
        {icon ? <span className={styles.attestationIcon}>{icon}</span> : null}
        <span className={styles.statementText}>{statement}</span>
      </label>
      {issue ? (
        <span className={styles.attestationError} id={`${id}-error`}>
          <AlertTriangle size={13} aria-hidden="true" />
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
    <div className={styles.sectionStack}>
      <div className={styles.fieldGrid}>
        <Field
          id="businessName"
          label={FIELD_LABELS.businessName}
          icon={<Building2 size={15} />}
          issue={issues.businessName}
        >
          <input
            id="businessName"
            className={styles.input}
            placeholder="Enter business name"
            disabled={disabled}
            value={value.businessName ?? ''}
            onChange={(event) => set('businessName', orNull(event.target.value))}
            {...invalid(issues, 'businessName')}
          />
        </Field>

        <Field
          id="establishmentDate"
          label={FIELD_LABELS.establishmentDate}
          icon={<Calendar size={15} />}
          issue={issues.establishmentDate}
        >
          <input
            id="establishmentDate"
            className={styles.input}
            type="date"
            placeholder="Select date"
            disabled={disabled}
            value={value.establishmentDate ?? ''}
            onChange={(event) => set('establishmentDate', orNull(event.target.value))}
            {...invalid(issues, 'establishmentDate')}
          />
        </Field>

        <RadioCardsField
          id="applicationCategory"
          label="Category?"
          icon={<Award size={15} />}
          required
          issue={issues.applicationCategory}
          explain="Category decides how much seed funding this enterprise may ask for and how long it must have been trading. The programme cycle sets both, and the desk review checks the enterprise against them."
          options={[
            { label: 'Not stated', value: '', icon: <HelpCircle size={15} /> },
            { label: 'Category A', value: 'CATEGORY_A', icon: <Layers size={15} /> },
            { label: 'Category B', value: 'CATEGORY_B', icon: <Award size={15} /> },
          ]}
          value={value.applicationCategory ?? ''}
          disabled={disabled}
          onChange={(val) =>
            set(
              'applicationCategory',
              (val ? val : null) as ApplicationCategory | null,
            )
          }
        />

        <RadioCardsField
          id="registrationType"
          label="Registration"
          icon={<FileCode size={15} />}
          required
          issue={issues.registrationType}
          options={[
            { label: 'Not registered', value: 'NONE', icon: <Ban size={15} /> },
            { label: 'CIN', value: 'CIN', icon: <FileCode size={15} /> },
            { label: 'UDYAM', value: 'UDYAM', icon: <Award size={15} /> },
          ]}
          value={value.registrationType ?? 'NONE'}
          disabled={disabled}
          onChange={(next) => {
            const nextType = next as RegistrationType
            onChange({
              ...value,
              registrationType: nextType,
              registrationNumber: nextType === 'NONE' ? null : value.registrationNumber,
            })
          }}
        />

        {value.registrationType && value.registrationType !== 'NONE' ? (
          <Field
            id="registrationNumber"
            label={`${value.registrationType} number`}
            icon={<Receipt size={15} />}
            issue={issues.registrationNumber}
            required
          >
            <input
              id="registrationNumber"
              className={styles.input}
              placeholder={`Enter ${value.registrationType} number`}
              disabled={disabled}
              value={value.registrationNumber ?? ''}
              onChange={(event) => set('registrationNumber', orNull(event.target.value))}
              {...invalid(issues, 'registrationNumber')}
            />
          </Field>
        ) : null}

        <Field
          id="gstin"
          label={FIELD_LABELS.gstin}
          icon={<Receipt size={15} />}
          issue={issues.gstin}
        >
          <input
            id="gstin"
            className={styles.input}
            placeholder="Enter GSTIN (if any)"
            disabled={disabled}
            value={value.gstin ?? ''}
            onChange={(event) => set('gstin', orNull(event.target.value))}
            {...invalid(issues, 'gstin')}
          />
        </Field>

        <Field
          id="businessSector"
          label={FIELD_LABELS.businessSector}
          icon={<Briefcase size={15} />}
          issue={issues.businessSector}
          required
        >
          <select
            id="businessSector"
            className={styles.select}
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
            <option value="">Select sector</option>
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
            icon={<FileText size={15} />}
            issue={issues.otherBusinessSector}
            required
          >
            <input
              id="otherBusinessSector"
              className={styles.input}
              placeholder="Enter description"
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
        icon={<ShieldCheck size={18} />}
        issue={issues.majorityOwnershipConfirmed}
        checked={value.majorityOwnershipConfirmed ?? false}
        disabled={disabled}
        onChange={(checked) => set('majorityOwnershipConfirmed', checked)}
        highlight
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
    <div className={styles.sectionStack}>
      <div className={styles.twoColGrid}>
        <Field
          id="primaryApplicantName"
          label={FIELD_LABELS.primaryApplicantName}
          icon={<User size={15} />}
          issue={issues.primaryApplicantName}
          required
        >
          <input
            id="primaryApplicantName"
            className={styles.input}
            placeholder="Enter full name"
            disabled={disabled}
            value={value.primaryApplicantName ?? ''}
            onChange={(event) => set('primaryApplicantName', orNull(event.target.value))}
            {...invalid(issues, 'primaryApplicantName')}
          />
        </Field>

        <Field
          id="designation"
          label={FIELD_LABELS.designation}
          icon={<Briefcase size={15} />}
          issue={issues.designation}
          required
        >
          <select
            id="designation"
            className={styles.select}
            disabled={disabled}
            value={value.designation ?? ''}
            onChange={(event) =>
              set('designation', orNull(event.target.value) as ApplicantDesignation | null)
            }
            {...invalid(issues, 'designation')}
          >
            <option value="">Select role / designation</option>
            {DESIGNATIONS.map((designation) => (
              <option key={designation} value={designation}>
                {humanize(designation)}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id="dateOfBirth"
          label={FIELD_LABELS.dateOfBirth}
          icon={<Calendar size={15} />}
          issue={issues.dateOfBirth}
          required
        >
          <input
            id="dateOfBirth"
            className={styles.input}
            type="date"
            disabled={disabled}
            value={value.dateOfBirth ?? ''}
            onChange={(event) => set('dateOfBirth', orNull(event.target.value))}
            {...invalid(issues, 'dateOfBirth')}
          />
        </Field>

        <Field
          id="gender"
          label={FIELD_LABELS.gender}
          icon={<Users size={15} />}
          issue={issues.gender}
          required
        >
          <select
            id="gender"
            className={styles.select}
            disabled={disabled}
            value={value.gender ?? ''}
            onChange={(event) => set('gender', orNull(event.target.value) as Gender | null)}
            {...invalid(issues, 'gender')}
          >
            <option value="">Select gender</option>
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
          icon={<MapPin size={15} />}
          issue={issues.businessBlockOrVillage}
          required
        >
          <input
            id="businessBlockOrVillage"
            className={styles.input}
            placeholder="Enter block or village"
            disabled={disabled}
            value={value.businessBlockOrVillage ?? ''}
            onChange={(event) => set('businessBlockOrVillage', orNull(event.target.value))}
            {...invalid(issues, 'businessBlockOrVillage')}
          />
        </Field>

        <Field
          id="businessDistrict"
          label={FIELD_LABELS.businessDistrict}
          icon={<Compass size={15} />}
          issue={issues.businessDistrict}
          required
        >
          <input
            id="businessDistrict"
            className={styles.input}
            placeholder="Enter district"
            disabled={disabled}
            value={value.businessDistrict ?? ''}
            onChange={(event) => set('businessDistrict', orNull(event.target.value))}
            {...invalid(issues, 'businessDistrict')}
          />
        </Field>

        <Field
          id="businessPinCode"
          label={FIELD_LABELS.businessPinCode}
          icon={<Mailbox size={15} />}
          issue={issues.businessPinCode}
          required
        >
          <input
            id="businessPinCode"
            className={styles.input}
            inputMode="numeric"
            maxLength={6}
            placeholder="Enter 6-digit PIN code"
            disabled={disabled}
            value={value.businessPinCode ?? ''}
            onChange={(event) => set('businessPinCode', orNull(event.target.value))}
            {...invalid(issues, 'businessPinCode')}
          />
        </Field>

        <Field
          id="contactNumber"
          label={FIELD_LABELS.contactNumber}
          icon={<Phone size={15} />}
          issue={issues.contactNumber}
          required
        >
          <input
            id="contactNumber"
            className={styles.input}
            type="tel"
            placeholder="Enter 10-digit mobile number"
            disabled={disabled}
            value={value.contactNumber ?? ''}
            onChange={(event) => set('contactNumber', orNull(event.target.value))}
            {...invalid(issues, 'contactNumber')}
          />
        </Field>

        <Field
          id="contactEmail"
          label={FIELD_LABELS.contactEmail}
          icon={<Mail size={15} />}
          issue={issues.contactEmail}
          required
        >
          <input
            id="contactEmail"
            className={styles.input}
            type="email"
            placeholder="Enter contact email address"
            disabled={disabled}
            value={value.contactEmail ?? ''}
            onChange={(event) => set('contactEmail', orNull(event.target.value))}
            {...invalid(issues, 'contactEmail')}
          />
        </Field>
      </div>
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

  const money = (
    id: keyof ApplicationDraftInput['financial'],
    label: string,
    icon: React.ReactNode,
    required?: boolean,
  ) => (
    <Field
      id={id}
      label={label}
      icon={icon}
      required={required}
      hint={value[id] ? formatMoney(value[id]) : undefined}
      issue={issues[id]}
    >
      <input
        id={id}
        className={styles.input}
        type="number"
        min={0}
        step="0.01"
        placeholder="0.00"
        disabled={disabled}
        value={paiseToRupees(value[id])}
        onChange={(event) => set(id, rupeesToPaise(event.target.value))}
        {...invalid(issues, id)}
      />
    </Field>
  )

  return (
    <div className={styles.sectionStack}>
      <div className={styles.twoColGrid}>
        {money(
          'totalProjectCostPaise',
          FIELD_LABELS.totalProjectCostPaise,
          <IndianRupee size={15} />,
          true,
        )}
        {money(
          'seedFundRequestedPaise',
          FIELD_LABELS.seedFundRequestedPaise,
          <Coins size={15} />,
          true,
        )}
        {money(
          'bankLoanProposedPaise',
          FIELD_LABELS.bankLoanProposedPaise,
          <Landmark size={15} />,
        )}
        {money(
          'promoterContributionPaise',
          FIELD_LABELS.promoterContributionPaise,
          <Wallet size={15} />,
        )}
      </div>
      <p className={styles.fieldHint}>
        Enter each source that applies. These amounts do not have to add up to the total
        project cost.
      </p>
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
    <div className={styles.sectionStack}>
      <YesNoField
        name="receivedGovernmentFunding"
        question={FIELD_LABELS.receivedGovernmentFunding}
        issue={issues.receivedGovernmentFunding}
        value={value.receivedGovernmentFunding}
        disabled={disabled}
        onAnswer={(answer) =>
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
        <div className={styles.twoColGrid}>
          <Field
            id="governmentSchemeName"
            label={FIELD_LABELS.governmentSchemeName}
            icon={<Building size={15} />}
            issue={issues.governmentSchemeName}
            required
          >
            <input
              id="governmentSchemeName"
              className={styles.input}
              placeholder="Enter scheme name"
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
            icon={<IndianRupee size={15} />}
            issue={issues.governmentFundingAmountPaise}
            required
          >
            <input
              id="governmentFundingAmountPaise"
              className={styles.input}
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
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
            icon={<Calendar size={15} />}
            issue={issues.governmentFundingSanctionYear}
            required
          >
            <input
              id="governmentFundingSanctionYear"
              className={styles.input}
              type="number"
              placeholder="e.g. 2024"
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
        <div className={styles.twoColGrid}>
          <Field
            id="existingBankName"
            label={FIELD_LABELS.existingBankName}
            icon={<Landmark size={15} />}
            issue={issues.existingBankName}
            required
          >
            <input
              id="existingBankName"
              className={styles.input}
              placeholder="Enter bank name"
              disabled={disabled}
              value={value.existingBankName ?? ''}
              onChange={(event) => set('existingBankName', orNull(event.target.value))}
              {...invalid(issues, 'existingBankName')}
            />
          </Field>
          <Field
            id="existingCreditAmountPaise"
            label={FIELD_LABELS.existingCreditAmountPaise}
            icon={<IndianRupee size={15} />}
            issue={issues.existingCreditAmountPaise}
            required
          >
            <input
              id="existingCreditAmountPaise"
              className={styles.input}
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              disabled={disabled}
              value={paiseToRupees(value.existingCreditAmountPaise)}
              onChange={(event) =>
                set('existingCreditAmountPaise', rupeesToPaise(event.target.value))
              }
              {...invalid(issues, 'existingCreditAmountPaise')}
            />
          </Field>
          <RadioCardsField
            id="existingCreditStatus"
            label={FIELD_LABELS.existingCreditStatus}
            icon={<ShieldCheck size={15} />}
            issue={issues.existingCreditStatus}
            required
            options={[
              { label: 'Standard', value: 'STANDARD', icon: <CheckCircle2 size={15} /> },
              {
                label: 'Non-performing (NPA)',
                value: 'NPA',
                icon: <AlertTriangle size={15} />,
              },
            ]}
            value={value.existingCreditStatus ?? ''}
            disabled={disabled}
            onChange={(next) =>
              set(
                'existingCreditStatus',
                orNull(next) as CreditStatus | null,
              )
            }
          />
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
    <div className={styles.sectionStack}>
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
    <div className={styles.sectionStack}>
      <div className={styles.twoColGrid}>
        <Field
          id="relationshipType"
          label={FIELD_LABELS.relationshipType}
          icon={<Users size={15} />}
          issue={issues.relationshipType}
          required
        >
          <select
            id="relationshipType"
            className={styles.select}
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
            <option value="">Select relationship</option>
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
          icon={<User size={15} />}
          issue={issues.relatedPersonName}
          required
        >
          <input
            id="relatedPersonName"
            className={styles.input}
            placeholder="Enter parent or spouse name"
            disabled={disabled}
            value={value.relatedPersonName ?? ''}
            onChange={(event) => set('relatedPersonName', orNull(event.target.value))}
            {...invalid(issues, 'relatedPersonName')}
          />
        </Field>

        <Field
          id="declarationPlace"
          label={FIELD_LABELS.declarationPlace}
          icon={<MapPin size={15} />}
          issue={issues.declarationPlace}
          required
        >
          <input
            id="declarationPlace"
            className={styles.input}
            placeholder="Enter place (e.g. Agartala)"
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
        icon={<FileSignature size={18} />}
        issue={issues.declarationAccepted}
        checked={value.declarationAccepted ?? false}
        disabled={disabled}
        onChange={(checked) => set('declarationAccepted', checked)}
        highlight
      />
    </div>
  )
})
