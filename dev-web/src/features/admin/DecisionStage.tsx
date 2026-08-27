/**
 * The decision stage, seen from one application.
 *
 * An application that has cleared the bank stage is decided here and nowhere
 * else. There is no meeting to convene and no agenda to join: the whole gate is
 * holding `DECIDE`, and the record names the submission and bank outcome that
 * were on the screen when it was taken.
 *
 * A decision is never edited. A correction supersedes the decision it replaces
 * and carries its own reason: one says what was decided, the other says why the
 * office is changing its record of it.
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { reasonsFor, type ReasonCategory } from '#/features/admin/workspaceQueries'
import { Explain } from '#/features/guide/Explain'
import { useMarker } from '#/features/guide/GuideContext'
import {
  CorrectDecisionDocument,
  RecordDecisionDocument,
} from '#/graphql/generated/operations'
import type { DecisionOutcome } from '#/graphql/generated/schema'
import { formatDate, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

type Decision = {
  id: string
  outcome: DecisionOutcome
  decisionReference: string
  decisionDate: string
  approvedAmountPaise?: string | null
  applicantMessage: string
  createdAt: string
  conflictAcknowledged: boolean
}

const OUTCOMES: { value: DecisionOutcome; label: string; means: string }[] = [
  {
    value: 'APPROVED',
    label: 'Approved',
    means: 'The programme approves funding. A sanction order can then be issued.',
  },
  {
    value: 'REJECTED',
    label: 'Rejected',
    means: 'The application is closed without funding.',
  },
  {
    value: 'REVISION_REQUIRED',
    label: 'Correction needed',
    means:
      'The stages you name unlock for the applicant, and the application returns to them.',
  },
]

export function DecisionStage({
  applicationId,
  status,
  statusVersion,
  latestBankOutcomeId,
  decisions,
  reasons,
  stages,
  decidingOwnApplication,
  onChanged,
}: {
  applicationId: string
  status: string
  statusVersion: number
  latestBankOutcomeId: string | undefined
  decisions: Decision[]
  reasons: ReasonCategory[] | undefined
  /**
   * The stages this application's own form declares.
   *
   * Passed in rather than fixed in code: which stages exist is the cycle's
   * decision, and the API refuses a revision naming a stage the pinned form
   * does not have — so a hard-coded list would offer refusals.
   */
  stages: readonly { key: string; title: string }[]
  decidingOwnApplication: boolean
  onChanged: () => Promise<unknown>
}) {
  const mark = useMarker()
  const latestDecision = decisions.at(-1)

  // Nothing to say until a bank has answered and the application is waiting, or
  // a decision already exists to show.
  if (!latestBankOutcomeId && decisions.length === 0) return null

  return (
    <section className="card" {...mark('decision-stage')}>
      <div className="card-header">
        <div className="label-row">
          <p className="eyebrow">Decision</p>
          <Explain label="the decision" opener="How a decision is recorded">
            {OFFICE_HELP.decisionRecord}
          </Explain>
        </div>
        {status === 'AWAITING_DECISION' && decisions.length === 0 ? (
          <span className="badge">Waiting to be decided</span>
        ) : null}
      </div>

      {decisions.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">What the programme decided</caption>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Decision</th>
                <th scope="col">Dated</th>
                <th scope="col">Approved</th>
                <th scope="col">What the applicant was told</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((decision) => (
                <tr
                  key={decision.id}
                  className={decision.id === latestDecision?.id ? undefined : 'muted'}
                >
                  <td>
                    {humanize(decision.outcome)}
                    {decision.id === latestDecision?.id ? null : (
                      <span className="field-hint">Superseded</span>
                    )}
                    {/* Shown wherever the decision is, because a decision an
                        officer took on their own file is the thing somebody
                        reading this record afterwards needs to notice. */}
                    {decision.conflictAcknowledged ? (
                      <span className="field-hint">
                        Decided by the applicant, declared
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular">{decision.decisionReference}</td>
                  <td>{formatDate(decision.decisionDate)}</td>
                  <td className="tabular">
                    {decision.approvedAmountPaise
                      ? formatMoney(decision.approvedAmountPaise)
                      : '\u2014'}
                  </td>
                  <td>{decision.applicantMessage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card-body">
        {status === 'AWAITING_DECISION' && decisions.length === 0 ? (
          <DecisionForm
            title="Record the decision"
            confirmLabel="Record the decision"
            reasons={reasons}
            stages={stages}
            decidingOwnApplication={decidingOwnApplication}
            onSubmit={async (draft) => {
              const data = await gql(RecordDecisionDocument, {
                input: {
                  applicationId,
                  expectedStatusVersion: statusVersion,
                  ...draft,
                },
              })
              unwrap(data.admin.decision.recordDecision)
              await onChanged()
            }}
          />
        ) : null}

        {latestDecision ? (
          <CorrectDecision
            applicationId={applicationId}
            supersedesDecisionId={latestDecision.id}
            statusVersion={statusVersion}
            reasons={reasons}
            stages={stages}
            decidingOwnApplication={decidingOwnApplication}
            onChanged={onChanged}
          />
        ) : null}
      </div>
    </section>
  )
}

type DecisionDraft = {
  outcome: DecisionOutcome
  decisionReference: string
  decisionDate: string
  approvedAmountPaise?: string | null
  applicantConditions?: string | null
  reasonCategoryId?: string | null
  applicantMessage: string
  revisions: {
    stageKey: string
    reasonCategoryId: string
    note: string
  }[]
  conflictAcknowledged?: boolean | null
}

/**
 * Which reason catalogue applies, if any, for the chosen outcome.
 *
 * The API decides this from the outcome alone — anything but an approval needs
 * a reason, and `seb_programme_decision` will not store one without it. Falling
 * through to `[]` for a revision therefore did not mean "no reason needed", it
 * meant the decision was refused with no way to satisfy it.
 */
const reasonsForOutcome = (
  outcome: DecisionOutcome | '',
  catalogues: {
    rejection: ReasonCategory[]
    revision: ReasonCategory[]
  },
): ReasonCategory[] => {
  if (outcome === 'REJECTED') return catalogues.rejection
  if (outcome === 'REVISION_REQUIRED') return catalogues.revision
  return []
}

/** Whether the API will demand an outcome reason. Approval is the only one that does not. */
const needsOutcomeReason = (outcome: DecisionOutcome | ''): boolean =>
  outcome !== '' && outcome !== 'APPROVED'

function DecisionForm({
  title,
  confirmLabel,
  reasons,
  stages,
  decidingOwnApplication,
  extra,
  onSubmit,
}: {
  title: string
  confirmLabel: string
  reasons: ReasonCategory[] | undefined
  /**
   * The stages this application's own form declares.
   *
   * Passed in rather than fixed in code: which stages exist is the cycle's
   * decision, and the API refuses a revision naming a stage the pinned form
   * does not have — so a hard-coded list would offer refusals.
   */
  stages: readonly { key: string; title: string }[]
  decidingOwnApplication: boolean
  extra?: React.ReactNode
  onSubmit: (draft: DecisionDraft) => Promise<void>
}) {
  const [outcome, setOutcome] = useState<DecisionOutcome | ''>('')
  const [decisionReference, setReference] = useState('')
  const [decisionDate, setDate] = useState('')
  const [approvedRupees, setApproved] = useState('')
  const [applicantConditions, setConditions] = useState('')
  const [applicantMessage, setMessage] = useState('')
  const [reasonCategoryId, setCategoryId] = useState('')
  const [conflictAcknowledged, setConflictAcknowledged] = useState(false)
  const [revisions, setRevisions] = useState<
    Partial<Record<string, { reasonCategoryId: string; note: string }>>
  >({})
  const [error, setError] = useState<string | null>(null)

  const revisionReasons = reasonsFor(reasons, 'REVISION')
  const rejectionReasons = reasonsFor(reasons, 'REJECTION')

  const chosen = Object.entries(revisions) as [
    string,
    { reasonCategoryId: string; note: string },
  ][]

  const outcomeReasons = reasonsForOutcome(outcome, {
    rejection: rejectionReasons,
    revision: revisionReasons,
  })

  const submit = useMutation({
    mutationFn: () =>
      onSubmit({
        outcome: outcome as DecisionOutcome,
        decisionReference: decisionReference.trim(),
        decisionDate,
        approvedAmountPaise:
          outcome === 'APPROVED' && approvedRupees.trim() !== ''
            ? String(Math.round(Number(approvedRupees) * 100))
            : null,
        applicantConditions: applicantConditions.trim() || null,
        reasonCategoryId: reasonCategoryId || null,
        applicantMessage: applicantMessage.trim(),
        revisions:
          outcome === 'REVISION_REQUIRED'
            ? chosen.map(([stageKey, value]) => ({
                stageKey,
                reasonCategoryId: value.reasonCategoryId,
                note: value.note.trim(),
              }))
            : [],
        conflictAcknowledged: decidingOwnApplication ? conflictAcknowledged : null,
      }),
    onMutate: () => setError(null),
    onError: (cause) => setError(messageFor(cause)),
  })


  const ready =
    Boolean(outcome) &&
    decisionReference.trim() &&
    decisionDate &&
    applicantMessage.trim() &&
    (outcome !== 'APPROVED' || approvedRupees.trim() !== '') &&
    // Derived from the outcome, not from whether a catalogue happens to be
    // non-empty. The old form was true precisely when the list was empty, so an
    // outcome with no select enabled the button and the API refused it.
    (!needsOutcomeReason(outcome) || Boolean(reasonCategoryId)) &&
    (outcome !== 'REVISION_REQUIRED' ||
      (chosen.length > 0 &&
        chosen.every(([, value]) => value.reasonCategoryId && value.note.trim()))) &&
    // The API refuses this the same way, so a disabled button is the honest
    // preview of that refusal rather than a second rule invented here.
    (!decidingOwnApplication || conflictAcknowledged)

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
              name="decision-outcome"
              checked={outcome === option.value}
              onChange={() => {
                setOutcome(option.value)
                setCategoryId('')
              }}
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
          <label className="field-label" htmlFor="decision-reference">
            Decision reference
          </label>
          <input
            id="decision-reference"
            className="input tabular"
            value={decisionReference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="decision-date">
            Dated
          </label>
          <input
            id="decision-date"
            className="input"
            type="date"
            value={decisionDate}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        {outcome === 'APPROVED' ? (
          <div>
            <label className="field-label" htmlFor="decision-amount">
              Amount approved (₹)
            </label>
            <input
              id="decision-amount"
              className="input tabular"
              type="number"
              min={0}
              step="0.01"
              value={approvedRupees}
              onChange={(event) => setApproved(event.target.value)}
            />
            <span className="field-hint">
              {approvedRupees.trim() === ''
                ? 'The sanction order is issued for this amount.'
                : formatMoney(String(Math.round(Number(approvedRupees) * 100)))}
            </span>
          </div>
        ) : null}
        {/*
          Said out loud rather than left as a disabled button. The decision
          needs a reason from this cycle's catalogue, and if the cycle has none
          there is nothing to choose and no way to tell from the form.
        */}
        {needsOutcomeReason(outcome) && outcomeReasons.length === 0 ? (
          <p className="notice" data-tone="warn">
            <span className="notice-title">This cycle has no reason for that outcome</span>
            A decision must name a reason from the cycle's catalogue. Add one in cycle
            administration first.
          </p>
        ) : null}

        {outcomeReasons.length > 0 ? (
          <div>
            <label className="field-label" htmlFor="decision-reason">
              Reason
            </label>
            <select
              id="decision-reason"
              className="select"
              value={reasonCategoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Choose a reason</option>
              {outcomeReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {outcome === 'APPROVED' ? (
        <div style={{ marginTop: '0.75rem' }}>
          <label className="field-label" htmlFor="decision-conditions">
            Conditions of the award
          </label>
          <textarea
            id="decision-conditions"
            className="textarea"
            rows={2}
            value={applicantConditions}
            onChange={(event) => setConditions(event.target.value)}
          />
          <span className="field-hint">
            Shown to the applicant on their funding screen. Leave blank if there are none.
          </span>
        </div>
      ) : null}

      {outcome === 'REVISION_REQUIRED' ? (
        <div style={{ marginTop: '0.75rem' }}>
          <p className="field-label">Stages the applicant must correct</p>
          <div className="stack">
            {stages.map((stage) => {
              const value = revisions[stage.key]
              return (
                <div key={stage.key}>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(event) =>
                        setRevisions((previous) => {
                          const next = { ...previous }
                          if (event.target.checked) {
                            next[stage.key] = { reasonCategoryId: '', note: '' }
                          } else {
                            delete next[stage.key]
                          }
                          return next
                        })
                      }
                    />
                    {stage.title}
                  </label>
                  {value ? (
                    <div className="detail-grid">
                      <div>
                        <label className="field-label" htmlFor={`revision-${stage.key}-reason`}>
                          Reason
                        </label>
                        <select
                          id={`revision-${stage.key}-reason`}
                          className="select"
                          value={value.reasonCategoryId}
                          onChange={(event) =>
                            setRevisions((previous) => ({
                              ...previous,
                              [stage.key]: {
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
                        <label className="field-label" htmlFor={`revision-${stage.key}-note`}>
                          What the applicant must do
                        </label>
                        <input
                          id={`revision-${stage.key}-note`}
                          className="input"
                          value={value.note}
                          onChange={(event) =>
                            setRevisions((previous) => ({
                              ...previous,
                              [stage.key]: { ...value, note: event.target.value },
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
        <label className="field-label" htmlFor="decision-message">
          What the applicant is told
        </label>
        <textarea
          id="decision-message"
          className="textarea"
          rows={2}
          value={applicantMessage}
          onChange={(event) => setMessage(event.target.value)}
        />
      </div>

      {extra}

      {decidingOwnApplication ? (
        /*
         * Deciding your own application is permitted with disclosure, and this
         * is the disclosure. Deliberately not a warning: a small office will
         * have officers who are also applicants, and that is expected rather
         * than suspect. Without this control the API's refusal is unanswerable
         * from the screen.
         */
        <p className="notice" style={{ marginTop: '1rem' }}>
          <span className="notice-title">This is your own application</span>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={conflictAcknowledged}
              onChange={(event) => setConflictAcknowledged(event.target.checked)}
            />
            I am deciding an application I submitted, and I am recording that.
          </label>
        </p>
      ) : null}

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

function CorrectDecision({
  applicationId,
  supersedesDecisionId,
  statusVersion,
  reasons,
  stages,
  decidingOwnApplication,
  onChanged,
}: {
  applicationId: string
  supersedesDecisionId: string
  statusVersion: number
  reasons: ReasonCategory[] | undefined
  /**
   * The stages this application's own form declares.
   *
   * Passed in rather than fixed in code: which stages exist is the cycle's
   * decision, and the API refuses a revision naming a stage the pinned form
   * does not have — so a hard-coded list would offer refusals.
   */
  stages: readonly { key: string; title: string }[]
  decidingOwnApplication: boolean
  onChanged: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [correctionReasonCategoryId, setCategoryId] = useState('')
  const [correctionReason, setReason] = useState('')

  const correctionReasons = reasonsFor(reasons, 'DECISION_CORRECTION')

  if (!open) {
    return (
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Correct the recorded decision
      </button>
    )
  }

  return (
    <DecisionForm
      title="Correct the recorded decision"
      confirmLabel="Record the correction"
      reasons={reasons}
      stages={stages}
      decidingOwnApplication={decidingOwnApplication}
      extra={
        <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
          <div>
            <label className="field-label" htmlFor="decision-correction-category">
              Why the record is changing
            </label>
            <select
              id="decision-correction-category"
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
            <label className="field-label" htmlFor="decision-correction-detail">
              What went wrong
            </label>
            <input
              id="decision-correction-detail"
              className="input"
              value={correctionReason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
      }
      onSubmit={async (draft) => {
        const data = await gql(CorrectDecisionDocument, {
          input: {
            applicationId,
            supersedesDecisionId,
            expectedStatusVersion: statusVersion,
            correctionReasonCategoryId,
            correctionReason: correctionReason.trim(),
            ...draft,
          },
        })
        unwrap(data.admin.decision.correctDecision)
        setOpen(false)
        await onChanged()
      }}
    />
  )
}
