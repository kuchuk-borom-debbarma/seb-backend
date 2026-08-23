/**
 * Completing a desk review.
 *
 * A review is a fixed list of checks, each passed, failed or not applicable,
 * followed by one of three outcomes. The API accepts the checks and the outcome
 * together, so this is one form and one write rather than a wizard that could
 * be abandoned half-recorded.
 *
 * Requesting a revision is the only outcome that names sections. Each section
 * named becomes a correction request the applicant must answer, and only those
 * sections unlock for them — so what is chosen here decides exactly what they
 * are allowed to change.
 */
import { useMemo, useState } from 'react'
import { reasonsFor, type ReasonCategory } from '#/features/admin/workspaceQueries'
import { SECTION_TITLES } from '#/features/application/draft'
import type {
  ApplicationSection,
  DeskReviewCheckResult,
  DeskReviewCheckType,
  DeskReviewOutcome,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'

/** The checks the API defines, in the order a reviewer works through them. */
const CHECKS: { type: DeskReviewCheckType; title: string; asks: string }[] = [
  {
    type: 'IDENTITY_KYC',
    title: 'Identity',
    asks: 'The identity and age documents match the person named.',
  },
  {
    type: 'ST_ELIGIBILITY',
    title: 'Scheduled Tribe eligibility',
    asks: 'The certificate is valid and belongs to the applicant.',
  },
  {
    type: 'MAJORITY_OWNERSHIP',
    title: 'Majority ownership',
    asks: 'Scheduled Tribe members hold the majority of the enterprise.',
  },
  {
    type: 'JURISDICTION',
    title: 'Jurisdiction',
    asks: 'The business address falls inside the programme area.',
  },
  {
    type: 'FORM_COMPLETENESS',
    title: 'Form completeness',
    asks: 'Every answer needed is present and internally consistent.',
  },
  {
    type: 'DOCUMENT_COMPLETENESS',
    title: 'Document completeness',
    asks: 'Every required document is attached and legible.',
  },
  {
    type: 'ANSWER_DOCUMENT_CONSISTENCY',
    title: 'Answers against documents',
    asks: 'The answers agree with what the documents show.',
  },
  {
    type: 'DPR_FEASIBILITY',
    title: 'Project report',
    asks: 'The costs and the plan are credible for this enterprise.',
  },
  {
    type: 'EXPANSION_EVIDENCE',
    title: 'Expansion evidence',
    asks: 'For an expansion, the prior award has been used as required.',
  },
]

const RESULTS: { value: DeskReviewCheckResult; label: string }[] = [
  { value: 'PASS', label: 'Pass' },
  { value: 'FAIL', label: 'Fail' },
  { value: 'NOT_APPLICABLE', label: 'N/A' },
]

const OUTCOMES: { value: DeskReviewOutcome; label: string; means: string }[] = [
  {
    value: 'ADVANCE_TO_BANK',
    label: 'Refer to a partner bank',
    means: 'The application passes desk review and moves on for bank evaluation.',
  },
  {
    value: 'REQUEST_REVISION',
    label: 'Ask the applicant to correct it',
    means:
      'The sections you name unlock for the applicant. Nothing else can be changed, and the application returns to you when they resubmit.',
  },
  {
    value: 'REJECT',
    label: 'Reject',
    means: 'The application is closed without funding. This cannot be undone.',
  },
]

/** The sections an applicant can be asked to correct. */
const REVISABLE: ApplicationSection[] = [
  'ENTERPRISE',
  'APPLICANT_PROFILE',
  'FINANCIAL',
  'PRIOR_FUNDING',
  'DOCUMENTS',
  'DECLARATION',
]

export type DeskReviewDraft = {
  outcome: DeskReviewOutcome
  checks: {
    checkType: DeskReviewCheckType
    result: DeskReviewCheckResult
    internalNote?: string | null
  }[]
  reasonCategoryId?: string | null
  applicantMessage?: string | null
  revisions: {
    section: ApplicationSection
    reasonCategoryId: string
    note: string
  }[]
}

export function DeskReviewForm({
  reasons,
  pending,
  error,
  onSubmit,
}: {
  reasons: ReasonCategory[] | undefined
  pending: boolean
  error: string | null
  onSubmit: (draft: DeskReviewDraft) => void
}) {
  const [results, setResults] = useState<
    Partial<Record<DeskReviewCheckType, DeskReviewCheckResult>>
  >({})
  const [notes, setNotes] = useState<Partial<Record<DeskReviewCheckType, string>>>({})
  const [outcome, setOutcome] = useState<DeskReviewOutcome | ''>('')
  const [applicantMessage, setApplicantMessage] = useState('')
  const [rejectionReasonId, setRejectionReasonId] = useState('')
  const [revisions, setRevisions] = useState<
    Partial<Record<ApplicationSection, { reasonCategoryId: string; note: string }>>
  >({})

  const revisionReasons = useMemo(() => reasonsFor(reasons, 'REVISION'), [reasons])
  const rejectionReasons = useMemo(() => reasonsFor(reasons, 'REJECTION'), [reasons])

  const chosen = Object.entries(revisions) as [
    ApplicationSection,
    { reasonCategoryId: string; note: string },
  ][]

  /*
   * What the API will accept. Stated here so the button is disabled rather than
   * the write refused — the reviewer should not have to read a rule back from
   * an error message they could have been shown first.
   */
  const everyCheckAnswered = CHECKS.every((check) => results[check.type])
  const ready =
    Boolean(outcome) &&
    everyCheckAnswered &&
    (outcome !== 'REQUEST_REVISION' ||
      (chosen.length > 0 &&
        chosen.every(([, value]) => value.reasonCategoryId && value.note.trim()))) &&
    (outcome !== 'REJECT' || Boolean(rejectionReasonId)) &&
    (outcome === 'ADVANCE_TO_BANK' || applicantMessage.trim().length > 0)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready || outcome === '') return
    onSubmit({
      outcome,
      checks: CHECKS.map((check) => ({
        checkType: check.type,
        result: results[check.type] as DeskReviewCheckResult,
        internalNote: notes[check.type]?.trim() || null,
      })),
      reasonCategoryId: outcome === 'REJECT' ? rejectionReasonId : null,
      applicantMessage: applicantMessage.trim() || null,
      revisions:
        outcome === 'REQUEST_REVISION'
          ? chosen.map(([section, value]) => ({
              section,
              reasonCategoryId: value.reasonCategoryId,
              note: value.note.trim(),
            }))
          : [],
    })
  }

  return (
    <form onSubmit={submit}>
      <fieldset className="fieldset" disabled={pending}>
        <legend className="eyebrow">Checks</legend>
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Desk review checks</caption>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Result</th>
                <th scope="col">Internal note</th>
              </tr>
            </thead>
            <tbody>
              {CHECKS.map((check) => (
                <tr key={check.type}>
                  <td>
                    <span style={{ fontWeight: 500 }}>{check.title}</span>
                    <span className="field-hint">{check.asks}</span>
                  </td>
                  <td>
                    <div className="choice-row">
                      {RESULTS.map((result) => (
                        <label className="choice" key={result.value}>
                          <input
                            type="radio"
                            name={check.type}
                            checked={results[check.type] === result.value}
                            onChange={() =>
                              setResults((previous) => ({
                                ...previous,
                                [check.type]: result.value,
                              }))
                            }
                          />
                          {result.label}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <input
                      className="input"
                      aria-label={`Internal note for ${check.title}`}
                      value={notes[check.type] ?? ''}
                      onChange={(event) =>
                        setNotes((previous) => ({
                          ...previous,
                          [check.type]: event.target.value,
                        }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Said once, under the table, rather than nine times beside it. */}
        <p className="field-hint" style={{ marginTop: '0.75rem' }}>
          Internal notes stay inside the programme office. The applicant never sees them.
        </p>
      </fieldset>

      <fieldset className="fieldset" disabled={pending} style={{ marginTop: '1rem' }}>
        <legend className="eyebrow">Outcome</legend>
        <div className="stack">
          {OUTCOMES.map((option) => (
            <label className="choice-block" key={option.value}>
              <input
                type="radio"
                name="outcome"
                checked={outcome === option.value}
                onChange={() => setOutcome(option.value)}
              />
              <span>
                <span style={{ fontWeight: 500 }}>{option.label}</span>
                <span className="field-hint">{option.means}</span>
              </span>
            </label>
          ))}
        </div>

        {outcome === 'REQUEST_REVISION' ? (
          <div style={{ marginTop: '1rem' }}>
            <p className="field-label">Sections the applicant must correct</p>
            <div className="stack">
              {REVISABLE.map((section) => {
                const value = revisions[section]
                return (
                  <div className="card" key={section}>
                    <div className="card-body">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={Boolean(value)}
                          onChange={(event) =>
                            setRevisions((previous) => {
                              const next = { ...previous }
                              if (event.target.checked) {
                                next[section] = {
                                  reasonCategoryId: '',
                                  note: '',
                                }
                              } else {
                                delete next[section]
                              }
                              return next
                            })
                          }
                        />
                        {SECTION_TITLES[section]}
                      </label>

                      {value ? (
                        <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
                          <div>
                            <label className="field-label" htmlFor={`${section}-reason`}>
                              Reason
                            </label>
                            <select
                              id={`${section}-reason`}
                              className="select"
                              value={value.reasonCategoryId}
                              onChange={(event) =>
                                setRevisions((previous) => ({
                                  ...previous,
                                  [section]: {
                                    ...value,
                                    reasonCategoryId: event.target.value,
                                  },
                                }))
                              }
                            >
                              <option value="">Choose a reason</option>
                              {revisionReasons.map((reason) => (
                                <option key={reason.id} value={reason.id}>
                                  {reason.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div style={{ gridColumn: '2 / -1' }}>
                            <label className="field-label" htmlFor={`${section}-note`}>
                              What the applicant must do
                            </label>
                            <textarea
                              id={`${section}-note`}
                              className="textarea"
                              rows={2}
                              value={value.note}
                              onChange={(event) =>
                                setRevisions((previous) => ({
                                  ...previous,
                                  [section]: {
                                    ...value,
                                    note: event.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
            {revisionReasons.length === 0 ? (
              <p className="notice" data-tone="warn" style={{ marginTop: '0.75rem' }}>
                <span className="notice-title">This cycle has no revision reasons</span>A
                correction request must name a reason from the cycle's catalogue. Add one
                in cycle administration first.
              </p>
            ) : null}
          </div>
        ) : null}

        {outcome === 'REJECT' ? (
          <div style={{ marginTop: '1rem' }}>
            <label className="field-label" htmlFor="rejection-reason">
              Reason for rejection
            </label>
            <select
              id="rejection-reason"
              className="select"
              value={rejectionReasonId}
              onChange={(event) => setRejectionReasonId(event.target.value)}
            >
              <option value="">Choose a reason</option>
              {rejectionReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {outcome && outcome !== 'ADVANCE_TO_BANK' ? (
          <div style={{ marginTop: '1rem' }}>
            <label className="field-label" htmlFor="applicant-message">
              Message to the applicant
            </label>
            <textarea
              id="applicant-message"
              className="textarea"
              rows={3}
              value={applicantMessage}
              onChange={(event) => setApplicantMessage(event.target.value)}
            />
            <span className="field-hint">
              This is shown to the applicant, so write it to them.
            </span>
          </div>
        ) : null}
      </fieldset>

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '1rem' }}
        >
          {error}
        </p>
      ) : null}

      <div className="row" style={{ marginTop: '1rem' }}>
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={!ready || pending}
        >
          {pending ? 'Recording…' : 'Complete the review'}
        </button>
        {!everyCheckAnswered ? (
          <span className="field-hint">Every check needs a result.</span>
        ) : null}
      </div>
    </form>
  )
}

/** Names a check in the record of a review that has already been completed. */
export const checkTitle = (checkType: string): string =>
  CHECKS.find((check) => check.type === checkType)?.title ?? humanize(checkType)
