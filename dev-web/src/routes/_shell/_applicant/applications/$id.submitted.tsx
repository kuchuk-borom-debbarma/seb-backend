/**
 * The submission acknowledgement.
 *
 * Submitting is the moment the whole application has been building towards, and
 * until now it ended with a redirect back to a screen that looked much like the
 * one before. This says what happened, gives the reference number the applicant
 * will quote for the next year, and shows exactly what was frozen — because a
 * submission is a copy taken at a moment, and "exactly what I sent" is the one
 * question an acknowledgement has to answer.
 *
 * It is printable. An applicant who may be doing this once in their life should
 * be able to keep a copy on paper, and the print rules hide the navigation and
 * the actions so the page prints as a document rather than a screenshot.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { useMemo } from 'react'
import { AnswerSummary } from '#/features/application/AnswerSummary'
import {
  applicationQuery,
  draftChangesQuery,
  formTemplateQuery,
} from '#/features/application/applicationQueries'
import { formatBytes } from '#/features/application/documents'
import { resolveTemplate } from '#/features/application/formTemplate'
import { formatDateTime, humanize } from '#/lib/format'

export const Route = createFileRoute('/_shell/_applicant/applications/$id/submitted')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(draftChangesQuery(params.id)),
      context.queryClient.ensureQueryData(formTemplateQuery(params.id)),
    ])
  },
  component: SubmittedPage,
})

function SubmittedPage() {
  const { id } = Route.useParams()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: changes } = useQuery(draftChangesQuery(id))
  const { data: rawTemplate } = useQuery(formTemplateQuery(id))
  const template = useMemo(
    () => (rawTemplate ? resolveTemplate(rawTemplate) : null),
    [rawTemplate],
  )

  if (!application || !template) return null

  /*
   * The applicant API does not report a submission number of its own. What it
   * does report is the submission a draft is measured against, which — with
   * nothing changed since — is the submission just made. Anything else here
   * would be a number invented in the browser.
   */
  const submissionNumber = changes?.response?.comparedToSubmissionNumber ?? null
  const documents = application.documents.filter((document) => !document.deletedAt)

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

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">What was submitted</p>
            <span className="muted">A copy, frozen at the moment above</span>
          </div>
          <div className="card-body">
            <AnswerSummary template={template} answers={application.answers} />
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Documents attached</p>
            <span className="muted">
              {documents.length} {documents.length === 1 ? 'document' : 'documents'}
            </span>
          </div>
          {documents.length === 0 ? (
            <div className="card-body">
              <p className="muted">No documents were attached.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">
                  Documents attached to this submission
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Document</th>
                    <th scope="col">File</th>
                    <th scope="col">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((document) => (
                    <tr key={document.id}>
                      <td>{template.byKey.get(document.fieldKey)?.label ?? document.fieldKey}</td>
                      <td className="tabular">{document.originalFilename}</td>
                      <td className="tabular">{formatBytes(document.sizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="notice">
          <span className="notice-title">What happens next</span>
          The programme office checks your application. If anything needs correcting you
          will be told exactly which stages to change, and only those will open again.
        </p>
      </div>
    </main>
  )
}
