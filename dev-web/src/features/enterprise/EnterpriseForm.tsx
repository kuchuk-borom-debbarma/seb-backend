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
import { FormJourney, type JourneyStep } from '#/features/forms/FormJourney'
import type {
  BusinessSector,
  EnterpriseProfileInput,
  RegistrationType,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'

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

const ENTERPRISE_STEPS: Array<
  Pick<JourneyStep<EnterpriseStep>, 'id' | 'label' | 'description'>
> = [
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

  const steps: Array<JourneyStep<EnterpriseStep>> = ENTERPRISE_STEPS.map(
    (step, index) => ({
      ...step,
      status:
        index < activeIndex ? 'complete' : index > activeIndex ? 'blocked' : 'available',
    }),
  )

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
      onSubmit={(event) => {
        event.preventDefault()
        if (!event.currentTarget.reportValidity()) return
        onSubmit(values)
      }}
    >
      <FormJourney
        steps={steps}
        activeStepId={activeStep}
        onStepSelect={(step) => {
          const target = ENTERPRISE_STEPS.findIndex((candidate) => candidate.id === step)
          if (target <= activeIndex) setActiveStep(step)
        }}
        footerStatus={
          <span className="muted">Your answers are saved when you finish this form.</span>
        }
        footer={
          <>
            {activeIndex > 0 ? (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  setActiveStep(ENTERPRISE_STEPS[activeIndex - 1]?.id ?? 'DETAILS')
                }
              >
                Back
              </button>
            ) : onCancel ? (
              <button type="button" className="button" disabled={busy} onClick={cancel}>
                Cancel
              </button>
            ) : null}

            {activeIndex < ENTERPRISE_STEPS.length - 1 ? (
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={busy}
                onClick={(event) => {
                  /*
                   * Moving onto the final category replaces this button with
                   * the submit button. React may reuse the same DOM node, so
                   * the browser can otherwise observe `type=submit` as the
                   * click finishes and submit before the applicant has seen
                   * Contact details.
                   */
                  event.preventDefault()
                  next(event.currentTarget.form!)
                }}
              >
                Next
              </button>
            ) : (
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={busy}
              >
                {busy ? 'Saving…' : submitLabel}
              </button>
            )}

            {activeIndex > 0 && onCancel ? (
              <button
                type="button"
                className="button"
                data-variant="ghost"
                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </button>
            ) : null}
          </>
        }
      >
        {activeStep === 'DETAILS' ? (
          <EnterpriseDetails values={values} set={set} />
        ) : activeStep === 'REGISTRATION' ? (
          <RegistrationDetails values={values} set={set} />
        ) : activeStep === 'LOCATION' ? (
          <LocationDetails values={values} set={set} />
        ) : (
          <ContactDetails values={values} set={set} />
        )}
      </FormJourney>
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
    <div className="detail-grid">
      <div>
        <label className="field-label" htmlFor="name">
          Registered or trading name
        </label>
        <input
          id="name"
          className="input"
          required
          minLength={2}
          maxLength={200}
          value={values.name}
          onChange={(event) => set('name', event.target.value)}
        />
      </div>

      <div>
        <label className="field-label" htmlFor="establishmentDate">
          Date established
        </label>
        <input
          id="establishmentDate"
          className="input"
          type="date"
          value={values.establishmentDate ?? ''}
          onChange={(event) => set('establishmentDate', orNull(event.target.value))}
        />
        <span className="field-hint">
          Leave empty if the enterprise is still proposed.
        </span>
      </div>

      <div>
        <label className="field-label" htmlFor="businessSector">
          Sector
        </label>
        <select
          id="businessSector"
          className="select"
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
        <div>
          <label className="field-label" htmlFor="otherBusinessSector">
            Describe the sector
          </label>
          <input
            id="otherBusinessSector"
            className="input"
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
    <div className="detail-grid">
      <div>
        <label className="field-label" htmlFor="registrationType">
          Registration
        </label>
        <select
          id="registrationType"
          className="select"
          value={values.registrationType}
          onChange={(event) => {
            const next = event.target.value as RegistrationType
            set('registrationType', next)
            if (next === 'NONE') set('registrationNumber', null)
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
        <div>
          <label className="field-label" htmlFor="registrationNumber">
            {values.registrationType} number
          </label>
          <input
            id="registrationNumber"
            className="input"
            required
            maxLength={200}
            value={values.registrationNumber ?? ''}
            onChange={(event) => set('registrationNumber', orNull(event.target.value))}
          />
        </div>
      ) : null}

      <div>
        <label className="field-label" htmlFor="gstin">
          GSTIN
        </label>
        <input
          id="gstin"
          className="input tabular"
          maxLength={15}
          pattern="[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][A-Za-z0-9]Z[A-Za-z0-9]"
          title="Enter a valid 15-character GSTIN."
          value={values.gstin ?? ''}
          onChange={(event) => set('gstin', orNull(event.target.value))}
        />
        <span className="field-hint">Only if the enterprise is registered for GST.</span>
      </div>
    </div>
  )
}

function LocationDetails({ values, set }: { values: EnterpriseFormValues; set: Setter }) {
  return (
    <div className="detail-grid">
      <div>
        <label className="field-label" htmlFor="businessBlockOrVillage">
          Block or village
        </label>
        <input
          id="businessBlockOrVillage"
          className="input"
          maxLength={500}
          value={values.businessBlockOrVillage ?? ''}
          onChange={(event) => set('businessBlockOrVillage', orNull(event.target.value))}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="businessDistrict">
          District
        </label>
        <input
          id="businessDistrict"
          className="input"
          maxLength={200}
          value={values.businessDistrict ?? ''}
          onChange={(event) => set('businessDistrict', orNull(event.target.value))}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="businessPinCode">
          PIN code
        </label>
        <input
          id="businessPinCode"
          className="input tabular"
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
    <div className="detail-grid">
      <div>
        <label className="field-label" htmlFor="contactNumber">
          Contact number
        </label>
        <input
          id="contactNumber"
          className="input"
          type="tel"
          pattern="[+]?[1-9][0-9]{7,14}"
          title="Enter a valid phone number with 8 to 15 digits."
          maxLength={16}
          value={values.contactNumber ?? ''}
          onChange={(event) => set('contactNumber', orNull(event.target.value))}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="contactEmail">
          Contact email
        </label>
        <input
          id="contactEmail"
          className="input"
          type="email"
          maxLength={254}
          value={values.contactEmail ?? ''}
          onChange={(event) => set('contactEmail', orNull(event.target.value))}
        />
      </div>
    </div>
  )
}
