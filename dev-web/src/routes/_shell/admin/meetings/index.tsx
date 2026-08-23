/**
 * Committee meetings.
 *
 * The TTM meets, works through an agenda, and decides. This screen lists the
 * meetings and creates one; the agenda and the decisions belong to the meeting
 * itself, because that is the order they happen in.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { meetingsQuery } from '#/features/admin/meetingQueries'
import { CreateMeetingDocument } from '#/graphql/generated/operations'
import { MEETING_TITLES } from '#/features/admin/states'
import { formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

export const Route = createFileRoute('/_shell/admin/meetings/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(meetingsQuery),
  component: MeetingsPage,
})

function MeetingsPage() {
  const { data: meetings } = useQuery(meetingsQuery)
  const [creating, setCreating] = useState(false)
  const mark = useMarker()

  return (
    <main className="page">
      <PageHeader
        title="Committee meetings"
        description="Where approved applications are decided."
        actions={
          creating ? null : (
            <button
              type="button"
              className="button"
              data-variant="primary"
              onClick={() => setCreating(true)}
              {...mark('meetings-list')}
            >
              Schedule a meeting
            </button>
          )
        }
      />

      <div className="stack">
        {creating ? <MeetingForm onDone={() => setCreating(false)} /> : null}

        {meetings?.length === 0 ? (
          <div className="card">
            <div className="empty">
              <h3>No meetings yet</h3>
              <p>Schedule one to start building an agenda.</p>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Committee meetings</caption>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">When</th>
                    <th scope="col">Where</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings?.map((meeting) => (
                    <tr key={meeting.id}>
                      <td>
                        <Link
                          to="/admin/meetings/$meetingId"
                          params={{ meetingId: meeting.id }}
                          className="tabular"
                        >
                          {meeting.meetingReference}
                        </Link>
                      </td>
                      <td>{formatDateTime(meeting.scheduledAt)}</td>
                      <td>{meeting.venue}</td>
                      <td>
                        <span className="badge">
                          {MEETING_TITLES[meeting.status] ?? humanize(meeting.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

function MeetingForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [meetingReference, setReference] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [venue, setVenue] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: async () => {
      const data = await gql(CreateMeetingDocument, {
        input: {
          meetingReference: meetingReference.trim(),
          // A datetime-local value has no zone; the API takes ISO-8601, so it
          // is interpreted in the operator's own zone, which is where the
          // meeting is.
          scheduledAt: new Date(scheduledAt).toISOString(),
          venue: venue.trim(),
          description: description.trim() || null,
        },
      })
      return unwrap(data.admin.decision.createMeeting)
    },
    onMutate: () => setError(null),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['meetings'] })
      onDone()
      await navigate({
        to: '/admin/meetings/$meetingId',
        params: { meetingId: created.meeting.id },
      })
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  return (
    <section className="card">
      <div className="card-header">
        <p className="eyebrow">Schedule a meeting</p>
      </div>
      <div className="card-body">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <div className="detail-grid">
            <div>
              <label className="field-label" htmlFor="meeting-reference">
                Meeting reference
              </label>
              <input
                id="meeting-reference"
                className="input tabular"
                value={meetingReference}
                onChange={(event) => setReference(event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="meeting-when">
                When
              </label>
              <input
                id="meeting-when"
                className="input"
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="meeting-venue">
                Where
              </label>
              <input
                id="meeting-venue"
                className="input"
                value={venue}
                onChange={(event) => setVenue(event.target.value)}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="field-label" htmlFor="meeting-description">
                Description
              </label>
              <input
                id="meeting-description"
                className="input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <span className="field-hint">Optional.</span>
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

          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button
              type="submit"
              className="button"
              data-variant="primary"
              disabled={
                !meetingReference.trim() ||
                !scheduledAt ||
                !venue.trim() ||
                create.isPending
              }
            >
              {create.isPending ? 'Scheduling…' : 'Schedule it'}
            </button>
            <button type="button" className="button" onClick={onDone}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
