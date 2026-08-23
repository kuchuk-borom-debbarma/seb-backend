/**
 * The partner bank stage.
 *
 * Nothing here is a decision made in this interface. A bank evaluates the
 * proposal and writes back; the programme office records what it said. That is
 * why every form asks for the reference and date of the bank's own document —
 * the record has to point at something that exists outside this system.
 *
 * An outcome is never edited. A correction supersedes the outcome it replaces
 * and both are kept, because what the bank first said and when the office
 * learned otherwise are both part of the file.
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { reasonsFor, type ReasonCategory } from '#/features/admin/workspaceQueries'
import { SECTION_TITLES } from '#/features/application/draft'
import {
  CancelBankReferralDocument,
  CorrectBankOutcomeDocument,
  RecordBankOutcomeDocument,
  ReferToBankDocument,
} from '#/graphql/generated/operations'
import type { ApplicationSection, BankOutcome } from '#/graphql/generated/schema'
import { REFERRAL_STATES, REFERRAL_TITLES } from '#/features/admin/states'
import { formatDate, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from './officeGuidance'
import { useMarker } from '../guide/GuideContext'

type Referral = {
  id: string
  bankName: string
  bankBranch?: string | null
  referralReference: string
  referralDate: string
  status: string
  currentVersion: number
}

type Outcome = {
  id: string
  outcome: BankOutcome
  decisionReference: string
  decisionDate: string
  applicantSummary: string
  createdAt: string
}

const OUTCOMES: { value: BankOutcome; label: string; means: string }[] = [
  {
    value: 'RECOMMENDED',
    label: 'Recommended',
    means: 'The bank supports the proposal. The application goes to the committee.',
  },
  {
    value: 'NOT_RECOMMENDED',
    label: 'Not recommended',
    means: 'The bank does not support it. The application goes to the committee anyway.',
  },
  {
    value: 'MORE_INFORMATION_REQUIRED',
    label: 'More information needed',
    means:
      'The bank cannot decide yet. Name the sections the applicant must correct; the application returns to them.',
  },
]

const REVISABLE: ApplicationSection[] = [
  'ENTERPRISE',
  'APPLICANT_PROFILE',
  'FINANCIAL',
  'PRIOR_FUNDING',
  'DOCUMENTS',
  'DECLARATION',
]

export function BankStage({
  applicationId,
  status,
  statusVersion,
  latestSubmissionId,
  latestDeskReviewId,
  referrals,
  outcomes,
  reasons,
  onChanged,
}: {
  applicationId: string
  status: string
  statusVersion: number
  latestSubmissionId: string | undefined
  latestDeskReviewId: string | undefined
  referrals: Referral[]
  outcomes: Outcome[]
  reasons: ReasonCategory[] | undefined
  onChanged: () => Promise<unknown>
}) {
  /*
   * The referral the office is currently dealing with: awaiting an answer, or
   * answered. A withdrawn one is history. A referral does not disappear when
   * the bank replies — it becomes RESPONDED — and its outcome can still be
   * corrected, so both states matter here.
   */
  const mark = useMarker()
  const current = referrals.find(
    (referral) =>
      referral.status === REFERRAL_STATES.open ||
      referral.status === REFERRAL_STATES.responded,
  )
  const awaiting = current?.status === REFERRAL_STATES.open
  const latestOutcome = outcomes.at(-1)

  if (referrals.length === 0 && status !== 'PARTNER_BANK_EVALUATION') {
    // Referral is only reachable from a completed desk review, and the desk
    // review card already offers that. Nothing to show yet.
    return null
  }

  return (
    <section className="card" {...mark('bank-stage')}>
      <div className="card-header">
        <div className="label-row">
          <p className="eyebrow">Partner bank</p>
          <Explain label="the bank's outcome" opener="How a bank outcome is recorded">
            {OFFICE_HELP.bankOutcome}
          </Explain>
        </div>
        {current ? (
          <span className="badge">{REFERRAL_TITLES[current.status]}</span>
        ) : null}
      </div>

      {referrals.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Referrals to a partner bank</caption>
            <thead>
              <tr>
                <th scope="col">Bank</th>
                <th scope="col">Referral</th>
                <th scope="col">Sent</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((referral) => (
                <tr
                  key={referral.id}
                  className={referral.id === current?.id ? undefined : 'muted'}
                >
                  <td>
                    {referral.bankName}
                    {referral.bankBranch ? (
                      <span className="field-hint">{referral.bankBranch}</span>
                    ) : null}
                  </td>
                  <td className="tabular">{referral.referralReference}</td>
                  <td>{formatDate(referral.referralDate)}</td>
                  <td>{REFERRAL_TITLES[referral.status] ?? humanize(referral.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {outcomes.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">What the bank said</caption>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Decision</th>
                <th scope="col">Dated</th>
                <th scope="col">What the applicant was told</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((outcome) => (
                <tr
                  key={outcome.id}
                  // Only the last outcome stands; the ones before it were
                  // superseded by a correction and are kept as record.
                  className={outcome.id === latestOutcome?.id ? undefined : 'muted'}
                >
                  <td>
                    {humanize(outcome.outcome)}
                    {outcome.id === latestOutcome?.id ? null : (
                      <span className="field-hint">Superseded</span>
                    )}
                  </td>
                  <td className="tabular">{outcome.decisionReference}</td>
                  <td>{formatDate(outcome.decisionDate)}</td>
                  <td>{outcome.applicantSummary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card-body">
        {current && awaiting ? (
          <OutcomeForm
            title="Record what the bank said"
            confirmLabel="Record the outcome"
            reasons={reasons}
            onSubmit={async (draft) => {
              const data = await gql(RecordBankOutcomeDocument, {
                input: {
                  applicationId,
                  referralId: current.id,
                  expectedStatusVersion: statusVersion,
                  expectedReferralVersion: current.currentVersion,
                  ...draft,
                },
              })
              unwrap(data.admin.decision.recordBankOutcome)
              await onChanged()
            }}
          />
        ) : null}

        {current && latestOutcome ? (
          <CorrectOutcome
            applicationId={applicationId}
            referralId={current.id}
            supersedesOutcomeId={latestOutcome.id}
            statusVersion={statusVersion}
            reasons={reasons}
            onChanged={onChanged}
          />
        ) : null}

        {current && awaiting ? (
          <CancelReferral
            applicationId={applicationId}
            referral={current}
            reasons={reasons}
            onChanged={onChanged}
          />
        ) : null}

        {/* The referral form itself belongs with the desk review that
            authorizes it, so it is only offered when both are in hand. */}
        {referrals.length === 0 && latestSubmissionId && latestDeskReviewId ? (
          <ReferralForm
            applicationId={applicationId}
            submissionId={latestSubmissionId}
            deskReviewId={latestDeskReviewId}
            statusVersion={statusVersion}
            onChanged={onChanged}
          />
        ) : null}
      </div>
    </section>
  )
}

function ReferralForm({
  applicationId,
  submissionId,
  deskReviewId,
  statusVersion,
  onChanged,
}: {
  applicationId: string
  submissionId: string
  deskReviewId: string
  statusVersion: number
  onChanged: () => Promise<unknown>
}) {
  const [bankName, setBankName] = useState('')
  const [bankBranch, setBankBranch] = useState('')
  const [referralReference, setReferralReference] = useState('')
  const [referralDate, setReferralDate] = useState('')
  const [applicantMessage, setApplicantMessage] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refer = useMutation({
    mutationFn: async () => {
      const data = await gql(ReferToBankDocument, {
        input: {
          applicationId,
          submissionId,
          deskReviewId,
          expectedStatusVersion: statusVersion,
          bankName: bankName.trim(),
          bankBranch: bankBranch.trim() || null,
          referralReference: referralReference.trim(),
          referralDate,
          applicantMessage: applicantMessage.trim(),
          internalNote: internalNote.trim() || null,
        },
      })
      unwrap(data.admin.decision.referToBank)
    },
    onMutate: () => setError(null),
    onSuccess: onChanged,
    onError: (cause) => setError(messageFor(cause)),
  })

  const ready =
    bankName.trim() && referralReference.trim() && referralDate && applicantMessage.trim()

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        refer.mutate()
      }}
    >
      <h4>Refer to a partner bank</h4>
      <p className="field-hint">
        The bank evaluates the proposal and writes back. The applicant is told this has
        happened.
      </p>

      <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor="bank-name">
            Bank
          </label>
          <input
            id="bank-name"
            className="input"
            value={bankName}
            onChange={(event) => setBankName(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="bank-branch">
            Branch
          </label>
          <input
            id="bank-branch"
            className="input"
            value={bankBranch}
            onChange={(event) => setBankBranch(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="referral-reference">
            Referral reference
          </label>
          <input
            id="referral-reference"
            className="input tabular"
            value={referralReference}
            onChange={(event) => setReferralReference(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="referral-date">
            Dated
          </label>
          <input
            id="referral-date"
            className="input"
            type="date"
            value={referralDate}
            onChange={(event) => setReferralDate(event.target.value)}
          />
        </div>
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="referral-message">
          Message to the applicant
        </label>
        <textarea
          id="referral-message"
          className="textarea"
          rows={2}
          value={applicantMessage}
          onChange={(event) => setApplicantMessage(event.target.value)}
        />
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="referral-note">
          Internal note
        </label>
        <input
          id="referral-note"
          className="input"
          value={internalNote}
          onChange={(event) => setInternalNote(event.target.value)}
        />
        <span className="field-hint">Optional, and never shown to the applicant.</span>
      </div>

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '0.75rem' }}
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="button"
        data-variant="primary"
        style={{ marginTop: '0.75rem' }}
        disabled={!ready || refer.isPending}
      >
        {refer.isPending ? 'Referring…' : 'Refer to the bank'}
      </button>
    </form>
  )
}

type OutcomeDraft = {
  outcome: BankOutcome
  decisionReference: string
  decisionDate: string
  availableLoanAmountPaise?: string | null
  applicantSummary: string
  internalNote?: string | null
  revisions: {
    section: ApplicationSection
    reasonCategoryId: string
    note: string
  }[]
}

/**
 * Recording what the bank decided.
 *
 * "More information needed" is the only outcome that names sections, and it
 * works exactly like a desk review revision: the sections named unlock for the
 * applicant and nothing else does.
 */
function OutcomeForm({
  title,
  confirmLabel,
  reasons,
  extra,
  onSubmit,
}: {
  title: string
  confirmLabel: string
  reasons: ReasonCategory[] | undefined
  extra?: React.ReactNode
  onSubmit: (draft: OutcomeDraft) => Promise<void>
}) {
  const [outcome, setOutcome] = useState<BankOutcome | ''>('')
  const [decisionReference, setDecisionReference] = useState('')
  const [decisionDate, setDecisionDate] = useState('')
  const [loanRupees, setLoanRupees] = useState('')
  const [applicantSummary, setApplicantSummary] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [revisions, setRevisions] = useState<
    Partial<Record<ApplicationSection, { reasonCategoryId: string; note: string }>>
  >({})
  const [error, setError] = useState<string | null>(null)

  const revisionReasons = reasonsFor(reasons, 'REVISION')
  const chosen = Object.entries(revisions) as [
    ApplicationSection,
    { reasonCategoryId: string; note: string },
  ][]

  const submit = useMutation({
    mutationFn: () =>
      onSubmit({
        outcome: outcome as BankOutcome,
        decisionReference: decisionReference.trim(),
        decisionDate,
        // Rupees on screen, paise on the wire.
        availableLoanAmountPaise:
          loanRupees.trim() === '' ? null : String(Math.round(Number(loanRupees) * 100)),
        applicantSummary: applicantSummary.trim(),
        internalNote: internalNote.trim() || null,
        revisions:
          outcome === 'MORE_INFORMATION_REQUIRED'
            ? chosen.map(([section, value]) => ({
                section,
                reasonCategoryId: value.reasonCategoryId,
                note: value.note.trim(),
              }))
            : [],
      }),
    onMutate: () => setError(null),
    onError: (cause) => setError(messageFor(cause)),
  })

  const ready =
    Boolean(outcome) &&
    decisionReference.trim() &&
    decisionDate &&
    applicantSummary.trim() &&
    (outcome !== 'MORE_INFORMATION_REQUIRED' ||
      (chosen.length > 0 &&
        chosen.every(([, value]) => value.reasonCategoryId && value.note.trim())))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit.mutate()
      }}
    >
      <h4>{title}</h4>

      <div className="stack" style={{ marginTop: '0.75rem' }}>
        {OUTCOMES.map((option) => (
          <label className="choice-block" key={option.value}>
            <input
              type="radio"
              name="bank-outcome"
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

      <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor="outcome-reference">
            The bank's decision reference
          </label>
          <input
            id="outcome-reference"
            className="input tabular"
            value={decisionReference}
            onChange={(event) => setDecisionReference(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="outcome-date">
            Dated
          </label>
          <input
            id="outcome-date"
            className="input"
            type="date"
            value={decisionDate}
            onChange={(event) => setDecisionDate(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="outcome-loan">
            Loan the bank will provide (₹)
          </label>
          <input
            id="outcome-loan"
            className="input tabular"
            type="number"
            min={0}
            step="0.01"
            value={loanRupees}
            onChange={(event) => setLoanRupees(event.target.value)}
          />
          <span className="field-hint">
            {loanRupees.trim() === ''
              ? 'Leave blank if the bank did not state one.'
              : formatMoney(String(Math.round(Number(loanRupees) * 100)))}
          </span>
        </div>
      </div>

      {outcome === 'MORE_INFORMATION_REQUIRED' ? (
        <div style={{ marginTop: '0.75rem' }}>
          <p className="field-label">Sections the applicant must correct</p>
          <div className="stack">
            {REVISABLE.map((section) => {
              const value = revisions[section]
              return (
                <div key={section}>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(event) =>
                        setRevisions((previous) => {
                          const next = { ...previous }
                          if (event.target.checked) {
                            next[section] = { reasonCategoryId: '', note: '' }
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
                    <div className="detail-grid">
                      <div>
                        <label className="field-label" htmlFor={`bank-${section}-reason`}>
                          Reason
                        </label>
                        <select
                          id={`bank-${section}-reason`}
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
                        <label className="field-label" htmlFor={`bank-${section}-note`}>
                          What the applicant must do
                        </label>
                        <input
                          id={`bank-${section}-note`}
                          className="input"
                          value={value.note}
                          onChange={(event) =>
                            setRevisions((previous) => ({
                              ...previous,
                              [section]: { ...value, note: event.target.value },
                            }))
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="outcome-summary">
          What the applicant is told
        </label>
        <textarea
          id="outcome-summary"
          className="textarea"
          rows={2}
          value={applicantSummary}
          onChange={(event) => setApplicantSummary(event.target.value)}
        />
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="outcome-note">
          Internal note
        </label>
        <input
          id="outcome-note"
          className="input"
          value={internalNote}
          onChange={(event) => setInternalNote(event.target.value)}
        />
      </div>

      {extra}

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '0.75rem' }}
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="button"
        data-variant="primary"
        style={{ marginTop: '0.75rem' }}
        disabled={!ready || submit.isPending}
      >
        {submit.isPending ? 'Recording…' : confirmLabel}
      </button>
    </form>
  )
}

/**
 * Replacing an outcome that was recorded wrongly.
 *
 * The correction carries its own reason, separate from the bank's: one says
 * what the bank decided, the other says why the office is changing its record
 * of it.
 */
function CorrectOutcome({
  applicationId,
  referralId,
  supersedesOutcomeId,
  statusVersion,
  reasons,
  onChanged,
}: {
  applicationId: string
  referralId: string
  supersedesOutcomeId: string
  statusVersion: number
  reasons: ReasonCategory[] | undefined
  onChanged: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [correctionReasonCategoryId, setCategoryId] = useState('')
  const [correctionReason, setReason] = useState('')

  const correctionReasons = reasonsFor(reasons, 'BANK_OUTCOME_CORRECTION')

  if (!open) {
    return (
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Correct the recorded outcome
      </button>
    )
  }

  return (
    <OutcomeForm
      title="Correct the recorded outcome"
      confirmLabel="Record the correction"
      reasons={reasons}
      extra={
        <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
          <div>
            <label className="field-label" htmlFor="correction-category">
              Why the record is changing
            </label>
            <select
              id="correction-category"
              className="select"
              value={correctionReasonCategoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Choose a reason</option>
              {correctionReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ gridColumn: '2 / -1' }}>
            <label className="field-label" htmlFor="correction-detail">
              What went wrong
            </label>
            <input
              id="correction-detail"
              className="input"
              value={correctionReason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
      }
      onSubmit={async (draft) => {
        const data = await gql(CorrectBankOutcomeDocument, {
          input: {
            applicationId,
            referralId,
            supersedesOutcomeId,
            expectedStatusVersion: statusVersion,
            correctionReasonCategoryId,
            correctionReason: correctionReason.trim(),
            ...draft,
          },
        })
        unwrap(data.admin.decision.correctBankOutcome)
        setOpen(false)
        await onChanged()
      }}
    />
  )
}

/** Withdrawing a referral the bank has not answered. */
function CancelReferral({
  applicationId,
  referral,
  reasons,
  onChanged,
}: {
  applicationId: string
  referral: Referral
  reasons: ReasonCategory[] | undefined
  onChanged: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [reasonCategoryId, setCategoryId] = useState('')
  const [reason, setReason] = useState('')
  const [applicantMessage, setApplicantMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const cancelReasons = reasonsFor(reasons, 'BANK_REFERRAL_CANCEL')

  const cancel = useMutation({
    mutationFn: async () => {
      const data = await gql(CancelBankReferralDocument, {
        input: {
          applicationId,
          referralId: referral.id,
          expectedReferralVersion: referral.currentVersion,
          reasonCategoryId,
          reason: reason.trim(),
          applicantMessage: applicantMessage.trim(),
        },
      })
      unwrap(data.admin.decision.cancelBankReferral)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setOpen(false)
      await onChanged()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  if (!open) {
    return (
      <button
        type="button"
        className="button"
        data-variant="danger"
        style={{ marginTop: '0.75rem' }}
        onClick={() => setOpen(true)}
      >
        Withdraw the referral
      </button>
    )
  }

  return (
    <form
      style={{ marginTop: '0.75rem' }}
      onSubmit={(event) => {
        event.preventDefault()
        cancel.mutate()
      }}
    >
      <h4>Withdraw the referral</h4>
      <div className="detail-grid" style={{ marginTop: '0.5rem' }}>
        <div>
          <label className="field-label" htmlFor="cancel-referral-category">
            Reason
          </label>
          <select
            id="cancel-referral-category"
            className="select"
            value={reasonCategoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Choose a reason</option>
            {cancelReasons.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ gridColumn: '2 / -1' }}>
          <label className="field-label" htmlFor="cancel-referral-detail">
            What happened
          </label>
          <input
            id="cancel-referral-detail"
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
      <div style={{ marginTop: '0.5rem' }}>
        <label className="field-label" htmlFor="cancel-referral-message">
          Message to the applicant
        </label>
        <textarea
          id="cancel-referral-message"
          className="textarea"
          rows={2}
          value={applicantMessage}
          onChange={(event) => setApplicantMessage(event.target.value)}
        />
      </div>
      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '0.5rem' }}
        >
          {error}
        </p>
      ) : null}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button
          type="submit"
          className="button"
          data-variant="danger"
          disabled={
            !reasonCategoryId ||
            !reason.trim() ||
            !applicantMessage.trim() ||
            cancel.isPending
          }
        >
          {cancel.isPending ? 'Withdrawing…' : 'Withdraw it'}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </div>
    </form>
  )
}
