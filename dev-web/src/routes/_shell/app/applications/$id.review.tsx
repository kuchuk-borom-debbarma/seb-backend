import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { ClosingNotice } from '#/features/application/ClosingNotice'
import {
  applicationQuery,
  draftChangesQuery,
  validationQuery,
} from '#/features/application/applicationQueries'
import { DOCUMENT_TITLES } from '#/features/application/documents'
import { SECTION_TITLES, fieldLabel } from '#/features/application/draft'
import {
  ResubmitApplicationDocument,
  SubmitApplicationDocument,
} from '#/graphql/generated/operations'
import type { DocumentType } from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

export const Route = createFileRoute('/_shell/app/applications/$id/review')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(validationQuery(params.id)),
      context.queryClient.ensureQueryData(draftChangesQuery(params.id)),
    ])
  },
  component: ReviewPage,
})

function ReviewPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: validation } = useQuery(validationQuery(id))
  const { data: changes } = useQuery(draftChangesQuery(id))

  // Resubmission answers a revision request; a first submission does not.
  const resubmission = application?.status === 'REVISION_REQUIRED'

  const submit = useMutation({
    mutationFn: async () => {
      const input = {
        applicationId: id,
        expectedVersion: application?.currentVersion ?? 0,
        expectedStatusVersion: application?.statusVersion ?? 0,
      }
      if (resubmission) {
        const data = await gql(ResubmitApplicationDocument, { input })
        return unwrap(data.seb.application.resubmit)
      }
      const data = await gql(SubmitApplicationDocument, { input })
      return unwrap(data.seb.application.submit)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['application', id] })
      await queryClient.invalidateQueries({ queryKey: ['applications'] })
      await queryClient.invalidateQueries({ queryKey: ['application-timeline', id] })
      await queryClient.invalidateQueries({ queryKey: ['draft-changes', id] })
      // The acknowledgement, not the application. Submitting is the moment the
      // whole thing has been building towards, and it should end somewhere that
      // says so and carries the reference number away with it.
      await router.navigate({ to: '/app/applications/$id/submitted', params: { id } })
    },
  })

  if (!application || !validation) return null

  const issues = validation.issues
  const changedSections = changes?.response?.sections ?? []

  return (
    <main className="page">
      <PageHeader
        title={resubmission ? 'Check and resubmit' : 'Check and submit'}
        description={
          resubmission
            ? 'Your corrections are checked against the whole application, not just the sections you changed.'
            : 'Submission freezes a copy of your answers and the documents attached to them.'
        }
      />

      <div className="stack">
        <ClosingNotice programmeCycleId={application.programmeCycleId} />

        {validation.valid ? (
          <p className="notice" data-tone="ok">
            <span className="notice-title">Everything needed is present</span>
            {resubmission
              ? 'Resubmitting resolves every open correction request and returns the application to the programme office.'
              : 'Submitting issues your reference number and sends the application to the programme office.'}
          </p>
        ) : (
          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Not ready yet</p>
                <h2 style={{ marginTop: '0.25rem' }}>
                  {issues.length} {issues.length === 1 ? 'thing' : 'things'} to fix
                </h2>
              </div>
              <div className="row">
                <Link to="/app/applications/$id/form" params={{ id }} className="button">
                  Go to the form
                </Link>
                <Link
                  to="/app/applications/$id/documents"
                  params={{ id }}
                  className="button"
                >
                  Evidence
                </Link>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Outstanding issues</caption>
                <thead>
                  <tr>
                    <th scope="col">Section</th>
                    <th scope="col">Question</th>
                    <th scope="col">What to do</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((issue) => (
                    <tr key={`${issue.section}-${issue.field}-${issue.code}`}>
                      {/*
                        Each issue links to the screen that fixes it. Missing
                        evidence is not fixed on the form: the files live on the
                        evidence screen, and sending someone to the wrong one is
                        worse than not linking at all.
                      */}
                      <td>
                        <Link
                          to={
                            issue.section === 'DOCUMENTS'
                              ? '/app/applications/$id/documents'
                              : '/app/applications/$id/form'
                          }
                          params={{ id }}
                          /*
                           * The control itself, not just the screen it is on.
                           * Every field carries its own name as its id, so the
                           * browser scrolls to it and focuses it on arrival —
                           * which for a form of forty questions is the
                           * difference between being told what is wrong and
                           * being taken to it.
                           */
                          hash={issue.section === 'DOCUMENTS' ? undefined : issue.field}
                        >
                          {SECTION_TITLES[issue.section] ?? humanize(issue.section)}
                        </Link>
                      </td>
                      {/* The question as the form asks it, so somebody sent to
                          fix it is looking for the same words. */}
                      <td className="muted">
                        {issue.section === 'DOCUMENTS'
                          ? (DOCUMENT_TITLES[issue.field as DocumentType] ??
                            humanize(issue.field))
                          : fieldLabel(issue.field)}
                      </td>
                      <td>{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/*
          Before resubmitting, the applicant sees exactly which sections their
          answers change — the same comparison a reviewer is shown.
        */}
        {changes?.response ? (
          <div className="card">
            <div className="card-header">
              <p className="eyebrow">
                What changed since submission{' '}
                {changes.response.comparedToSubmissionNumber}
              </p>
            </div>
            <div className="card-body">
              {changedSections.length === 0 ? (
                <p className="muted">
                  Nothing has changed yet. Resubmitting without a change would send the
                  same answers back.
                </p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {changedSections.map((section) => (
                    <li key={section}>{SECTION_TITLES[section] ?? humanize(section)}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {submit.isError ? (
          <p className="notice" data-tone="error" role="alert">
            {messageFor(submit.error)}
          </p>
        ) : null}

        <div className="row">
          <button
            type="button"
            className="button"
            data-variant="primary"
            disabled={!validation.valid || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending
              ? 'Submitting…'
              : resubmission
                ? 'Resubmit application'
                : 'Submit application'}
          </button>
          <Link to="/app/applications/$id/form" params={{ id }} className="button">
            Back to the form
          </Link>
        </div>
      </div>
    </main>
  )
}
