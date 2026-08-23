/**
 * The programme cycle form.
 *
 * A cycle is the policy an application is judged by, frozen at the moment a
 * draft is started. That makes this the densest form in the product: ages,
 * waiting periods, the funding ceiling, which assessments an expansion needs,
 * which documents are required and when, and the reason catalogue every later
 * administrative action must choose from.
 *
 * The reason catalogue matters more than it looks. Desk review, revisions, bank
 * outcomes, committee decisions, award changes and recovery all require a
 * reason approved by the cycle, so a cycle created without them produces a
 * workflow that cannot be operated. The defaults below cover every context the
 * API defines, and are editable like everything else.
 */
import { useState } from 'react'
import type {
  AssessmentType,
  DocumentType,
  ProgrammeCycleInput,
  ProgrammeDocumentCondition,
  ProgrammeJurisdiction,
  ProgrammeReasonContext,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'

const ASSESSMENT_TYPES: AssessmentType[] = [
  'UTILIZATION',
  'PERFORMANCE',
  'FINANCIAL_AUDIT',
]

const DOCUMENT_TYPES: DocumentType[] = [
  'IDENTITY_AGE_PROOF',
  'ST_CERTIFICATE',
  'ADDRESS_PROOF',
  'BUSINESS_REGISTRATION',
  'GST_REGISTRATION',
  'DPR',
  'BANK_DETAILS',
  'NOC',
]

const DOCUMENT_CONDITIONS: ProgrammeDocumentCondition[] = [
  'ALWAYS',
  'WHEN_REGISTERED',
  'WHEN_GSTIN_PRESENT',
  'WHEN_NOC_REQUIRED',
  'OPTIONAL',
]

const REASON_CONTEXTS: ProgrammeReasonContext[] = [
  'CYCLE_CLOSE',
  'ASSIGNMENT_RELEASE',
  'ASSIGNMENT_REASSIGN',
  'REVISION',
  'REJECTION',
  'BANK_REFERRAL_CANCEL',
  'BANK_OUTCOME_CORRECTION',
  'TTM_DEFERRAL',
  'TTM_DECISION_CORRECTION',
  'AWARD_AMENDMENT',
  'AWARD_SUSPENSION',
  'AWARD_CANCELLATION',
  'AWARD_CLOSURE',
  'RELEASE_REVERSAL',
  'RECOVERY',
  'RECOVERY_WAIVER',
]

/** One usable reason per context, so a new cycle can be operated immediately. */
const defaultReasons = () =>
  REASON_CONTEXTS.map((context) => ({
    context,
    code: context,
    label: humanize(context),
    applicantMessageTemplate: null as string | null,
  }))

/** The evidence Mission SEP asks for, with the condition each is required under. */
const defaultDocumentRules = (): Array<{
  documentType: DocumentType
  condition: ProgrammeDocumentCondition
}> => [
  { documentType: 'IDENTITY_AGE_PROOF', condition: 'ALWAYS' },
  { documentType: 'ST_CERTIFICATE', condition: 'ALWAYS' },
  { documentType: 'ADDRESS_PROOF', condition: 'ALWAYS' },
  { documentType: 'DPR', condition: 'ALWAYS' },
  { documentType: 'BANK_DETAILS', condition: 'ALWAYS' },
  { documentType: 'BUSINESS_REGISTRATION', condition: 'WHEN_REGISTERED' },
  { documentType: 'GST_REGISTRATION', condition: 'WHEN_GSTIN_PRESENT' },
  { documentType: 'NOC', condition: 'WHEN_NOC_REQUIRED' },
]

export const emptyCycle = (year: number): ProgrammeCycleInput => ({
  cycleCode: `SEP-${year}`,
  displayName: `Mission SEP ${year}`,
  cycleYear: year,
  policyReference: null,
  applicantGuidance: null,
  partnerBankGuidance: null,
  opensAt: null,
  closesAt: null,
  policy: {
    minimumApplicantAge: 18,
    maximumApplicantAge: 60,
    categoryAMaximumMonths: 24,
    expansionWaitMonths: 12,
    majorityOwnershipRequired: true,
    jurisdiction: 'TTAADC',
    // Unresolved until TTAADC states one authoritative maximum — roadmap §21.
    fundingCeilingState: 'UNRESOLVED',
    fundingCeilingAmountPaise: null,
    fundingCeilingScope: null,
    requiredAssessmentTypes: [...ASSESSMENT_TYPES],
    documentRules: defaultDocumentRules(),
    reasons: defaultReasons(),
  },
})

/** Turns a datetime-local value into the ISO instant the API expects. */
const toInstant = (value: string): string | null =>
  value ? new Date(value).toISOString() : null

/** And back again, since `datetime-local` cannot read an ISO string with a zone. */
const toLocalInput = (value: string | null | undefined): string =>
  value ? new Date(value).toISOString().slice(0, 16) : ''

export function CycleForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: ProgrammeCycleInput
  submitLabel: string
  busy: boolean
  onSubmit: (values: ProgrammeCycleInput) => void
  onCancel?: () => void
}) {
  const [values, setValues] = useState<ProgrammeCycleInput>(initial)

  const set = <TKey extends keyof ProgrammeCycleInput>(
    key: TKey,
    value: ProgrammeCycleInput[TKey],
  ) => setValues((current) => ({ ...current, [key]: value }))

  const setPolicy = <TKey extends keyof ProgrammeCycleInput['policy']>(
    key: TKey,
    value: ProgrammeCycleInput['policy'][TKey],
  ) =>
    setValues((current) => ({
      ...current,
      policy: { ...current.policy, [key]: value },
    }))

  const toggleAssessment = (type: AssessmentType) =>
    setPolicy(
      'requiredAssessmentTypes',
      values.policy.requiredAssessmentTypes.includes(type)
        ? values.policy.requiredAssessmentTypes.filter((candidate) => candidate !== type)
        : [...values.policy.requiredAssessmentTypes, type],
    )

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(values)
      }}
    >
      <p className="notice" data-tone="action">
        <span className="notice-title">A cycle is created as a draft</span>
        Nothing here reaches applicants until you open it — and it can only be opened once
        the policy reference, applicant guidance, both dates, every eligibility field, a
        rule for every document type, at least one assessment, and a reason for every
        administrative action are all present.
      </p>

      <fieldset className="fieldset">
        <legend className="eyebrow">The cycle</legend>
        <div className="detail-grid">
          <div>
            <label className="field-label" htmlFor="cycleCode">
              Cycle code
            </label>
            <input
              id="cycleCode"
              className="input tabular"
              required
              value={values.cycleCode}
              // Upper-cased as it is typed. The API accepts only upper case,
              // and correcting it here is kinder than refusing the whole form
              // after a round trip.
              onChange={(event) => set('cycleCode', event.target.value.toUpperCase())}
            />
            <span className="field-hint">
              3–32 upper-case letters, numbers or hyphens. Unique, and shown to applicants
              beside the name.
            </span>
          </div>
          <div>
            <label className="field-label" htmlFor="displayName">
              Name
            </label>
            <input
              id="displayName"
              className="input"
              required
              value={values.displayName}
              onChange={(event) => set('displayName', event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="cycleYear">
              Programme year
            </label>
            <input
              id="cycleYear"
              className="input tabular"
              type="number"
              required
              value={values.cycleYear}
              onChange={(event) => set('cycleYear', Number(event.target.value))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="policyReference">
              Policy reference
            </label>
            <input
              id="policyReference"
              className="input"
              required
              value={values.policyReference ?? ''}
              onChange={(event) => set('policyReference', event.target.value || null)}
            />
            <span className="field-hint">
              The order or circular this cycle implements. Required before the cycle can
              be opened.
            </span>
          </div>
          <div>
            <label className="field-label" htmlFor="opensAt">
              Applications open
            </label>
            <input
              id="opensAt"
              className="input"
              type="datetime-local"
              required
              value={toLocalInput(values.opensAt)}
              onChange={(event) => set('opensAt', toInstant(event.target.value))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="closesAt">
              Applications close
            </label>
            <input
              id="closesAt"
              className="input"
              type="datetime-local"
              required
              value={toLocalInput(values.closesAt)}
              onChange={(event) => set('closesAt', toInstant(event.target.value))}
            />
          </div>
        </div>

        <div style={{ marginTop: '1rem' }}>
          <label className="field-label" htmlFor="applicantGuidance">
            Guidance for applicants
          </label>
          <textarea
            id="applicantGuidance"
            className="textarea"
            required
            value={values.applicantGuidance ?? ''}
            onChange={(event) => set('applicantGuidance', event.target.value || null)}
          />
          <span className="field-hint">
            Shown on the applicant's programme cycle page. Required before the cycle can
            be opened.
          </span>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="eyebrow">Eligibility policy</legend>
        <div className="detail-grid">
          <div>
            <label className="field-label" htmlFor="minimumApplicantAge">
              Minimum applicant age
            </label>
            <input
              id="minimumApplicantAge"
              className="input tabular"
              type="number"
              value={values.policy.minimumApplicantAge ?? ''}
              onChange={(event) =>
                setPolicy(
                  'minimumApplicantAge',
                  event.target.value ? Number(event.target.value) : null,
                )
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="maximumApplicantAge">
              Maximum applicant age
            </label>
            <input
              id="maximumApplicantAge"
              className="input tabular"
              type="number"
              value={values.policy.maximumApplicantAge ?? ''}
              onChange={(event) =>
                setPolicy(
                  'maximumApplicantAge',
                  event.target.value ? Number(event.target.value) : null,
                )
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="categoryAMaximumMonths">
              Category A maximum age of enterprise (months)
            </label>
            <input
              id="categoryAMaximumMonths"
              className="input tabular"
              type="number"
              value={values.policy.categoryAMaximumMonths ?? ''}
              onChange={(event) =>
                setPolicy(
                  'categoryAMaximumMonths',
                  event.target.value ? Number(event.target.value) : null,
                )
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="expansionWaitMonths">
              Expansion waiting period (months)
            </label>
            <input
              id="expansionWaitMonths"
              className="input tabular"
              type="number"
              value={values.policy.expansionWaitMonths ?? ''}
              onChange={(event) =>
                setPolicy(
                  'expansionWaitMonths',
                  event.target.value ? Number(event.target.value) : null,
                )
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="jurisdiction">
              Jurisdiction
            </label>
            <select
              id="jurisdiction"
              className="select"
              value={values.policy.jurisdiction ?? ''}
              onChange={(event) =>
                setPolicy(
                  'jurisdiction',
                  (event.target.value || null) as ProgrammeJurisdiction | null,
                )
              }
            >
              <option value="">Not stated</option>
              <option value="TTAADC">TTAADC areas</option>
              <option value="TRIPURA">Tripura</option>
            </select>
          </div>
          <div className="checkbox-row" style={{ alignSelf: 'end' }}>
            <input
              id="majorityOwnershipRequired"
              type="checkbox"
              checked={values.policy.majorityOwnershipRequired ?? false}
              onChange={(event) =>
                setPolicy('majorityOwnershipRequired', event.target.checked)
              }
            />
            <label htmlFor="majorityOwnershipRequired">
              Majority ST ownership required
            </label>
          </div>
        </div>

        <div style={{ marginTop: '1rem' }}>
          <span className="field-label">Assessments an expansion must pass</span>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {ASSESSMENT_TYPES.map((type) => (
              <label key={type} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={values.policy.requiredAssessmentTypes.includes(type)}
                  onChange={() => toggleAssessment(type)}
                />
                {humanize(type)}
              </label>
            ))}
          </div>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="eyebrow">Funding ceiling</legend>
        <p className="field-hint" style={{ marginBottom: '0.75rem' }}>
          TTAADC has not yet stated one authoritative maximum, so a cycle may be published
          with this unresolved. Applications are then not bounded by a ceiling.
        </p>
        <div className="detail-grid">
          <div>
            <label className="field-label" htmlFor="fundingCeilingState">
              Ceiling
            </label>
            <select
              id="fundingCeilingState"
              className="select"
              value={values.policy.fundingCeilingState ?? 'UNRESOLVED'}
              onChange={(event) => {
                const resolved = event.target.value === 'RESOLVED'
                setPolicy('fundingCeilingState', resolved ? 'RESOLVED' : 'UNRESOLVED')
                // An unresolved ceiling carries neither an amount nor a scope.
                if (!resolved) {
                  setPolicy('fundingCeilingAmountPaise', null)
                  setPolicy('fundingCeilingScope', null)
                }
              }}
            >
              <option value="UNRESOLVED">Not yet decided</option>
              <option value="RESOLVED">Decided</option>
            </select>
          </div>

          {values.policy.fundingCeilingState === 'RESOLVED' ? (
            <>
              <div>
                <label className="field-label" htmlFor="fundingCeilingAmountPaise">
                  Maximum, in rupees
                </label>
                <input
                  id="fundingCeilingAmountPaise"
                  className="input tabular"
                  type="number"
                  min={1}
                  value={
                    values.policy.fundingCeilingAmountPaise
                      ? Number(values.policy.fundingCeilingAmountPaise) / 100
                      : ''
                  }
                  onChange={(event) =>
                    setPolicy(
                      'fundingCeilingAmountPaise',
                      // Money is a string of paise on the wire, so rupees are
                      // converted here rather than anywhere the value is read.
                      event.target.value
                        ? String(Math.round(Number(event.target.value) * 100))
                        : null,
                    )
                  }
                />
              </div>
              <div>
                <label className="field-label" htmlFor="fundingCeilingScope">
                  Applies to
                </label>
                <select
                  id="fundingCeilingScope"
                  className="select"
                  value={values.policy.fundingCeilingScope ?? ''}
                  onChange={(event) =>
                    setPolicy(
                      'fundingCeilingScope',
                      (event.target.value ||
                        null) as ProgrammeCycleInput['policy']['fundingCeilingScope'],
                    )
                  }
                >
                  <option value="">Choose a scope</option>
                  <option value="APPLICATION">Each application</option>
                  <option value="PHASE">Each phase</option>
                  <option value="ENTERPRISE">Each enterprise</option>
                  <option value="FUNDING_CASE">The whole funding case</option>
                </select>
              </div>
            </>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="eyebrow">Required evidence</legend>
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          {values.policy.documentRules.map((rule, index) => (
            <div className="row" key={`${rule.documentType}-${index}`}>
              <select
                className="select"
                aria-label={`Document ${index + 1}`}
                value={rule.documentType}
                onChange={(event) =>
                  setPolicy(
                    'documentRules',
                    values.policy.documentRules.map((current, position) =>
                      position === index
                        ? {
                            ...current,
                            documentType: event.target.value as DocumentType,
                          }
                        : current,
                    ),
                  )
                }
              >
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {humanize(type)}
                  </option>
                ))}
              </select>
              <select
                className="select"
                aria-label={`Required when, for document ${index + 1}`}
                value={rule.condition}
                onChange={(event) =>
                  setPolicy(
                    'documentRules',
                    values.policy.documentRules.map((current, position) =>
                      position === index
                        ? {
                            ...current,
                            condition: event.target.value as ProgrammeDocumentCondition,
                          }
                        : current,
                    ),
                  )
                }
              >
                {DOCUMENT_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {humanize(condition)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                onClick={() =>
                  setPolicy(
                    'documentRules',
                    values.policy.documentRules.filter(
                      (_, position) => position !== index,
                    ),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="button"
              onClick={() =>
                setPolicy('documentRules', [
                  ...values.policy.documentRules,
                  { documentType: 'DPR', condition: 'ALWAYS' },
                ])
              }
            >
              Add a document
            </button>
          </div>
        </div>
      </fieldset>

      <details className="fieldset">
        <summary className="disclosure">
          <span className="eyebrow">Reason catalogue</span>
          <span className="muted">
            {values.policy.reasons.length} reasons, one for every administrative action
          </span>
        </summary>
        <p className="field-hint" style={{ margin: '0.75rem 0' }}>
          Every later administrative action — a revision, a rejection, a reversal — must
          choose a reason approved by this cycle. A cycle without them cannot be operated,
          so these are filled in for you and can be renamed.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Used for</th>
                <th scope="col">Code</th>
                <th scope="col">Label staff choose</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {values.policy.reasons.map((reason, index) => (
                <tr key={`${reason.context}-${reason.code}-${index}`}>
                  <td>{humanize(reason.context)}</td>
                  <td>
                    <input
                      className="input tabular"
                      aria-label={`Code for reason ${index + 1}`}
                      value={reason.code}
                      onChange={(event) =>
                        setPolicy(
                          'reasons',
                          values.policy.reasons.map((current, position) =>
                            position === index
                              ? { ...current, code: event.target.value }
                              : current,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      aria-label={`Label for reason ${index + 1}`}
                      value={reason.label}
                      onChange={(event) =>
                        setPolicy(
                          'reasons',
                          values.policy.reasons.map((current, position) =>
                            position === index
                              ? { ...current, label: event.target.value }
                              : current,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      data-variant="ghost"
                      onClick={() =>
                        setPolicy(
                          'reasons',
                          values.policy.reasons.filter(
                            (_, position) => position !== index,
                          ),
                        )
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

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
