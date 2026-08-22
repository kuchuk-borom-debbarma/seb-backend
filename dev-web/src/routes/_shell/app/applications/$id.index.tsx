import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { StatusRail } from '#/features/application/StatusRail'
import { statusGuideQuery } from '#/features/application/queries'
import {
  applicationQuery,
  timelineQuery,
} from '#/features/application/applicationQueries'
import { formatDate, formatDateTime, humanize } from '#/lib/format'

/*
 * The overview is the index route beneath `$id`, not `$id` itself.
 *
 * In flat file routing a `$id.tsx` alongside `$id.form.tsx` becomes a layout
 * wrapping the form, so the overview would have had to render an outlet and
 * would have shown above every child screen. Naming it `.index` makes it a
 * sibling instead, which is what it actually is.
 */
export const Route = createFileRoute('/_shell/app/applications/$id/')({
  // All three start together: one round of requests, no waterfall.
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(timelineQuery(params.id)),
      context.queryClient.ensureQueryData(statusGuideQuery),
    ])
  },
  component: ApplicationPage,
})

function ApplicationPage() {
  const { id } = Route.useParams()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: timeline } = useQuery(timelineQuery(id))
  const { data: guide } = useQuery(statusGuideQuery)

  if (!application || !guide) return null

  const openRevisions = application.revisionRequests.filter(
    (request) => request.resolvedAt === null && request.cancelledAt === null,
  )

  return (
    <main className="page">
      <PageHeader
        title={application.referenceNumber ?? 'Unsubmitted draft'}
        description={
          application.applicationType === 'EXPANSION'
            ? `Expansion application, phase ${application.phaseNumber}`
            : 'Initial application'
        }
        actions={
          // Offered only while something can actually be changed or sent.
          application.editableSections.length > 0 ? (
            <>
              <Link
                to="/app/applications/$id/form"
                params={{ id }}
                className="button"
                data-variant="primary"
              >
                {application.status === 'REVISION_REQUIRED'
                  ? 'Make the corrections'
                  : 'Fill in the form'}
              </Link>
              <Link to="/app/applications/$id/review" params={{ id }} className="button">
                Check and submit
              </Link>
            </>
          ) : null
        }
      />

      <div className="stack">
        <StatusRail status={application.status} guide={guide} />

        {/*
          While revision is required, the requests are the most important thing
          on the page: they are the exact work the applicant has to do.
        */}
        {openRevisions.length > 0 ? (
          <div className="card">
            <div className="card-header">
              <p className="eyebrow">Changes requested</p>
            </div>
            <div className="card-body stack">
              {openRevisions.map((request) => (
                <div key={request.id} className="notice" data-tone="action">
                  <span className="notice-title">{humanize(request.section)}</span>
                  {request.note}
                  <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>
                    Requested {formatDateTime(request.requestedAt)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="card">
          <div className="card-header">
            <p className="eyebrow">Application</p>
          </div>
          <div className="card-body">
            <div className="detail-grid">
              <Detail label="Reference number">
                <span className="tabular">
                  {application.referenceNumber ?? 'Issued at first submission'}
                </span>
              </Detail>
              <Detail label="First submitted">
                {formatDate(application.firstSubmittedAt)}
              </Detail>
              <Detail label="Started">{formatDate(application.createdAt)}</Detail>
              <Detail label="Last changed">{formatDateTime(application.updatedAt)}</Detail>
              <Detail label="Sections you can edit">
                {application.editableSections.length === 0
                  ? 'None — this application is read-only'
                  : application.editableSections.map(humanize).join(', ')}
              </Detail>
              <Detail label="Documents attached">
                <span className="tabular">
                  {application.documents.filter((document) => !document.deletedAt).length}
                </span>
              </Detail>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <p className="eyebrow">History</p>
          </div>
          {timeline && timeline.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Application history</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((event) => (
                    <tr key={event.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(event.createdAt)}
                      </td>
                      <td>
                        <span style={{ fontWeight: 500 }}>{humanize(event.eventType)}</span>
                        {event.message ? (
                          <p className="muted" style={{ marginTop: '0.25rem' }}>
                            {event.message}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <p>Nothing has happened yet. Events appear here as your application moves.</p>
            </div>
          )}
        </div>
      </div>

      <p style={{ marginTop: '1.5rem' }}>
        <Link to="/app/applications">Back to applications</Link>
      </p>
    </main>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <span>{children}</span>
    </div>
  )
}
