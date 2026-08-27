/**
 * What can be done to a live award: pay, correct a payment, assess, and change
 * the award itself.
 *
 * Releasing money is the most consequential write in the whole product and the
 * API guards it accordingly — it demands the approval it is paid
 * under, evidence the bank account was verified, the executed performance
 * agreement, and, where the programme requires it, the physical verification.
 * The form asks for all of them because the payment does not happen without
 * them, not because a form should be long.
 *
 * A payment is never deleted. A reversal is its own ledger entry that names the
 * release it corrects, so the record shows both what was paid and what came
 * back.
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { FundingWorkspace } from '#/features/admin/fundingQueries'
import { reasonsFor, type ReasonCategory } from '#/features/admin/workspaceQueries'
import {
  ChangeAwardDocument,
  RecordAssessmentDocument,
  RecordReleaseDocument,
  ReverseReleaseDocument,
} from '#/graphql/generated/operations'
import type {
  AssessmentOutcome,
  AssessmentType,
  AwardClosureDisposition,
  AwardStatus,
} from '#/graphql/generated/schema'
import { formatDateTime, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

/** Rupees on screen, paise on the wire. */
const toPaise = (rupees: string): string => String(Math.round(Number(rupees) * 100))

/** A `datetime-local` value as the ISO-8601 instant the API expects. */
const toInstant = (local: string): string => new Date(local).toISOString()

const ASSESSMENT_TYPES: AssessmentType[] = [
  'UTILIZATION',
  'PERFORMANCE',
  'FINANCIAL_AUDIT',
]
const ASSESSMENT_OUTCOMES: AssessmentOutcome[] = ['PASSED', 'FAILED']
const AWARD_STATUSES: AwardStatus[] = ['ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED']
const CLOSURES: AwardClosureDisposition[] = [
  'RELEASES_COMPLETE',
  'REMAINDER_NOT_RELEASED',
]

export function AwardActions({
  applicationId,
  statusVersion,
  award,
  ledger,
  obligations,
  assessments,
  reasons,
  onApplied,
}: {
  applicationId: string
  statusVersion: number
  award: FundingWorkspace['award']
  ledger: FundingWorkspace['ledger']
  obligations: FundingWorkspace['obligations']
  assessments: FundingWorkspace['assessments']
  reasons: ReasonCategory[] | undefined
  onApplied: (workspace: FundingWorkspace) => void
}) {
  const releases = ledger.filter((entry) => entry.entryType === 'RELEASE')
  const live = award.status === 'ACTIVE'

  return (
    <>
      {assessments.length > 0 ? (
        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Assessments</p>
          </div>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Assessments of this award</caption>
              <thead>
                <tr>
                  <th scope="col">Assessment</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Assessed</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">What the applicant was told</th>
                </tr>
              </thead>
              <tbody>
                {assessments.map((assessment) => (
                  <tr key={assessment.id}>
                    <td>
                      {humanize(assessment.assessmentType)} {assessment.assessmentNumber}
                    </td>
                    <td>
                      <span
                        className="badge"
                        data-tone={assessment.outcome === 'PASSED' ? 'ok' : 'error'}
                      >
                        {humanize(assessment.outcome)}
                      </span>
                    </td>
                    <td>{formatDateTime(assessment.assessedAt)}</td>
                    <td className="tabular">{assessment.evidenceReference}</td>
                    <td>{assessment.applicantSummary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {live ? (
        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Record a payment</p>
          </div>
          <div className="card-body">
            <ReleaseForm
              applicationId={applicationId}
              award={award}
              onApplied={onApplied}
            />
          </div>
        </section>
      ) : null}

      {live && releases.length > 0 ? (
        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Correct a payment</p>
          </div>
          <div className="card-body">
            <ReversalForm
              applicationId={applicationId}
              award={award}
              releases={releases}
              reasons={reasons}
              onApplied={onApplied}
            />
          </div>
        </section>
      ) : null}

      {live ? (
        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Record an assessment</p>
          </div>
          <div className="card-body">
            <AssessmentForm
              applicationId={applicationId}
              award={award}
              obligations={obligations}
              onApplied={onApplied}
            />
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="card-header">
          <p className="eyebrow">Change the award</p>
        </div>
        <div className="card-body">
          <ChangeAwardForm
            applicationId={applicationId}
            statusVersion={statusVersion}
            award={award}
            reasons={reasons}
            onApplied={onApplied}
          />
        </div>
      </section>
    </>
  )
}

function ReleaseForm({
  applicationId,
  award,
  onApplied,
}: {
  applicationId: string
  award: FundingWorkspace['award']
  onApplied: (workspace: FundingWorkspace) => void
}) {
  const [amount, setAmount] = useState('')
  const [occurredAt, setOccurredAt] = useState('')
  const [externalReference, setExternalReference] = useState('')
  const [approvalReference, setApprovalReference] = useState('')
  const [approvalDate, setApprovalDate] = useState('')
  const [bankAccountVerifiedAt, setVerifiedAt] = useState('')
  const [agreementReference, setAgreementReference] = useState('')
  const [agreementExecutedAt, setAgreementExecutedAt] = useState('')
  const [physicalRequired, setPhysicalRequired] = useState(false)
  const [physicalReference, setPhysicalReference] = useState('')
  const [physicalCompletedAt, setPhysicalCompletedAt] = useState('')
  const [applicantMessage, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const record = useMutation({
    mutationFn: async () => {
      const data = await gql(RecordReleaseDocument, {
        input: {
          awardId: award.id,
          applicationId,
          expectedLedgerVersion: award.ledgerVersion,
          amountPaise: toPaise(amount),
          occurredAt: toInstant(occurredAt),
          externalReference: externalReference.trim(),
          approvalReference: approvalReference.trim(),
          approvalDate,
          bankAccountVerifiedAt: toInstant(bankAccountVerifiedAt),
          performanceAgreementReference: agreementReference.trim(),
          performanceAgreementExecutedAt: toInstant(agreementExecutedAt),
          physicalVerificationRequired: physicalRequired,
          physicalVerificationReference: physicalRequired
            ? physicalReference.trim()
            : null,
          physicalVerificationCompletedAt:
            physicalRequired && physicalCompletedAt
              ? toInstant(physicalCompletedAt)
              : null,
          applicantMessage: applicantMessage.trim(),
        },
      })
      return unwrap(data.admin.funding.recordRelease)
    },
    onMutate: () => setError(null),
    onSuccess: onApplied,
    onError: (cause) => setError(messageFor(cause)),
  })

  const ready =
    amount.trim() &&
    occurredAt &&
    externalReference.trim() &&
    approvalReference.trim() &&
    approvalDate &&
    bankAccountVerifiedAt &&
    agreementReference.trim() &&
    agreementExecutedAt &&
    applicantMessage.trim() &&
    (!physicalRequired || (physicalReference.trim() && physicalCompletedAt))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        record.mutate()
      }}
    >
      <div className="detail-grid">
        <div>
          <label className="field-label" htmlFor="release-amount">
            Amount (₹)
          </label>
          <input
            id="release-amount"
            className="input tabular"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <span className="field-hint">
            {amount.trim() === ''
              ? 'The instalment being paid.'
              : formatMoney(toPaise(amount))}
          </span>
        </div>
        <div>
          <label className="field-label" htmlFor="release-when">
            Paid on
          </label>
          <input
            id="release-when"
            className="input"
            type="datetime-local"
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="release-reference">
            Payment reference
          </label>
          <input
            id="release-reference"
            className="input tabular"
            value={externalReference}
            onChange={(event) => setExternalReference(event.target.value)}
          />
          <span className="field-hint">The applicant sees this one.</span>
        </div>
      </div>

      <fieldset className="fieldset" style={{ marginTop: '1rem' }}>
        <legend className="eyebrow">Before the money can move</legend>
        <div className="detail-grid">
          <div>
            <label className="field-label" htmlFor="release-approval">
              Approval reference
            </label>
            <input
              id="release-approval"
              className="input tabular"
              value={approvalReference}
              onChange={(event) => setApprovalReference(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="release-approval-date">
              Approved on
            </label>
            <input
              id="release-approval-date"
              className="input"
              type="date"
              value={approvalDate}
              onChange={(event) => setApprovalDate(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="release-bank-verified">
              Bank account verified
            </label>
            <input
              id="release-bank-verified"
              className="input"
              type="datetime-local"
              value={bankAccountVerifiedAt}
              onChange={(event) => setVerifiedAt(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="release-agreement">
              Performance agreement
            </label>
            <input
              id="release-agreement"
              className="input tabular"
              value={agreementReference}
              onChange={(event) => setAgreementReference(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="release-agreement-date">
              Executed on
            </label>
            <input
              id="release-agreement-date"
              className="input"
              type="datetime-local"
              value={agreementExecutedAt}
              onChange={(event) => setAgreementExecutedAt(event.target.value)}
            />
          </div>
        </div>

        <label className="checkbox-row" style={{ marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={physicalRequired}
            onChange={(event) => setPhysicalRequired(event.target.checked)}
          />
          A physical verification was required for this instalment
        </label>

        {physicalRequired ? (
          <div className="detail-grid" style={{ marginTop: '0.5rem' }}>
            <div>
              <label className="field-label" htmlFor="release-physical">
                Verification reference
              </label>
              <input
                id="release-physical"
                className="input tabular"
                value={physicalReference}
                onChange={(event) => setPhysicalReference(event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="release-physical-date">
                Completed on
              </label>
              <input
                id="release-physical-date"
                className="input"
                type="datetime-local"
                value={physicalCompletedAt}
                onChange={(event) => setPhysicalCompletedAt(event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </fieldset>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="release-message">
          What the applicant is told
        </label>
        <textarea
          id="release-message"
          className="textarea"
          rows={2}
          value={applicantMessage}
          onChange={(event) => setMessage(event.target.value)}
        />
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
        disabled={!ready || record.isPending}
      >
        {record.isPending ? 'Recording…' : 'Record the payment'}
      </button>
    </form>
  )
}

function ReversalForm({
  applicationId,
  award,
  releases,
  reasons,
  onApplied,
}: {
  applicationId: string
  award: FundingWorkspace['award']
  releases: FundingWorkspace['ledger']
  reasons: ReasonCategory[] | undefined
  onApplied: (workspace: FundingWorkspace) => void
}) {
  const [releaseId, setReleaseId] = useState('')
  const [amount, setAmount] = useState('')
  const [occurredAt, setOccurredAt] = useState('')
  const [externalReference, setExternalReference] = useState('')
  const [reasonCategoryId, setCategoryId] = useState('')
  const [applicantMessage, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reversalReasons = reasonsFor(reasons, 'RELEASE_REVERSAL')

  const reverse = useMutation({
    mutationFn: async () => {
      const data = await gql(ReverseReleaseDocument, {
        input: {
          awardId: award.id,
          applicationId,
          releaseId,
          expectedLedgerVersion: award.ledgerVersion,
          amountPaise: toPaise(amount),
          occurredAt: toInstant(occurredAt),
          externalReference: externalReference.trim(),
          reasonCategoryId,
          applicantMessage: applicantMessage.trim(),
        },
      })
      return unwrap(data.admin.funding.reverseRelease)
    },
    onMutate: () => setError(null),
    onSuccess: onApplied,
    onError: (cause) => setError(messageFor(cause)),
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        reverse.mutate()
      }}
    >
      <p className="field-hint">
        A reversal is its own entry naming the payment it corrects. Neither is removed.
      </p>

      <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor="reversal-release">
            The payment being corrected
          </label>
          <select
            id="reversal-release"
            className="select"
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
          >
            <option value="">Choose a payment</option>
            {releases.map((release) => (
              <option key={release.id} value={release.id}>
                #{release.sequenceNumber} · {formatMoney(release.amountPaise)} ·{' '}
                {formatDateTime(release.occurredAt)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="reversal-amount">
            Amount coming back (₹)
          </label>
          <input
            id="reversal-amount"
            className="input tabular"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <span className="field-hint">
            {amount.trim() === ''
              ? 'May be less than the payment.'
              : formatMoney(toPaise(amount))}
          </span>
        </div>
        <div>
          <label className="field-label" htmlFor="reversal-when">
            Returned on
          </label>
          <input
            id="reversal-when"
            className="input"
            type="datetime-local"
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="reversal-reference">
            Bank reference
          </label>
          <input
            id="reversal-reference"
            className="input tabular"
            value={externalReference}
            onChange={(event) => setExternalReference(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="reversal-reason">
            Reason
          </label>
          <select
            id="reversal-reason"
            className="select"
            value={reasonCategoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Choose a reason</option>
            {reversalReasons.map((reason) => (
              <option key={reason.id} value={reason.id}>
                {reason.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="reversal-message">
          What the applicant is told
        </label>
        <textarea
          id="reversal-message"
          className="textarea"
          rows={2}
          value={applicantMessage}
          onChange={(event) => setMessage(event.target.value)}
        />
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
        data-variant="danger"
        style={{ marginTop: '0.75rem' }}
        disabled={
          !releaseId ||
          !amount.trim() ||
          !occurredAt ||
          !externalReference.trim() ||
          !reasonCategoryId ||
          !applicantMessage.trim() ||
          reverse.isPending
        }
      >
        {reverse.isPending ? 'Recording…' : 'Record the reversal'}
      </button>
    </form>
  )
}

/**
 * Recording an assessment.
 *
 * Utilization is assessed per payment — each release creates an obligation to
 * show how that money was used — so that type asks which obligation it answers.
 * The other types are about the award as a whole.
 */
function AssessmentForm({
  applicationId,
  award,
  obligations,
  onApplied,
}: {
  applicationId: string
  award: FundingWorkspace['award']
  obligations: FundingWorkspace['obligations']
  onApplied: (workspace: FundingWorkspace) => void
}) {
  const [assessmentType, setType] = useState<AssessmentType>('UTILIZATION')
  const [utilizationObligationId, setObligationId] = useState('')
  const [outcome, setOutcome] = useState<AssessmentOutcome | ''>('')
  const [evidenceReference, setEvidence] = useState('')
  const [applicantSummary, setSummary] = useState('')
  const [internalNote, setNote] = useState('')
  const [assessedAt, setAssessedAt] = useState('')
  const [error, setError] = useState<string | null>(null)

  const record = useMutation({
    mutationFn: async () => {
      const data = await gql(RecordAssessmentDocument, {
        input: {
          awardId: award.id,
          applicationId,
          assessmentType,
          utilizationObligationId:
            assessmentType === 'UTILIZATION' ? utilizationObligationId : null,
          outcome: outcome as AssessmentOutcome,
          evidenceReference: evidenceReference.trim(),
          applicantSummary: applicantSummary.trim(),
          internalNote: internalNote.trim() || null,
          assessedAt: toInstant(assessedAt),
        },
      })
      return unwrap(data.admin.funding.recordAssessment)
    },
    onMutate: () => setError(null),
    onSuccess: onApplied,
    onError: (cause) => setError(messageFor(cause)),
  })

  const ready =
    Boolean(outcome) &&
    evidenceReference.trim() &&
    applicantSummary.trim() &&
    assessedAt &&
    (assessmentType !== 'UTILIZATION' || Boolean(utilizationObligationId))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        record.mutate()
      }}
    >
      <div className="detail-grid">
        <div>
          <label className="field-label" htmlFor="assessment-type">
            Type
          </label>
          <select
            id="assessment-type"
            className="select"
            value={assessmentType}
            onChange={(event) => setType(event.target.value as AssessmentType)}
          >
            {ASSESSMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </select>
        </div>

        {assessmentType === 'UTILIZATION' ? (
          <div>
            <label className="field-label" htmlFor="assessment-obligation">
              Which payment it accounts for
            </label>
            <select
              id="assessment-obligation"
              className="select"
              value={utilizationObligationId}
              onChange={(event) => setObligationId(event.target.value)}
            >
              <option value="">Choose a payment</option>
              {obligations.map((obligation) => (
                <option key={obligation.id} value={obligation.id}>
                  Due {formatDateTime(obligation.dueAt)}
                </option>
              ))}
            </select>
            {obligations.length === 0 ? (
              <span className="field-hint">
                No payment has been made, so there is nothing to account for yet.
              </span>
            ) : null}
          </div>
        ) : null}

        <div>
          <label className="field-label" htmlFor="assessment-outcome">
            Outcome
          </label>
          <select
            id="assessment-outcome"
            className="select"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as AssessmentOutcome)}
          >
            <option value="">Choose an outcome</option>
            {ASSESSMENT_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="assessment-when">
            Assessed on
          </label>
          <input
            id="assessment-when"
            className="input"
            type="datetime-local"
            value={assessedAt}
            onChange={(event) => setAssessedAt(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="assessment-evidence">
            Evidence reference
          </label>
          <input
            id="assessment-evidence"
            className="input tabular"
            value={evidenceReference}
            onChange={(event) => setEvidence(event.target.value)}
          />
        </div>
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="assessment-summary">
          What the applicant is told
        </label>
        <textarea
          id="assessment-summary"
          className="textarea"
          rows={2}
          value={applicantSummary}
          onChange={(event) => setSummary(event.target.value)}
        />
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="assessment-note">
          Internal note
        </label>
        <input
          id="assessment-note"
          className="input"
          value={internalNote}
          onChange={(event) => setNote(event.target.value)}
        />
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
        disabled={!ready || record.isPending}
      >
        {record.isPending ? 'Recording…' : 'Record the assessment'}
      </button>
    </form>
  )
}

/**
 * Suspending, cancelling, closing or amending an award.
 *
 * The amount is part of this form because an amendment can change it — the
 * the programme may revise what it approved — and the API takes the new amount
 * alongside the new status.
 */
function ChangeAwardForm({
  applicationId,
  statusVersion,
  award,
  reasons,
  onApplied,
}: {
  applicationId: string
  statusVersion: number
  award: FundingWorkspace['award']
  reasons: ReasonCategory[] | undefined
  onApplied: (workspace: FundingWorkspace) => void
}) {
  const [status, setStatus] = useState<AwardStatus>(award.status)
  const [closureDisposition, setClosure] = useState<AwardClosureDisposition | ''>(
    award.closureDisposition ?? '',
  )
  const [amountRupees, setAmount] = useState(
    String(Number(award.sanctionedAmountPaise) / 100),
  )
  const [applicantConditions, setConditions] = useState(award.applicantConditions ?? '')
  const [reasonCategoryId, setCategoryId] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  /*
   * Which catalogue applies depends on what is changing. An amendment, a
   * suspension, a cancellation and a closure are reported on separately, so the
   * programme defines a reason list for each.
   */
  const catalogue =
    status === 'SUSPENDED'
      ? 'AWARD_SUSPENSION'
      : status === 'CANCELLED'
        ? 'AWARD_CANCELLATION'
        : status === 'CLOSED'
          ? 'AWARD_CLOSURE'
          : 'AWARD_AMENDMENT'
  const available = reasonsFor(reasons, catalogue)

  const change = useMutation({
    mutationFn: async () => {
      const data = await gql(ChangeAwardDocument, {
        input: {
          awardId: award.id,
          applicationId,
          expectedVersion: award.currentVersion,
          expectedStatusVersion: statusVersion,
          status,
          closureDisposition: status === 'CLOSED' ? closureDisposition || null : null,
          sanctionedAmountPaise: toPaise(amountRupees),
          applicantConditions: applicantConditions.trim() || null,
          reasonCategoryId,
          reason: reason.trim(),
        },
      })
      return unwrap(data.admin.funding.changeAward)
    },
    onMutate: () => setError(null),
    onSuccess: onApplied,
    onError: (cause) => setError(messageFor(cause)),
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        change.mutate()
      }}
    >
      <div className="detail-grid">
        <div>
          <label className="field-label" htmlFor="award-status">
            State
          </label>
          <select
            id="award-status"
            className="select"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as AwardStatus)
              setCategoryId('')
            }}
          >
            {AWARD_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </div>

        {status === 'CLOSED' ? (
          <div>
            <label className="field-label" htmlFor="award-closure">
              How it closed
            </label>
            <select
              id="award-closure"
              className="select"
              value={closureDisposition}
              onChange={(event) =>
                setClosure(event.target.value as AwardClosureDisposition)
              }
            >
              <option value="">Choose one</option>
              {CLOSURES.map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label className="field-label" htmlFor="award-amount">
            Sanctioned amount (₹)
          </label>
          <input
            id="award-amount"
            className="input tabular"
            type="number"
            min={0}
            step="0.01"
            value={amountRupees}
            onChange={(event) => setAmount(event.target.value)}
          />
          <span className="field-hint">{formatMoney(toPaise(amountRupees))}</span>
        </div>

        <div>
          <label className="field-label" htmlFor="award-reason">
            Reason
          </label>
          <select
            id="award-reason"
            className="select"
            value={reasonCategoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Choose a reason</option>
            {available.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="award-conditions">
          Conditions
        </label>
        <textarea
          id="award-conditions"
          className="textarea"
          rows={2}
          value={applicantConditions}
          onChange={(event) => setConditions(event.target.value)}
        />
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="award-reason-detail">
          What happened
        </label>
        <input
          id="award-reason-detail"
          className="input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
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
        data-variant={status === 'ACTIVE' ? undefined : 'danger'}
        style={{ marginTop: '0.75rem' }}
        disabled={
          !reasonCategoryId ||
          !reason.trim() ||
          (status === 'CLOSED' && !closureDisposition) ||
          change.isPending
        }
      >
        {change.isPending ? 'Saving…' : 'Record the change'}
      </button>
    </form>
  )
}
