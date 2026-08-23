/**
 * The enterprise profile form, shared by registration and editing.
 *
 * One component because the API takes the same `EnterpriseProfileInput` for
 * both. Keeping them together is what stops a field being added to creation and
 * quietly forgotten on the edit screen.
 *
 * Validation is deliberately thin here. The Worker owns the real rules — it
 * normalizes, cross-checks registration numbers against the registration type,
 * and returns a message written for the person reading it. The browser only
 * marks fields the API named, so the two can never disagree about what is
 * valid.
 */
import { useState } from 'react'
import type {
  BusinessSector,
  EnterpriseProfileInput,
  RegistrationType,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'

/**
 * The sectors and registration types come from the schema's own enums, so a
 * value added to the API appears here without an edit.
 */
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

  const set = <TKey extends keyof EnterpriseFormValues>(
    key: TKey,
    value: EnterpriseFormValues[TKey],
  ) => setValues((current) => ({ ...current, [key]: value }))

  // The API requires a registration number for a registered enterprise and
  // refuses one for an unregistered enterprise, so the field follows the type.
  const registered = values.registrationType !== 'NONE'

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(values)
      }}
    >
      <fieldset className="fieldset">
        <legend className="eyebrow">The enterprise</legend>
        <div className="detail-grid">
          <div>
            <label className="field-label" htmlFor="name">
              Registered or trading name
            </label>
            <input
              id="name"
              className="input"
              required
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
                // An unregistered enterprise cannot carry a number, so clearing
                // it here keeps the form from submitting a value the API will
                // refuse.
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
                value={values.registrationNumber ?? ''}
                onChange={(event) =>
                  set('registrationNumber', orNull(event.target.value))
                }
              />
            </div>
          ) : null}

          <div>
            <label className="field-label" htmlFor="gstin">
              GSTIN
            </label>
            <input
              id="gstin"
              className="input"
              value={values.gstin ?? ''}
              onChange={(event) => set('gstin', orNull(event.target.value))}
            />
            <span className="field-hint">
              Only if the enterprise is registered for GST.
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
                value={values.otherBusinessSector ?? ''}
                onChange={(event) =>
                  set('otherBusinessSector', orNull(event.target.value))
                }
              />
            </div>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="eyebrow">Where it operates</legend>
        <div className="detail-grid">
          <div>
            <label className="field-label" htmlFor="businessBlockOrVillage">
              Block or village
            </label>
            <input
              id="businessBlockOrVillage"
              className="input"
              value={values.businessBlockOrVillage ?? ''}
              onChange={(event) =>
                set('businessBlockOrVillage', orNull(event.target.value))
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="businessDistrict">
              District
            </label>
            <input
              id="businessDistrict"
              className="input"
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
              maxLength={6}
              value={values.businessPinCode ?? ''}
              onChange={(event) => set('businessPinCode', orNull(event.target.value))}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="eyebrow">How to reach the enterprise</legend>
        <div className="detail-grid">
          <div>
            <label className="field-label" htmlFor="contactNumber">
              Contact number
            </label>
            <input
              id="contactNumber"
              className="input"
              type="tel"
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
              value={values.contactEmail ?? ''}
              onChange={(event) => set('contactEmail', orNull(event.target.value))}
            />
          </div>
        </div>
      </fieldset>

      <div className="row">
        <button type="submit" className="button" data-variant="primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
