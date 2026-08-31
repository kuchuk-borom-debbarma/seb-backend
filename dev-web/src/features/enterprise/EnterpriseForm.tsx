/**
 * The enterprise profile journey, shared by registration and editing.
 *
 * One component because the API takes the same `EnterpriseProfileInput` for
 * both. Keeping them together is what stops a field being added to creation and
 * quietly forgotten on the edit screen.
 *
 * The questions are asked one category at a time. Values remain in React state
 * until the final category is submitted; they are never copied into browser
 * storage where the next person at the device could inherit them.
 *
 * Validation is deliberately thin here. The Worker owns the real rules — it
 * normalizes, cross-checks registration numbers against the registration type,
 * and returns a message written for the person reading it. The browser only
 * checks what a step's own fields declare, so the two can never disagree about
 * what is valid.
 */
import { useEffect, useState } from 'react'
import { Check, LockKeyhole } from 'lucide-react'
import type {
  BusinessSector,
  EnterpriseProfileInput,
  RegistrationType,
} from '#/graphql/generated/schema'
import { DISTRICTS } from '#/features/enterprise/districts'
import { humanize } from '#/lib/format'
import styles from './EnterpriseWizard.module.css'

/**
 * The sectors and registration types come from the schema's own enums, so a
 * value added to the API appears here without an edit.
 */
const REGISTRATION_TYPES: RegistrationType[] = [
  'PRIVATE_LIMITED',
  'LLP',
  'SOLE_PROPRIETORSHIP',
  'OPC',
]

/** Exported so the read view describes a type in the same words as the form. */
export const REGISTRATION_TYPE_LABELS: Record<RegistrationType, string> = {
  PRIVATE_LIMITED: 'Private Limited',
  LLP: 'LLP (Limited Liability Partnership)',
  SOLE_PROPRIETORSHIP: 'Sole Proprietorship',
  OPC: 'OPC (One Person Company)',
}

/** Which number each instrument confers, naming the registration-number field. */
const REGISTRATION_NUMBER_LABELS: Record<RegistrationType, string> = {
  PRIVATE_LIMITED: 'CIN',
  LLP: 'LLPIN',
  SOLE_PROPRIETORSHIP: 'Registration number',
  OPC: 'CIN',
}

const SECTORS: BusinessSector[] = [
  'AGRICULTURE_AND_ALLIED',
  'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  'FOOD_PROCESSING',
  'TOURISM_AND_HOSPITALITY',
  'INFORMATION_TECHNOLOGY',
  'MANUFACTURING_AND_SERVICES',
  'OTHER',
]

type EnterpriseStep = 'DETAILS' | 'REGISTRATION' | 'LOCATION' | 'CONTACT'

type EnterpriseStepDef = {
  id: EnterpriseStep
  label: string
  description: string
}

const ENTERPRISE_STEPS: EnterpriseStepDef[] = [
  {
    id: 'DETAILS',
    label: 'Enterprise details',
    description:
      'Tell us what the enterprise is called, when it began, and the work it does.',
  },
  {
    id: 'REGISTRATION',
    label: 'Registration and tax',
    description: 'Record the enterprise registration and GST details that apply to it.',
  },
  {
    id: 'LOCATION',
    label: 'Business location',
    description:
      'Add the office address, district, and postal code where the enterprise operates.',
  },
  {
    id: 'CONTACT',
    label: 'Contact details',
    description:
      'Give the phone number and email address the programme office should use for this enterprise.',
  },
]

export type EnterpriseFormValues = EnterpriseProfileInput

/**
 * Empty apart from the registration type, which the API requires. Sole
 * proprietorship is the one type whose number is optional, so a name-only
 * registration still goes through.
 */
export const emptyEnterprise: EnterpriseFormValues = {
  name: '',
  establishmentDate: null,
  registrationType: 'SOLE_PROPRIETORSHIP',
  registrationNumber: null,
  gstin: null,
  businessSector: null,
  otherBusinessSector: null,
  businessBlockOrVillage: null,
  businessDistrict: null,
  businessPinCode: null,
  contactNumber: null,
  contactEmail: null,
}

/** Blank input means "no value", which the API models as null rather than "". */
const orNull = (value: string): string | null => (value.trim() === '' ? null : value)

export function EnterpriseForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: EnterpriseFormValues
  submitLabel: string
  busy: boolean
  onSubmit: (values: EnterpriseFormValues) => void
  onCancel?: () => void
}) {
  const [values, setValues] = useState<EnterpriseFormValues>(initial)
  const [activeStep, setActiveStep] = useState<EnterpriseStep>('DETAILS')
  const activeIndex = ENTERPRISE_STEPS.findIndex((step) => step.id === activeStep)
  const activeDef = ENTERPRISE_STEPS[activeIndex] ?? ENTERPRISE_STEPS[0]!
  const dirty = JSON.stringify(values) !== JSON.stringify(initial)

  // Half-entered answers exist only in this component's state, so leaving the
  // page is the one way to lose them — worth a browser prompt while dirty.
  useEffect(() => {
    if (!dirty || busy) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy, dirty])

  const set = <TKey extends keyof EnterpriseFormValues>(
    key: TKey,
    value: EnterpriseFormValues[TKey],
  ) => setValues((current) => ({ ...current, [key]: value }))

  // Only the fields of the visible step are rendered, so reportValidity()
  // checks exactly the current category before letting it be left.
  const next = (form: HTMLFormElement) => {
    if (!form.reportValidity()) return
    const following = ENTERPRISE_STEPS[activeIndex + 1]
    if (following) setActiveStep(following.id)
  }

  const cancel = () => {
    if (
      dirty &&
      !window.confirm('Discard the enterprise details entered on this form?')
    ) {
      return
    }
    onCancel?.()
  }

  return (
    <form
      className={styles.pageContainer}
      onSubmit={(event) => {
        event.preventDefault()
        if (!event.currentTarget.reportValidity()) return
        onSubmit(values)
      }}
    >
      {/* Top stepper card */}
      <section className={styles.stepperCard} aria-label="Registration categories">
        <div className={styles.stepperTrack}>
          {ENTERPRISE_STEPS.map((step, index) => {
            const isCurrent = index === activeIndex
            const isDone = index < activeIndex
            const isAhead = index > activeIndex
            const canNavigate = index <= activeIndex

            return (
              <div key={step.id} style={{ display: 'contents' }}>
                <button
                  type="button"
                  className={`${styles.stepItem} ${
                    canNavigate ? styles.stepItemInteractive : ''
                  }`}
                  disabled={!canNavigate}
                  onClick={() => {
                    if (canNavigate) setActiveStep(step.id)
                  }}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <div
                    className={`${styles.stepCircle} ${
                      isCurrent
                        ? styles.stepCircleCurrent
                        : isDone
                          ? styles.stepCircleDone
                          : styles.stepCircleAhead
                    }`}
                  >
                    {isDone ? <Check size={14} strokeWidth={2.5} /> : index + 1}
                  </div>
                  <div className={styles.stepTextGroup}>
                    <span
                      className={`${styles.stepLabel} ${
                        isAhead ? styles.stepLabelAhead : ''
                      }`}
                    >
                      {step.label}
                    </span>
                    <span
                      className={`${styles.stepSubtitle} ${
                        isCurrent
                          ? styles.stepSubtitleCurrent
                          : isDone
                            ? styles.stepSubtitleDone
                            : styles.stepSubtitleAhead
                      }`}
                    >
                      {isCurrent
                        ? 'Current category'
                        : isDone
                          ? 'Complete'
                          : 'Complete earlier categories first'}
                    </span>
                  </div>
                </button>

                {index < ENTERPRISE_STEPS.length - 1 && (
                  <div className={styles.stepperDashedLine} aria-hidden="true" />
                )}
              </div>
            )
          })}
        </div>

        <div className={styles.stepperFooter}>
          Category {activeIndex + 1} of {ENTERPRISE_STEPS.length}
        </div>
      </section>

      {/* Main form content card */}
      <section className={styles.formCard}>
        <h2 className={styles.categoryHeading}>{activeDef.label}</h2>
        <p className={styles.categoryDesc}>{activeDef.description}</p>

        {activeStep === 'DETAILS' ? (
          <EnterpriseDetails values={values} set={set} />
        ) : activeStep === 'REGISTRATION' ? (
          <RegistrationDetails values={values} set={set} />
        ) : activeStep === 'LOCATION' ? (
          <LocationDetails values={values} set={set} />
        ) : (
          <ContactDetails values={values} set={set} />
        )}

        <div className={styles.securityHint}>
          <LockKeyhole size={14} aria-hidden="true" />
          <span>Your answers are saved when you finish this form.</span>
        </div>

        <div className={styles.formActions}>
          <div>
            {activeIndex > 0 ? (
              <button
                type="button"
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() =>
                  setActiveStep(ENTERPRISE_STEPS[activeIndex - 1]?.id ?? 'DETAILS')
                }
              >
                Back
              </button>
            ) : onCancel ? (
              <button
                type="button"
                className={styles.btnSecondary}
                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </button>
            ) : null}
          </div>

          <div>
            {activeIndex < ENTERPRISE_STEPS.length - 1 ? (
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault()
                  next(event.currentTarget.form!)
                }}
              >
                Next
              </button>
            ) : (
              <button type="submit" className={styles.btnPrimary} disabled={busy}>
                {busy ? 'Saving…' : submitLabel}
              </button>
            )}
          </div>
        </div>
      </section>
    </form>
  )
}

type Setter = <TKey extends keyof EnterpriseFormValues>(
  key: TKey,
  value: EnterpriseFormValues[TKey],
) => void

function EnterpriseDetails({
  values,
  set,
}: {
  values: EnterpriseFormValues
  set: Setter
}) {
  return (
    <div className={styles.fieldGrid}>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="name">
          Registered or trading name
        </label>
        <input
          id="name"
          className={styles.textInput}
          required
          maxLength={200}
          value={values.name}
          onChange={(event) => set('name', event.target.value)}
        />
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="establishmentDate">
          Date established
        </label>
        <div className={styles.dateRow}>
          <div className={styles.dateInputWrap}>
            <input
              id="establishmentDate"
              className={styles.dateInput}
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={values.establishmentDate ?? ''}
              onChange={(event) => set('establishmentDate', orNull(event.target.value))}
            />
          </div>
          <span className={styles.fieldHint}>
            Leave empty if the enterprise is still proposed.
          </span>
        </div>
        <span className={styles.fieldHint}>
          Your funding category is worked out from this date automatically when you
          apply — it is never something you choose.
        </span>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="businessSector">
          Sector
        </label>
        <select
          id="businessSector"
          className={styles.selectInput}
          value={values.businessSector ?? ''}
          onChange={(event) => {
            const next = orNull(event.target.value) as BusinessSector | null
            set('businessSector', next)
            if (next !== 'OTHER') set('otherBusinessSector', null)
          }}
        >
          <option value="">Not stated</option>
          {SECTORS.map((sector) => (
            <option key={sector} value={sector}>
              {humanize(sector)}
            </option>
          ))}
        </select>
      </div>

      {values.businessSector === 'OTHER' ? (
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="otherBusinessSector">
            Describe the sector
          </label>
          <input
            id="otherBusinessSector"
            className={styles.textInput}
            required
            value={values.otherBusinessSector ?? ''}
            onChange={(event) => set('otherBusinessSector', orNull(event.target.value))}
          />
        </div>
      ) : null}
    </div>
  )
}

function RegistrationDetails({
  values,
  set,
}: {
  values: EnterpriseFormValues
  set: Setter
}) {
  // The API requires the statutory number for the incorporated types and
  // leaves it optional for a sole proprietorship, so the field follows suit.
  const incorporated = values.registrationType !== 'SOLE_PROPRIETORSHIP'
  return (
    <div className={styles.fieldGrid}>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="registrationType">
          Registration
        </label>
        <select
          id="registrationType"
          className={styles.selectInput}
          value={values.registrationType}
          onChange={(event) =>
            set('registrationType', event.target.value as RegistrationType)
          }
        >
          {REGISTRATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {REGISTRATION_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="registrationNumber">
          {REGISTRATION_NUMBER_LABELS[values.registrationType]}
        </label>
        <input
          id="registrationNumber"
          className={styles.textInput}
          required={incorporated}
          value={values.registrationNumber ?? ''}
          onChange={(event) => set('registrationNumber', orNull(event.target.value))}
        />
        <span className={styles.fieldHint}>
          {incorporated
            ? 'As it appears on the certificate of incorporation.'
            : 'Only if the proprietorship holds one.'}
        </span>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="gstin">
          GSTIN
        </label>
        <input
          id="gstin"
          className={styles.textInput}
          value={values.gstin ?? ''}
          onChange={(event) => set('gstin', orNull(event.target.value))}
        />
        <span className={styles.fieldHint}>
          Only if the enterprise is registered for GST.
        </span>
      </div>
    </div>
  )
}

function LocationDetails({ values, set }: { values: EnterpriseFormValues; set: Setter }) {
  return (
    <div className={styles.fieldGrid}>
      <p className="notice" data-tone="action" style={{ margin: 0 }}>
        Give the address of the business itself, as it appears on your business
        documents — not a personal or home address.
      </p>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="businessBlockOrVillage">
          Office address (as per your business documents)
        </label>
        <input
          id="businessBlockOrVillage"
          className={styles.textInput}
          value={values.businessBlockOrVillage ?? ''}
          onChange={(event) => set('businessBlockOrVillage', orNull(event.target.value))}
        />
      </div>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="businessDistrict">
          District
        </label>
        <select
          id="businessDistrict"
          className={styles.selectInput}
          value={values.businessDistrict ?? ''}
          onChange={(event) => set('businessDistrict', orNull(event.target.value))}
        >
          <option value="">Select a district</option>
          {DISTRICTS.map((district) => (
            <option key={district.code} value={district.code}>
              {district.name} ({district.headquarters})
            </option>
          ))}
        </select>
      </div>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="businessPinCode">
          PIN code
        </label>
        <input
          id="businessPinCode"
          className={styles.textInput}
          inputMode="numeric"
          maxLength={6}
          value={values.businessPinCode ?? ''}
          onChange={(event) => set('businessPinCode', orNull(event.target.value))}
        />
      </div>
    </div>
  )
}

function ContactDetails({ values, set }: { values: EnterpriseFormValues; set: Setter }) {
  return (
    <div className={styles.fieldGrid}>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="contactNumber">
          Contact number
        </label>
        <input
          id="contactNumber"
          className={styles.textInput}
          type="tel"
          inputMode="numeric"
          maxLength={13}
          pattern="(\+91)?[0-9]{10}"
          title="Enter a 10-digit mobile number."
          value={values.contactNumber ?? ''}
          onChange={(event) => set('contactNumber', orNull(event.target.value))}
        />
        <span className={styles.fieldHint}>
          Your 10-digit mobile number; +91 is optional.
        </span>
      </div>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="contactEmail">
          Contact email
        </label>
        <input
          id="contactEmail"
          className={styles.textInput}
          type="email"
          value={values.contactEmail ?? ''}
          onChange={(event) => set('contactEmail', orNull(event.target.value))}
        />
      </div>
    </div>
  )
}
