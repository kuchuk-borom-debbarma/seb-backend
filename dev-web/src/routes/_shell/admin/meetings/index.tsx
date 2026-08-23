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
import { Pager } from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { MEETINGS_PAGE_SIZE, meetingsQuery } from '#/features/admin/meetingQueries'
import { CreateMeetingDocument } from '#/graphql/generated/operations'
import { MEETING_TITLES } from '#/features/admin/states'
import type { TtmMeetingStatus } from '#/graphql/generated/schema'
import { formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

type Search = { after?: string; status?: TtmMeetingStatus }

const STATUSES: TtmMeetingStatus[] = ['DRAFT', 'IN_SESSION', 'FINALIZED', 'CANCELLED']

export const Route = createFileRoute('/_shell/admin/meetings/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    status: STATUSES.includes(search.status as TtmMeetingStatus)
      ? (search.status as TtmMeetingStatus)
      : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(meetingsQuery(deps)),
  component: MeetingsPage,
})

function MeetingsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(meetingsQuery(search))
  const [creating, setCreating] = useState(false)

  const meetings = data?.nodes ?? []
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

        <div className="filters">
          <div>
            <label className="field-label" htmlFor="meeting-status">
              State
            </label>
            <select
              id="meeting-status"
              className="select"
              value={search.status ?? ''}
              onChange={(event) =>
                navigate({
                  search: (previous) => ({
                    ...previous,
                    status: (event.target.value || undefined) as
                      TtmMeetingStatus | undefined,
                    // A filter change invalidates the cursor.
                    after: undefined,
                  }),
                })
              }
            >
              <option value="">Any state</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {MEETING_TITLES[status] ?? humanize(status)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {meetings.length === 0 ? (
          <div className="card">
            <div className="empty">
              <h3>{search.status ? 'Nothing matches' : 'No meetings yet'}</h3>
              <p>
                {search.status
                  ? 'No meeting is in that state. Clearing the filter may bring some back.'
                  : 'Schedule one to start building an agenda.'}
              </p>
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
                  {meetings.map((meeting) => (
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
            <Pager
              shown={meetings.length}
              totalCount={data?.pageInfo.totalCount ?? 0}
              hasNextPage={data?.pageInfo.hasNextPage ?? false}
              atStart={!search.after}
              pageSize={MEETINGS_PAGE_SIZE}
              onFirst={() =>
                navigate({ search: (previous) => ({ ...previous, after: undefined }) })
              }
              onNext={() =>
                navigate({
                  search: (previous) => ({
                    ...previous,
                    after: data?.pageInfo.endCursor ?? undefined,
                  }),
                })
              }
            />
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
