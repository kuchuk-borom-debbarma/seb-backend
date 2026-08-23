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
  DeskReviewIdentifierKind,
  ApplicationSection,
  DeskReviewCheckResult,
  DeskReviewCheckType,
  DeskReviewOutcome,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import { useMarker } from '../guide/GuideContext'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from './officeGuidance'

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
    // The API refuses a pass or a fail here on an initial application, so the
    // rule is stated where the choice is made rather than left to be
    // discovered from a refusal after nine checks have been filled in.
    asks: 'For an expansion, the prior award has been used as required. Not applicable to an initial application.',
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
  identifiers: {
    kind: DeskReviewIdentifierKind
    value: string
    branchCode?: string | null
    matchedReason?: string | null
  }[]
}

/**
 * What the reviewer transcribes, and which check it is the evidence for.
 *
 * Passing a check means having read a document. The number on it is what turns
 * "I saw a valid certificate" into something the programme can later ask
 * questions about — chiefly whether the same one has been used before.
 *
 * Business registration is never demanded: an unregistered enterprise has none,
 * and requiring one would make somebody invent a number to get past the form.
 */
const TRANSCRIBE: {
  kind: DeskReviewIdentifierKind
  forCheck: DeskReviewCheckType | null
  label: string
  hint: string
  branch?: string
}[] = [
  {
    kind: 'ST_CERTIFICATE',
    forCheck: 'ST_ELIGIBILITY',
    label: 'Scheduled Tribe certificate number',
    hint: 'As printed on the certificate. Punctuation and case do not matter.',
  },
  {
    kind: 'IDENTITY_DOCUMENT',
    forCheck: 'IDENTITY_KYC',
    label: 'Identity document number',
    hint: 'Stored only as a one-way digest. Nobody, including you, can read it back.',
  },
  {
    kind: 'BANK_ACCOUNT',
    forCheck: 'DOCUMENT_COMPLETENESS',
    label: 'Bank account number',
    hint: 'With its branch code: the same account number at two banks is two accounts.',
    branch: 'Branch code (IFSC)',
  },
  {
    kind: 'BUSINESS_REGISTRATION',
    forCheck: null,
    label: 'Business registration number',
    hint: 'If the enterprise is registered. Leave blank if it is not.',
  },
]

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
  const [typed, setTyped] = useState<
    Partial<Record<DeskReviewIdentifierKind, { value: string; branchCode: string }>>
  >({})
  const [notSameClaim, setNotSameClaim] = useState('')
  const mark = useMarker()

  /*
   * Only what this review is actually attesting to. A check that is failed or
   * does not apply asks for nothing, so the field disappears rather than sitting
   * there greyed out.
   */
  const transcribing = TRANSCRIBE.filter(
    (entry) => entry.forCheck === null || results[entry.forCheck] === 'PASS',
  )
  const required = transcribing.filter((entry) => entry.forCheck !== null)

  /*
   * The server has already refused once because one of these numbers exists on
   * another file. It is a question rather than a verdict — the same promoter
   * legitimately returns for a later phase — so the answer appears only after
   * it has been asked.
   */
  const flagged = Boolean(error?.includes('already recorded against'))

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
    (outcome === 'ADVANCE_TO_BANK' || applicantMessage.trim().length > 0) &&
    required.every((entry) => {
      const entered = typed[entry.kind]
      return (
        (entered?.value.trim().length ?? 0) >= 4 &&
        (!entry.branch || (entered?.branchCode.trim().length ?? 0) >= 4)
      )
    }) &&
    (!flagged || notSameClaim.trim().length > 0)

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
      identifiers: transcribing
        .filter((entry) => typed[entry.kind]?.value.trim())
        .map((entry) => ({
          kind: entry.kind,
          value: typed[entry.kind]!.value.trim(),
          branchCode: entry.branch ? typed[entry.kind]!.branchCode.trim() : null,
          matchedReason: notSameClaim.trim() || null,
        })),
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
                    <div className="choice-row" data-compact>
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

      {/*
        Appears as checks are passed, because that is what it is evidence for.
        Sitting above the outcome puts it where the reviewer still has the
        documents open, rather than after they have decided.
      */}
      {transcribing.length > 0 ? (
        <fieldset
          className="fieldset"
          disabled={pending}
          style={{ marginTop: '1rem' }}
          {...mark('desk-review-identifiers')}
        >
          <div className="label-row">
            <legend className="eyebrow">What the documents say</legend>
            <Explain label="these numbers" opener="Why a passed check asks for a number">
              {OFFICE_HELP.transcribing}
            </Explain>
          </div>
          <p className="field-hint" style={{ marginBottom: '0.75rem' }}>
            Passing a check means you have read the document. Entering its number is what
            lets the programme notice if the same one is used twice.
          </p>

          <div className="stack">
            {transcribing.map((entry) => (
              <div key={entry.kind} className={entry.branch ? 'detail-grid' : undefined}>
                <div>
                  <label className="field-label" htmlFor={`id-${entry.kind}`}>
                    {entry.label}
                    {entry.forCheck === null ? ' (if there is one)' : ''}
                  </label>
                  <input
                    id={`id-${entry.kind}`}
                    className="input"
                    value={typed[entry.kind]?.value ?? ''}
                    onChange={(event) =>
                      setTyped((was) => ({
                        ...was,
                        [entry.kind]: {
                          branchCode: was[entry.kind]?.branchCode ?? '',
                          value: event.target.value,
                        },
                      }))
                    }
                  />
                  <p className="field-hint">{entry.hint}</p>
                </div>
                {entry.branch ? (
                  <div>
                    <label className="field-label" htmlFor={`branch-${entry.kind}`}>
                      {entry.branch}
                    </label>
                    <input
                      id={`branch-${entry.kind}`}
                      className="input"
                      value={typed[entry.kind]?.branchCode ?? ''}
                      onChange={(event) =>
                        setTyped((was) => ({
                          ...was,
                          [entry.kind]: {
                            value: was[entry.kind]?.value ?? '',
                            branchCode: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ))}

            {flagged ? (
              <div>
                <label className="field-label" htmlFor="not-same-claim">
                  Why this is not the same claim
                </label>
                <textarea
                  id="not-same-claim"
                  className="input"
                  rows={2}
                  value={notSameClaim}
                  onChange={(event) => setNotSameClaim(event.target.value)}
                />
                <p className="field-hint">
                  A number appearing twice is not proof of anything — the same promoter
                  returns for a later phase. Say what this is, and it is kept beside the
                  number that raised it.
                </p>
              </div>
            ) : null}
          </div>
        </fieldset>
      ) : null}

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
