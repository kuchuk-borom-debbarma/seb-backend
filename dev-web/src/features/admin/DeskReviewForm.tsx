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
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  X,
} from 'lucide-react'
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
import styles from './DeskReviewForm.module.css'

/** The checks the API defines, in the order a reviewer works through them. */
export const CHECKS: { type: DeskReviewCheckType; title: string; asks: string }[] = [
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
  /** Null unless the reviewer is the applicant, where it must be true. */
  conflictAcknowledged?: boolean | null
}

/** How each identifier is presented. Copy, not policy. */
const IDENTIFIER_PRESENTATION: Record<
  DeskReviewIdentifierKind,
  { label: string; hint: string; branch?: string }
> = {
  ST_CERTIFICATE: {
    label: 'Scheduled Tribe certificate number',
    hint: 'As printed on the certificate. Punctuation and case do not matter.',
  },
  IDENTITY_DOCUMENT: {
    label: 'Identity document number',
    hint: 'Stored only as a one-way digest. Nobody, including you, can read it back.',
  },
  BANK_ACCOUNT: {
    label: 'Bank account number',
    hint: 'With its branch code: the same account number at two banks is two accounts.',
    branch: 'Branch code (IFSC)',
  },
  BUSINESS_REGISTRATION: {
    label: 'Business registration number',
    hint: 'If the enterprise is registered. Leave blank if it is not.',
  },
}

/** One cycle's rule for one identifier, frozen with the submission. */
export type IdentifierRule = {
  kind: DeskReviewIdentifierKind
  requirement: 'REQUIRED_ON_PASS' | 'OPTIONAL' | 'OFF'
  duplicatePolicy: 'CHECKED' | 'NOT_CHECKED'
  checkType: DeskReviewCheckType | null
}

export function DeskReviewForm({
  reasons,
  rules,
  reviewingOwnApplication,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  reasons: ReasonCategory[] | undefined
  /** The cycle's identifier rules, frozen with the submission under review. */
  rules: IdentifierRule[]
  reviewingOwnApplication: boolean
  pending: boolean
  error: string | null
  onSubmit: (draft: DeskReviewDraft) => void
  onCancel?: () => void
}) {
  const mark = useMarker()
  const [activeTab, setActiveTab] = useState<'checks' | 'documents' | 'outcome'>('checks')
  const [results, setResults] = useState<
    Partial<Record<DeskReviewCheckType, DeskReviewCheckResult>>
  >({})
  const [notes, setNotes] = useState<Partial<Record<DeskReviewCheckType, string>>>({})
  const [outcome, setOutcome] = useState<DeskReviewOutcome | ''>('')
  const [rejectionReasonId, setRejectionReasonId] = useState('')
  const [applicantMessage, setApplicantMessage] = useState('')
  const [revisions, setRevisions] = useState<
    Partial<Record<ApplicationSection, { reasonCategoryId: string; note: string }>>
  >({})
  const [typed, setTyped] = useState<
    Partial<Record<DeskReviewIdentifierKind, { value: string; branchCode: string }>>
  >({})
  const [notSameClaim, setNotSameClaim] = useState('')
  const [conflictAcknowledged, setConflictAcknowledged] = useState(false)

  const transcribing = rules
    .filter((rule) => rule.requirement !== 'OFF')
    .filter((rule) => rule.checkType === null || results[rule.checkType] === 'PASS')
    .map((rule) => ({ ...rule, ...IDENTIFIER_PRESENTATION[rule.kind] }))

  const required = transcribing.filter(
    (entry) => entry.requirement === 'REQUIRED_ON_PASS' && entry.checkType !== null,
  )

  const flagged = Boolean(error?.includes('already recorded against'))

  const revisionReasons = useMemo(() => reasonsFor(reasons, 'REVISION'), [reasons])
  const rejectionReasons = useMemo(() => reasonsFor(reasons, 'REJECTION'), [reasons])

  const chosen = Object.entries(revisions) as [
    ApplicationSection,
    { reasonCategoryId: string; note: string },
  ][]

  const answeredChecksCount = CHECKS.filter((check) => Boolean(results[check.type])).length
  const everyCheckAnswered = answeredChecksCount === CHECKS.length

  const requiredCount = required.length
  const filledRequiredCount = required.filter((entry) => {
    const entered = typed[entry.kind]
    return (
      (entered?.value.trim().length ?? 0) >= 4 &&
      (!entry.branch || (entered?.branchCode.trim().length ?? 0) >= 4)
    )
  }).length

  const docsComplete = transcribing.length === 0 || filledRequiredCount === requiredCount

  const outcomeComplete =
    Boolean(outcome) &&
    (outcome !== 'REQUEST_REVISION' ||
      (chosen.length > 0 &&
        chosen.every(([, value]) => Boolean(value.reasonCategoryId) && Boolean(value.note.trim())))) &&
    (outcome !== 'REJECT' || Boolean(rejectionReasonId)) &&
    (outcome === 'ADVANCE_TO_BANK' || applicantMessage.trim().length > 0) &&
    (!reviewingOwnApplication || conflictAcknowledged)

  const ready =
    Boolean(outcome) &&
    everyCheckAnswered &&
    (outcome !== 'REQUEST_REVISION' ||
      (chosen.length > 0 &&
        chosen.every(([, value]) => Boolean(value.reasonCategoryId) && Boolean(value.note.trim())))) &&
    (outcome !== 'REJECT' || Boolean(rejectionReasonId)) &&
    (outcome === 'ADVANCE_TO_BANK' || applicantMessage.trim().length > 0) &&
    required.every((entry) => {
      const entered = typed[entry.kind]
      return (
        (entered?.value.trim().length ?? 0) >= 4 &&
        (!entry.branch || (entered?.branchCode.trim().length ?? 0) >= 4)
      )
    }) &&
    (!reviewingOwnApplication || conflictAcknowledged)

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
      reasonCategoryId:
        outcome === 'REJECT'
          ? rejectionReasonId
          : outcome === 'REQUEST_REVISION'
            ? (chosen[0]?.[1].reasonCategoryId ?? null)
            : null,
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
      conflictAcknowledged: reviewingOwnApplication ? conflictAcknowledged : null,
    })
  }

  return (
    <form className={styles.formWrap} onSubmit={submit}>
      {/* Top Tab Navigation */}
      <div className={styles.tabNav} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'checks'}
          className={styles.tabButton}
          data-active={activeTab === 'checks' ? 'true' : undefined}
          onClick={() => setActiveTab('checks')}
        >
          {everyCheckAnswered ? (
            <div className={styles.tabCompleteBadge}>
              <Check size={12} aria-hidden="true" />
            </div>
          ) : (
            <div className={styles.tabIconBadge}>1</div>
          )}
          <span className={styles.tabLabel}>Checks</span>
          <span
            className={styles.tabCounter}
            data-complete={everyCheckAnswered ? 'true' : undefined}
          >
            {answeredChecksCount}/{CHECKS.length}
          </span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'documents'}
          className={styles.tabButton}
          data-active={activeTab === 'documents' ? 'true' : undefined}
          onClick={() => setActiveTab('documents')}
        >
          {docsComplete ? (
            <div className={styles.tabCompleteBadge}>
              <Check size={12} aria-hidden="true" />
            </div>
          ) : (
            <div className={styles.tabIconBadge}>2</div>
          )}
          <span className={styles.tabLabel}>What documents say</span>
          {transcribing.length > 0 ? (
            <span
              className={styles.tabCounter}
              data-complete={docsComplete ? 'true' : undefined}
            >
              {filledRequiredCount}/{requiredCount}
            </span>
          ) : (
            <span className={styles.tabSubtleText}>None</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'outcome'}
          className={styles.tabButton}
          data-active={activeTab === 'outcome' ? 'true' : undefined}
          onClick={() => setActiveTab('outcome')}
        >
          {outcomeComplete ? (
            <div className={styles.tabCompleteBadge}>
              <Check size={12} aria-hidden="true" />
            </div>
          ) : (
            <div className={styles.tabIconBadge}>3</div>
          )}
          <span className={styles.tabLabel}>Outcome</span>
          {outcome ? (
            <span className={styles.tabCounter} data-complete="true">
              {outcome === 'ADVANCE_TO_BANK'
                ? 'Bank'
                : outcome === 'REJECT'
                  ? 'Reject'
                  : 'Revision'}
            </span>
          ) : null}
        </button>
      </div>

      {/* Tab 1: Checks */}
      {activeTab === 'checks' && (
        <div className={styles.tabPane}>
          <fieldset className={styles.fieldset} disabled={pending}>
            <div className={styles.sectionHeader}>
              <legend className={styles.sectionEyebrow}>Eligibility & verification checks</legend>
            </div>
            <div className={styles.checksCard}>
              {CHECKS.map((check) => (
                <div key={check.type} className={styles.checkRow}>
                  <div className={styles.checkInfo}>
                    <span className={styles.checkTitle}>{check.title}</span>
                    <span className={styles.checkAsks}>{check.asks}</span>
                  </div>
                  <div className={styles.checkControls}>
                    <div className={styles.resultGroup}>
                      {RESULTS.map((result) => {
                        const isSelected = results[check.type] === result.value
                        const tone =
                          result.value === 'PASS'
                            ? 'pass'
                            : result.value === 'FAIL'
                              ? 'fail'
                              : 'na'
                        return (
                          <label
                            className={styles.resultPill}
                            key={result.value}
                            data-selected={isSelected ? 'true' : undefined}
                            data-tone={tone}
                          >
                            <input
                              type="radio"
                              name={check.type}
                              checked={isSelected}
                              onChange={() =>
                                setResults((previous) => ({
                                  ...previous,
                                  [check.type]: result.value,
                                }))
                              }
                            />
                            {result.label}
                          </label>
                        )
                      })}
                    </div>
                    <input
                      className={styles.noteInput}
                      placeholder="Note (optional)"
                      aria-label={`Internal note for ${check.title}`}
                      value={notes[check.type] ?? ''}
                      onChange={(event) =>
                        setNotes((previous) => ({
                          ...previous,
                          [check.type]: event.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className={styles.hintBox}>
              Internal notes stay inside the programme office. The applicant never sees them.
            </p>
          </fieldset>

          <div className={styles.tabStepNavRow}>
            <button
              type="button"
              className={styles.nextTabButton}
              onClick={() => setActiveTab('documents')}
            >
              Next: What documents say
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Tab 2: What documents say */}
      {activeTab === 'documents' && (
        <div className={styles.tabPane}>
          {transcribing.length > 0 ? (
            <fieldset
              className={styles.fieldset}
              disabled={pending}
              {...mark('desk-review-identifiers')}
            >
              <div className={styles.sectionHeader}>
                <legend className={styles.sectionEyebrow}>Transcribed identifiers</legend>
                <Explain label="these numbers" opener="Why a passed check asks for a number">
                  {OFFICE_HELP.transcribing}
                </Explain>
              </div>
              <div className={styles.identifiersBox}>
                <p className={styles.hintBox} style={{ margin: 0 }}>
                  Passing a check means you have read the document. Entering its number is what
                  lets the programme notice if the same one is used twice.
                </p>

                <div className="stack">
                  {transcribing.map((entry) => (
                    <div key={entry.kind} className={entry.branch ? 'detail-grid' : undefined}>
                      <div>
                        <label className="field-label" htmlFor={`id-${entry.kind}`}>
                          {entry.label}
                          {entry.requirement === 'OPTIONAL' ? ' (if there is one)' : ''}
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
              </div>
            </fieldset>
          ) : (
            <div className={styles.identifiersBox}>
              <p className={styles.hintBox} style={{ margin: 0 }}>
                No identifiers need to be transcribed based on the current checks and cycle rules.
              </p>
            </div>
          )}

          <div className={styles.tabStepNavRow}>
            <button
              type="button"
              className={styles.prevTabButton}
              onClick={() => setActiveTab('checks')}
            >
              <ChevronLeft size={15} aria-hidden="true" />
              Back to checks
            </button>
            <button
              type="button"
              className={styles.nextTabButton}
              onClick={() => setActiveTab('outcome')}
            >
              Next: Outcome
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Tab 3: Outcome */}
      {activeTab === 'outcome' && (
        <div className={styles.tabPane}>
          <fieldset className={styles.fieldset} disabled={pending}>
            <div className={styles.sectionHeader}>
              <legend className={styles.sectionEyebrow}>Decision & next stage</legend>
            </div>
            <div className={styles.outcomesList}>
              {OUTCOMES.map((option) => (
                <label
                  className={styles.outcomeChoice}
                  key={option.value}
                  data-selected={outcome === option.value ? 'true' : undefined}
                >
                  <input
                    type="radio"
                    name="outcome"
                    style={{ marginTop: '3px' }}
                    checked={outcome === option.value}
                    onChange={() => setOutcome(option.value)}
                  />
                  <div className={styles.outcomeChoiceText}>
                    <span className={styles.outcomeTitle}>{option.label}</span>
                    <span className={styles.outcomeMeans}>{option.means}</span>
                  </div>
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

          {reviewingOwnApplication ? (
            <p className="notice" style={{ marginTop: '0.5rem' }}>
              <span className="notice-title">This is your own application</span>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={conflictAcknowledged}
                  onChange={(event) => setConflictAcknowledged(event.target.checked)}
                />
                I am reviewing an application I submitted, and I am recording that.
              </label>
            </p>
          ) : null}

          <div className={styles.tabStepNavRow}>
            <button
              type="button"
              className={styles.prevTabButton}
              onClick={() => setActiveTab('documents')}
            >
              <ChevronLeft size={15} aria-hidden="true" />
              Back to documents
            </button>
          </div>
        </div>
      )}

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ margin: 0 }}
        >
          {error}
        </p>
      ) : null}

      <div className={styles.submitRow}>
        {!everyCheckAnswered ? (
          <span className="field-hint">
            Checks incomplete ({answeredChecksCount}/{CHECKS.length}).
          </span>
        ) : !docsComplete ? (
          <span className="field-hint">Document numbers incomplete.</span>
        ) : !outcome ? (
          <span className="field-hint">Choose an outcome to finish.</span>
        ) : (
          <span />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {onCancel ? (
            <button
              type="button"
              className={styles.cancelButton}
              onClick={onCancel}
              disabled={pending}
            >
              Cancel
            </button>
          ) : null}
          <button
            type="submit"
            className={styles.completeButton}
            disabled={!ready || pending}
          >
            {pending ? 'Recording…' : 'Complete the review'}
          </button>
        </div>
      </div>
    </form>
  )
}

/**
 * Dedicated Desk Review Modal Dialog.
 */
export function DeskReviewModal({
  open,
  onClose,
  hasReview,
  ...formProps
}: {
  open: boolean
  onClose: () => void
  hasReview: boolean
} & Parameters<typeof DeskReviewForm>[0]) {
  if (!open) return null

  return (
    <div
      className={styles.modalOverlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="desk-review-modal-title"
    >
      <div className={styles.modalDialog}>
        <div className={styles.modalHeader}>
          <div className={styles.modalHeaderLeft}>
            <div className={styles.modalHeaderIcon}>
              <ClipboardCheck size={20} aria-hidden="true" />
            </div>
            <div>
              <h2 id="desk-review-modal-title" className={styles.modalTitle}>
                {hasReview ? 'Record another desk review' : 'Complete desk review'}
              </h2>
              <p className={styles.modalSubtitle}>
                Nine eligibility checks, transcribed identifiers, and final outcome.
              </p>
            </div>
          </div>
          <button
            type="button"
            className={styles.modalCloseButton}
            onClick={onClose}
            aria-label="Close modal"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.modalBody}>
          <p className="muted" style={{ fontSize: '13px', margin: 0 }}>
            The nine checks and the outcome are recorded together, in one write — so a
            review cannot be left half-saved. Closing this leaves the application exactly
            where it is.
          </p>

          <DeskReviewForm {...formProps} onCancel={onClose} />
        </div>
      </div>
    </div>
  )
}

/** Names a check in the record of a review that has already been completed. */
export const checkTitle = (checkType: string): string =>
  CHECKS.find((check) => check.type === checkType)?.title ?? humanize(checkType)
