/**
 * The enterprise profile journey, shared by registration and editing.
 *
 * The API accepts the same complete profile for both operations, so one form
 * keeps their questions, conditional clearing, and progression rules aligned.
 * Values remain in React state until the final category is submitted; they are
 * never copied into browser storage where the next person at the device could
 * inherit them.
 */
import { useEffect, useState } from 'react'
import { Check, LockKeyhole } from 'lucide-react'
import type {
  BusinessSector,
  EnterpriseProfileInput,
  RegistrationType,
} from '#/graphql/generated/schema'
import { TRIPURA_DISTRICTS } from '#/lib/businessRules'
import { humanize } from '#/lib/format'
import styles from './EnterpriseWizard.module.css'

const REGISTRATION_TYPES: RegistrationType[] = ['NONE', 'CIN', 'UDYAM']

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
      'Add the block or village, district, and postal code where the enterprise operates.',
  },
  {
    id: 'CONTACT',
    label: 'Contact details',
    description:
      'Give the phone number and email address the programme office should use for this enterprise.',
  },
]

export type EnterpriseFormValues = EnterpriseProfileInput

/** Empty rather than pre-filled: nothing is assumed about a new enterprise. */
export const emptyEnterprise: EnterpriseFormValues = {
  name: '',
  establishmentDate: null,
  registrationType: 'NONE',
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
      {/* Top Stepper Card */}
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

      {/* Main Form Content Card */}
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
          minLength={2}
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
              value={values.establishmentDate ?? ''}
              onChange={(event) => set('establishmentDate', orNull(event.target.value))}
            />
          </div>
          <span className={styles.fieldHint}>
            Leave empty if the enterprise is still proposed.
          </span>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="businessSector">
          Sector
        </label>
        <select
          id="businessSector"
          className={styles.selectInput}
          required
          value={values.businessSector ?? ''}
          onChange={(event) => {
            const nextVal = orNull(event.target.value) as BusinessSector | null
            set('businessSector', nextVal)
            if (nextVal !== 'OTHER') set('otherBusinessSector', null)
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
            maxLength={200}
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
  const registered = values.registrationType !== 'NONE'
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
          onChange={(event) => {
            const nextVal = event.target.value as RegistrationType
            set('registrationType', nextVal)
            if (nextVal === 'NONE') set('registrationNumber', null)
          }}
        >
          {REGISTRATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {type === 'NONE' ? 'Not registered' : type}
            </option>
          ))}
        </select>
      </div>

      {registered ? (
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="registrationNumber">
            {values.registrationType} number
          </label>
          <input
            id="registrationNumber"
            className={styles.textInput}
            required
            maxLength={200}
            value={values.registrationNumber ?? ''}
            onChange={(event) => set('registrationNumber', orNull(event.target.value))}
          />
        </div>
      ) : null}

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="gstin">
          GSTIN
        </label>
        <input
          id="gstin"
          className={styles.textInput}
          maxLength={15}
          pattern="[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][A-Za-z0-9]Z[A-Za-z0-9]"
          title="Enter a valid 15-character GSTIN."
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
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="businessBlockOrVillage">
          Office address (as per your business documents)
        </label>
        <input
          id="businessBlockOrVillage"
          className={styles.textInput}
          maxLength={500}
          value={values.businessBlockOrVillage ?? ''}
          onChange={(event) => set('businessBlockOrVillage', orNull(event.target.value))}
        />
        <span className={styles.fieldHint}>
          Enter business-document details, not a personal or residential address.
        </span>
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
          <option value="">Select district</option>
          {TRIPURA_DISTRICTS.map((district) => (
            <option key={district} value={district}>
              {district}
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
          pattern="[0-9]{6}"
          title="Enter a six-digit PIN code."
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
          pattern="[0-9]{10}"
          title="Enter exactly 10 digits without a country prefix."
          maxLength={10}
          value={values.contactNumber ?? ''}
          onChange={(event) => set('contactNumber', orNull(event.target.value))}
        />
      </div>
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel} htmlFor="contactEmail">
          Contact email
        </label>
        <input
          id="contactEmail"
          className={styles.textInput}
          type="email"
          maxLength={254}
          value={values.contactEmail ?? ''}
          onChange={(event) => set('contactEmail', orNull(event.target.value))}
        />
      </div>
    </div>
  )
}
