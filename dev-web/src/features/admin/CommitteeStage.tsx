/**
 * The committee stage, seen from one application.
 *
 * Putting an application on an agenda and recording what the committee decided
 * both belong here rather than on the meeting screen, because both change this
 * application's status and this is where somebody looking at it will expect to
 * find them. The meeting screen owns the agenda's *order*, which is a property
 * of the meeting rather than of any one application.
 *
 * A decision is never edited. A correction supersedes the decision it replaces
 * and carries its own reason: one says what the committee decided, the other
 * says why the office is changing its record of it.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { meetingsQuery } from '#/features/admin/meetingQueries'
import { reasonsFor, type ReasonCategory } from '#/features/admin/workspaceQueries'
import { SECTION_TITLES } from '#/features/application/draft'
import {
  AddAgendaItemDocument,
  CorrectDecisionDocument,
  RecordDecisionDocument,
} from '#/graphql/generated/operations'
import type { ApplicationSection, TtmDecisionOutcome } from '#/graphql/generated/schema'
import { AGENDA_STATES, MEETING_STATES } from '#/features/admin/states'
import { formatDate, formatDateTime, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

type AgendaItem = {
  id: string
  applicationId: string
  submissionId: string
  bankOutcomeId: string
  position: number
  status: string
  currentVersion: number
}

type Decision = {
  id: string
  outcome: TtmDecisionOutcome
  decisionReference: string
  decisionDate: string
  approvedAmountPaise?: string | null
  applicantMessage: string
  createdAt: string
}

const OUTCOMES: { value: TtmDecisionOutcome; label: string; means: string }[] = [
  {
    value: 'APPROVED',
    label: 'Approved',
    means: 'The committee approves funding. A sanction order can then be issued.',
  },
  {
    value: 'REJECTED',
    label: 'Rejected',
    means: 'The application is closed without funding.',
  },
  {
    value: 'DEFERRED',
    label: 'Deferred',
    means: 'The committee did not decide. The application waits for a later meeting.',
  },
  {
    value: 'REVISION_REQUIRED',
    label: 'Correction needed',
    means:
      'The sections you name unlock for the applicant, and the application returns to them.',
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

export function CommitteeStage({
  applicationId,
  status,
  statusVersion,
  latestSubmissionId,
  latestBankOutcomeId,
  agenda,
  decisions,
  reasons,
  onChanged,
}: {
  applicationId: string
  status: string
  statusVersion: number
  latestSubmissionId: string | undefined
  latestBankOutcomeId: string | undefined
  agenda: AgendaItem[]
  decisions: Decision[]
  reasons: ReasonCategory[] | undefined
  onChanged: () => Promise<unknown>
}) {
  // An item waiting to be taken, or one already decided. A removed item is
  // history and offers nothing.
  const listed = agenda.find(
    (item) =>
      item.status === AGENDA_STATES.active || item.status === AGENDA_STATES.decided,
  )
  const latestDecision = decisions.at(-1)

  // Nothing to say until a bank has answered: the agenda item is built from
  // that outcome, and the API will not accept one without it.
  if (!latestBankOutcomeId && agenda.length === 0 && decisions.length === 0) return null

  return (
    <section className="card">
      <div className="card-header">
        <p className="eyebrow">Committee</p>
        {listed ? <span className="badge">On an agenda</span> : null}
      </div>

      {decisions.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">What the committee decided</caption>
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
                  </td>
                  <td className="tabular">{decision.decisionReference}</td>
                  <td>{formatDate(decision.decisionDate)}</td>
                  <td className="tabular">
                    {decision.approvedAmountPaise
                      ? formatMoney(decision.approvedAmountPaise)
                      : '—'}
                  </td>
                  <td>{decision.applicantMessage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card-body">
        {!listed &&
        latestSubmissionId &&
        latestBankOutcomeId &&
        status === 'TTM_REVIEW' ? (
          <PutOnAgenda
            applicationId={applicationId}
            submissionId={latestSubmissionId}
            bankOutcomeId={latestBankOutcomeId}
            onChanged={onChanged}
          />
        ) : null}

        {listed && decisions.length === 0 ? (
          <DecisionForm
            title="Record what the committee decided"
            confirmLabel="Record the decision"
            reasons={reasons}
            onSubmit={async (draft) => {
              const data = await gql(RecordDecisionDocument, {
                input: {
                  applicationId,
                  agendaItemId: listed.id,
                  expectedStatusVersion: statusVersion,
                  ...draft,
                },
              })
              unwrap(data.admin.decision.recordDecision)
              await onChanged()
            }}
          />
        ) : null}

        {listed && latestDecision ? (
          <CorrectDecision
            applicationId={applicationId}
            agendaItemId={listed.id}
            supersedesDecisionId={latestDecision.id}
            statusVersion={statusVersion}
            reasons={reasons}
            onChanged={onChanged}
          />
        ) : null}

        {listed && decisions.length === 0 ? (
          /*
           * The API accepts a decision only while the meeting is sitting, and
           * only from the person who holds the application. Neither fact is
           * visible from here — an agenda item does not report which meeting it
           * is on — so the rule is stated rather than left to be discovered
           * from a refusal that says the record changed, which it had not.
           */
          <p className="notice" data-tone="warn" style={{ marginTop: '0.75rem' }}>
            <span className="notice-title">
              A decision can only be recorded while the meeting is sitting
            </span>
            This application is on an agenda at position {listed.position}. Start the
            meeting from <Link to="/admin/meetings">committee meetings</Link> first, and
            make sure you still hold this application.
          </p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Adding this application to a meeting's agenda.
 *
 * Only meetings that have not started can take a new item, so only those are
 * offered.
 */
function PutOnAgenda({
  applicationId,
  submissionId,
  bankOutcomeId,
  onChanged,
}: {
  applicationId: string
  submissionId: string
  bankOutcomeId: string
  onChanged: () => Promise<unknown>
}) {
  const { data: meetings } = useQuery(meetingsQuery)
  const [meetingId, setMeetingId] = useState('')
  const [position, setPosition] = useState('1')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: async () => {
      const data = await gql(AddAgendaItemDocument, {
        input: {
          meetingId,
          applicationId,
          submissionId,
          bankOutcomeId,
          position: Number(position),
        },
      })
      unwrap(data.admin.decision.addAgendaItem)
    },
    onMutate: () => setError(null),
    onSuccess: onChanged,
    onError: (cause) => setError(messageFor(cause)),
  })

  // Only a meeting still being planned can take a new item.
  const open = (meetings ?? []).filter(
    (meeting) => meeting.status === MEETING_STATES.draft,
  )

  if (open.length === 0) {
    return (
      <p className="notice" data-tone="warn">
        <span className="notice-title">No meeting is taking new items</span>
        An application can only join an agenda before its meeting starts. Schedule one in
        committee meetings.
      </p>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        add.mutate()
      }}
    >
      <h4>Put this on an agenda</h4>
      <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor="agenda-meeting">
            Meeting
          </label>
          <select
            id="agenda-meeting"
            className="select"
            value={meetingId}
            onChange={(event) => setMeetingId(event.target.value)}
          >
            <option value="">Choose a meeting</option>
            {open.map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                {meeting.meetingReference} · {formatDateTime(meeting.scheduledAt)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="agenda-position">
            Position
          </label>
          <input
            id="agenda-position"
            className="input tabular"
            type="number"
            min={1}
            value={position}
            onChange={(event) => setPosition(event.target.value)}
          />
          <span className="field-hint">The order the committee will take it in.</span>
        </div>
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
        disabled={!meetingId || add.isPending}
      >
        {add.isPending ? 'Adding…' : 'Add it to the agenda'}
      </button>
    </form>
  )
}

type DecisionDraft = {
  outcome: TtmDecisionOutcome
  decisionReference: string
  decisionDate: string
  approvedAmountPaise?: string | null
  applicantConditions?: string | null
  reasonCategoryId?: string | null
  applicantMessage: string
  nextAction?: string | null
  revisions: {
    section: ApplicationSection
    reasonCategoryId: string
    note: string
  }[]
}

function DecisionForm({
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
  onSubmit: (draft: DecisionDraft) => Promise<void>
}) {
  const [outcome, setOutcome] = useState<TtmDecisionOutcome | ''>('')
  const [decisionReference, setReference] = useState('')
  const [decisionDate, setDate] = useState('')
  const [approvedRupees, setApproved] = useState('')
  const [applicantConditions, setConditions] = useState('')
  const [applicantMessage, setMessage] = useState('')
  const [nextAction, setNextAction] = useState('')
  const [reasonCategoryId, setCategoryId] = useState('')
  const [revisions, setRevisions] = useState<
    Partial<Record<ApplicationSection, { reasonCategoryId: string; note: string }>>
  >({})
  const [error, setError] = useState<string | null>(null)

  const revisionReasons = reasonsFor(reasons, 'REVISION')
  const deferralReasons = reasonsFor(reasons, 'TTM_DEFERRAL')
  const rejectionReasons = reasonsFor(reasons, 'REJECTION')

  const chosen = Object.entries(revisions) as [
    ApplicationSection,
    { reasonCategoryId: string; note: string },
  ][]

  const submit = useMutation({
    mutationFn: () =>
      onSubmit({
        outcome: outcome as TtmDecisionOutcome,
        decisionReference: decisionReference.trim(),
        decisionDate,
        approvedAmountPaise:
          outcome === 'APPROVED' && approvedRupees.trim() !== ''
            ? String(Math.round(Number(approvedRupees) * 100))
            : null,
        applicantConditions: applicantConditions.trim() || null,
        reasonCategoryId: reasonCategoryId || null,
        applicantMessage: applicantMessage.trim(),
        nextAction: nextAction.trim() || null,
        revisions:
          outcome === 'REVISION_REQUIRED'
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

  /** Which reason catalogue applies, if any, for the chosen outcome. */
  const outcomeReasons =
    outcome === 'DEFERRED'
      ? deferralReasons
      : outcome === 'REJECTED'
        ? rejectionReasons
        : []

  const ready =
    Boolean(outcome) &&
    decisionReference.trim() &&
    decisionDate &&
    applicantMessage.trim() &&
    (outcome !== 'APPROVED' || approvedRupees.trim() !== '') &&
    (outcomeReasons.length === 0 || Boolean(reasonCategoryId)) &&
    (outcome !== 'REVISION_REQUIRED' ||
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
              name="ttm-outcome"
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
                        <label className="field-label" htmlFor={`ttm-${section}-reason`}>
                          Reason
                        </label>
                        <select
                          id={`ttm-${section}-reason`}
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
                        <label className="field-label" htmlFor={`ttm-${section}-note`}>
                          What the applicant must do
                        </label>
                        <input
                          id={`ttm-${section}-note`}
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

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="decision-next">
          What happens next
        </label>
        <input
          id="decision-next"
          className="input"
          value={nextAction}
          onChange={(event) => setNextAction(event.target.value)}
        />
        <span className="field-hint">Optional.</span>
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

function CorrectDecision({
  applicationId,
  agendaItemId,
  supersedesDecisionId,
  statusVersion,
  reasons,
  onChanged,
}: {
  applicationId: string
  agendaItemId: string
  supersedesDecisionId: string
  statusVersion: number
  reasons: ReasonCategory[] | undefined
  onChanged: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [correctionReasonCategoryId, setCategoryId] = useState('')
  const [correctionReason, setReason] = useState('')

  const correctionReasons = reasonsFor(reasons, 'TTM_DECISION_CORRECTION')

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
      extra={
        <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
          <div>
            <label className="field-label" htmlFor="ttm-correction-category">
              Why the record is changing
            </label>
            <select
              id="ttm-correction-category"
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
            <label className="field-label" htmlFor="ttm-correction-detail">
              What went wrong
            </label>
            <input
              id="ttm-correction-detail"
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
            agendaItemId,
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
