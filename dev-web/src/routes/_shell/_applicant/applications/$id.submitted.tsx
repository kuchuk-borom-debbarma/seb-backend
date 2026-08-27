/** Printable acknowledgement and frozen copy of the submitted application. */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { ApplicationSummary } from '#/features/application/ApplicationSummary'
import {
  applicationQuery,
  draftChangesQuery,
} from '#/features/application/applicationQueries'
import { formatDateTime, humanize } from '#/lib/format'

export const Route = createFileRoute('/_shell/_applicant/applications/$id/submitted')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(draftChangesQuery(params.id)),
    ])
  },
  component: SubmittedPage,
})

function SubmittedPage() {
  const { id } = Route.useParams()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: changes } = useQuery(draftChangesQuery(id))

  if (!application) return null

  const submissionNumber = changes?.response?.comparedToSubmissionNumber ?? null

  return (
    <main className="page">
      <PageHeader
        title="Your application has been submitted"
        description="The programme office can now see it. Keep the reference number — you will be asked for it."
        actions={
          <>
            <button
              type="button"
              className="button"
              data-variant="primary"
              onClick={() => window.print()}
            >
              Print this
            </button>
            <Link to="/applications/$id" params={{ id }} className="button">
              Go to the application
            </Link>
          </>
        }
      />

      <div className="stack">
        <section className="card">
          <div className="card-body">
            <div className="detail-grid">
              <div>
                <span className="field-label">Reference number</span>
                <span className="tabular" style={{ fontSize: '1.25rem' }}>
                  {application.referenceNumber}
                </span>
              </div>
              <div>
                <span className="field-label">Submitted</span>
                <span>{formatDateTime(application.updatedAt)}</span>
              </div>
              {submissionNumber ? (
                <div>
                  <span className="field-label">Submission</span>
                  <span className="tabular">{submissionNumber}</span>
                </div>
              ) : null}
              <div>
                <span className="field-label">Status</span>
                <span>{humanize(application.status)}</span>
              </div>
            </div>
          </div>
        </section>

        <ApplicationSummary application={application} />

        <p className="notice">
          <span className="notice-title">What happens next</span>
          The programme office checks your application. If anything needs correcting you
          will be told exactly which sections to change, and only those will open again.
        </p>
      </div>
    </main>
  )
}
