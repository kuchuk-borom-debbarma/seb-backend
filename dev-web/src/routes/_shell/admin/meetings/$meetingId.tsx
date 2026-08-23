/**
 * One committee meeting.
 *
 * A meeting has three states and they run one way: scheduled, in progress,
 * finalized. What can be done depends entirely on which it is in — an agenda is
 * built before the meeting, decisions are recorded during it, and afterwards
 * nothing moves. The screen offers only what the state allows rather than
 * showing controls that would be refused.
 *
 * Position is the agenda's whole meaning: it is the order the committee will
 * take the applications in. Moving an item therefore needs a reason, and the
 * API keeps it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import {
  meetingQuery,
  putMeeting,
  type MeetingWorkspace,
} from '#/features/admin/meetingQueries'
import {
  CancelMeetingDocument,
  FinalizeMeetingDocument,
  RemoveAgendaItemDocument,
  ReorderAgendaItemDocument,
  StartMeetingDocument,
  UpdateMeetingDocument,
} from '#/graphql/generated/operations'
import { AGENDA_TITLES, MEETING_STATES, MEETING_TITLES } from '#/features/admin/states'
import { formatDate, formatDateTime, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

export const Route = createFileRoute('/_shell/admin/meetings/$meetingId')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(meetingQuery(params.meetingId)),
  component: MeetingPage,
})

function MeetingPage() {
  const { meetingId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: workspace } = useQuery(meetingQuery(meetingId))
  const [error, setError] = useState<string | null>(null)

  const apply = (updated: MeetingWorkspace) => putMeeting(queryClient, meetingId, updated)

  const transition = useMutation({
    mutationFn: async (action: 'start' | 'finalize') => {
      const input = {
        meetingId,
        expectedVersion: workspace?.meeting.currentVersion ?? 0,
      }
      if (action === 'start') {
        const data = await gql(StartMeetingDocument, { input })
        return unwrap(data.admin.decision.startMeeting)
      }
      const data = await gql(FinalizeMeetingDocument, { input })
      return unwrap(data.admin.decision.finalizeMeeting)
    },
    onMutate: () => setError(null),
    onSuccess: apply,
    onError: (cause) => setError(messageFor(cause)),
  })

  if (!workspace) return null
  const { meeting, agenda, decisions } = workspace

  // A meeting is DRAFT while its agenda is being built, IN_SESSION while the
  // committee sits, then FINALIZED. What can be done follows from that alone.
  const planning = meeting.status === MEETING_STATES.draft
  const sitting = meeting.status === MEETING_STATES.inSession

  return (
    <main className="page">
      <PageHeader
        title={meeting.meetingReference}
        description={`${formatDateTime(meeting.scheduledAt)} · ${meeting.venue}`}
        actions={
          <>
            <span className="badge">
              {MEETING_TITLES[meeting.status] ?? humanize(meeting.status)}
            </span>
            {planning ? (
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={agenda.length === 0 || transition.isPending}
                onClick={() => transition.mutate('start')}
              >
                {transition.isPending ? 'Starting…' : 'Start the meeting'}
              </button>
            ) : null}
            {sitting ? (
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={transition.isPending}
                onClick={() => transition.mutate('finalize')}
              >
                {transition.isPending ? 'Finalizing…' : 'Finalize it'}
              </button>
            ) : null}
            <Link to="/admin/meetings" className="button">
              All meetings
            </Link>
          </>
        }
      />

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginBottom: '1rem' }}
        >
          {error}
        </p>
      ) : null}

      <div className="stack">
        {meeting.description ? (
          <p className="notice">
            <span className="notice-title">About this meeting</span>
            {meeting.description}
          </p>
        ) : null}

        {planning && agenda.length === 0 ? (
          <p className="notice" data-tone="warn">
            <span className="notice-title">The agenda is empty</span>
            An application is added to an agenda from its own workspace, once a partner
            bank has given an outcome. A meeting cannot start without one.
          </p>
        ) : null}

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Agenda</p>
            <span className="muted">
              {agenda.length} {agenda.length === 1 ? 'application' : 'applications'}
            </span>
          </div>
          {agenda.length === 0 ? (
            <div className="card-body">
              <p className="muted">Nothing on the agenda yet.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Applications on this agenda</caption>
                <thead>
                  <tr>
                    <th scope="col" data-numeric>
                      Position
                    </th>
                    <th scope="col">Application</th>
                    <th scope="col">State</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {[...agenda]
                    .sort((left, right) => left.position - right.position)
                    .map((item) => (
                      <tr key={item.id}>
                        <td data-numeric>{item.position}</td>
                        <td>
                          <Link
                            to="/admin/applications/$id"
                            params={{ id: item.applicationId }}
                            className="tabular"
                          >
                            Open the workspace
                          </Link>
                        </td>
                        <td>{AGENDA_TITLES[item.status] ?? humanize(item.status)}</td>
                        <td>
                          {planning ? (
                            <AgendaControls
                              meetingId={meetingId}
                              item={item}
                              onApplied={apply}
                            />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {decisions.length > 0 ? (
          <section className="card">
            <div className="card-header">
              <p className="eyebrow">Decisions</p>
            </div>
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">
                  Decisions taken at this meeting
                </caption>
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
                    <tr key={decision.id}>
                      <td>{humanize(decision.outcome)}</td>
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
          </section>
        ) : null}

        {planning ? (
          <MeetingSettings meetingId={meetingId} meeting={meeting} onApplied={apply} />
        ) : null}
      </div>
    </main>
  )
}

/** Moving an item up or down the agenda, or taking it off. */
function AgendaControls({
  meetingId,
  item,
  onApplied,
}: {
  meetingId: string
  item: { id: string; position: number; currentVersion: number }
  onApplied: (workspace: MeetingWorkspace) => void
}) {
  const [acting, setActing] = useState<'move' | 'remove' | null>(null)
  const [position, setPosition] = useState(String(item.position))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const move = useMutation({
    mutationFn: async () => {
      const data = await gql(ReorderAgendaItemDocument, {
        input: {
          meetingId,
          agendaItemId: item.id,
          expectedVersion: item.currentVersion,
          position: Number(position),
          reason: reason.trim(),
        },
      })
      return unwrap(data.admin.decision.reorderAgendaItem)
    },
    onMutate: () => setError(null),
    onSuccess: (workspace) => {
      setActing(null)
      setReason('')
      onApplied(workspace)
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  const remove = useMutation({
    mutationFn: async () => {
      const data = await gql(RemoveAgendaItemDocument, {
        input: {
          meetingId,
          agendaItemId: item.id,
          expectedVersion: item.currentVersion,
          reason: reason.trim(),
        },
      })
      return unwrap(data.admin.decision.removeAgendaItem)
    },
    onMutate: () => setError(null),
    onSuccess: (workspace) => {
      setActing(null)
      setReason('')
      onApplied(workspace)
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  if (!acting) {
    return (
      <div className="row">
        <button type="button" className="button" onClick={() => setActing('move')}>
          Move
        </button>
        <button
          type="button"
          className="button"
          data-variant="danger"
          onClick={() => setActing('remove')}
        >
          Take off
        </button>
      </div>
    )
  }

  const pending = move.isPending || remove.isPending

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (acting === 'move') move.mutate()
        else remove.mutate()
      }}
    >
      {acting === 'move' ? (
        <>
          <label className="field-label" htmlFor={`position-${item.id}`}>
            New position
          </label>
          <input
            id={`position-${item.id}`}
            className="input tabular"
            type="number"
            min={1}
            value={position}
            onChange={(event) => setPosition(event.target.value)}
          />
        </>
      ) : null}
      <label className="field-label" htmlFor={`reason-${item.id}`}>
        {acting === 'move' ? 'Why it is moving' : 'Why it is coming off'}
      </label>
      <input
        id={`reason-${item.id}`}
        className="input"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button
          type="submit"
          className="button"
          data-variant={acting === 'remove' ? 'danger' : undefined}
          disabled={!reason.trim() || pending}
        >
          {pending ? 'Working…' : acting === 'move' ? 'Move it' : 'Take it off'}
        </button>
        <button type="button" className="button" onClick={() => setActing(null)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Changing the time, place or reference of a meeting that has not started. */
function MeetingSettings({
  meetingId,
  meeting,
  onApplied,
}: {
  meetingId: string
  meeting: MeetingWorkspace['meeting']
  onApplied: (workspace: MeetingWorkspace) => void
}) {
  const [open, setOpen] = useState(false)
  const [meetingReference, setReference] = useState(meeting.meetingReference)
  const [scheduledAt, setScheduledAt] = useState(
    // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
    new Date(meeting.scheduledAt).toISOString().slice(0, 16),
  )
  const [venue, setVenue] = useState(meeting.venue)
  const [description, setDescription] = useState(meeting.description ?? '')
  const [reason, setReason] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = useMutation({
    mutationFn: async () => {
      const data = await gql(UpdateMeetingDocument, {
        input: {
          meetingId,
          expectedVersion: meeting.currentVersion,
          meetingReference: meetingReference.trim(),
          scheduledAt: new Date(scheduledAt).toISOString(),
          venue: venue.trim(),
          description: description.trim() || null,
          reason: reason.trim(),
        },
      })
      return unwrap(data.admin.decision.updateMeeting)
    },
    onMutate: () => setError(null),
    onSuccess: (workspace) => {
      setOpen(false)
      setReason('')
      onApplied(workspace)
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  const cancel = useMutation({
    mutationFn: async () => {
      const data = await gql(CancelMeetingDocument, {
        input: {
          meetingId,
          expectedVersion: meeting.currentVersion,
          reason: cancelReason.trim(),
        },
      })
      return unwrap(data.admin.decision.cancelMeeting)
    },
    onMutate: () => setError(null),
    onSuccess: (workspace) => {
      setCancelling(false)
      onApplied(workspace)
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  return (
    <section className="card">
      <div className="card-header">
        <p className="eyebrow">This meeting</p>
        <div className="row">
          {open ? null : (
            <button type="button" className="button" onClick={() => setOpen(true)}>
              Change the details
            </button>
          )}
          {cancelling ? null : (
            <button
              type="button"
              className="button"
              data-variant="danger"
              onClick={() => setCancelling(true)}
            >
              Cancel the meeting
            </button>
          )}
        </div>
      </div>

      {open ? (
        <div className="card-body">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              update.mutate()
            }}
          >
            <div className="detail-grid">
              <div>
                <label className="field-label" htmlFor="edit-reference">
                  Meeting reference
                </label>
                <input
                  id="edit-reference"
                  className="input tabular"
                  value={meetingReference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="edit-when">
                  When
                </label>
                <input
                  id="edit-when"
                  className="input"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="edit-venue">
                  Where
                </label>
                <input
                  id="edit-venue"
                  className="input"
                  value={venue}
                  onChange={(event) => setVenue(event.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="edit-description">
                  Description
                </label>
                <input
                  id="edit-description"
                  className="input"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="field-label" htmlFor="edit-reason">
                  Why it is changing
                </label>
                <input
                  id="edit-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <span className="field-hint">
                  People have been told when and where this meeting is, so a change is
                  recorded.
                </span>
              </div>
            </div>

            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={!reason.trim() || update.isPending}
              >
                {update.isPending ? 'Saving…' : 'Save the change'}
              </button>
              <button type="button" className="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {cancelling ? (
        <div className="card-body">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              cancel.mutate()
            }}
          >
            <label className="field-label" htmlFor="cancel-meeting-reason">
              Why the meeting is not happening
            </label>
            <input
              id="cancel-meeting-reason"
              className="input"
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            />
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button
                type="submit"
                className="button"
                data-variant="danger"
                disabled={!cancelReason.trim() || cancel.isPending}
              >
                {cancel.isPending ? 'Cancelling…' : 'Cancel the meeting'}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => setCancelling(false)}
              >
                Keep it
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {error ? (
        <div className="card-body">
          <p className="notice" data-tone="error" role="alert">
            {error}
          </p>
        </div>
      ) : null}
    </section>
  )
}
