import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import {
  ApplicationJourney,
  isDocumentIssue,
  stageForField,
} from '#/features/application/ApplicationJourney'
import { ClosingNotice } from '#/features/application/ClosingNotice'
import {
  applicationQuery,
  draftChangesQuery,
  formTemplateQuery,
  loadApplication,
  validationQuery,
} from '#/features/application/applicationQueries'
import { fieldLabel, stageTitle } from '#/features/application/draft'
import { resolveTemplate } from '#/features/application/formTemplate'
import {
  ResubmitApplicationDocument,
  SubmitApplicationDocument,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

export const Route = createFileRoute('/_shell/_applicant/applications/$id/review')({
  loader: ({ context, params }) =>
    Promise.all([
      loadApplication(context.queryClient, params.id),
      context.queryClient.fetchQuery(draftChangesQuery(params.id)),
    ]),
  component: ReviewPage,
})

function ReviewPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: validation } = useQuery(validationQuery(id))
  const { data: changes } = useQuery(draftChangesQuery(id))
  const { data: rawTemplate } = useQuery(formTemplateQuery(id))
  const template = useMemo(
    () => (rawTemplate ? resolveTemplate(rawTemplate) : null),
    [rawTemplate],
  )

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
      await router.navigate({ to: '/applications/$id/submitted', params: { id } })
    },
  })

  if (!application || !validation || !template) return null

  const issues = validation.issues
  const changedStages = changes?.response?.stageKeys ?? []

  return (
    <main className="page">
      <PageHeader
        title="Application form"
        description={
          resubmission
            ? 'Your corrections are checked against the whole application, not just the stages you changed.'
            : 'Submission freezes a copy of your answers and the documents attached to them.'
        }
      />

      <ApplicationJourney
        applicationId={id}
        template={template}
        activeStep="REVIEW"
        issues={issues}
        editableStageKeys={application.editableStageKeys}
        footerStatus={
          validation.valid ? (
            <span className="badge" data-tone="ok">
              Ready to submit
            </span>
          ) : (
            <span className="badge" data-tone="error">
              {issues.length} {issues.length === 1 ? 'item' : 'items'} to fix
            </span>
          )
        }
        footer={
          <>
            <Link to="/applications/$id/documents" params={{ id }} className="button">
              Back
            </Link>
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
          </>
        }
      >
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
              </div>
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">Outstanding issues</caption>
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">Question</th>
                      <th scope="col">What to do</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((issue) => {
                      /*
                       * Which screen fixes an issue is decided by the *kind of
                       * question*, not by the stage it sits in. A stage can
                       * carry both a missing file, fixed on the evidence
                       * screen, and an ordinary question that decides whether
                       * that file is wanted at all. Routing by stage sent the
                       * second to a screen with no such control on it — the
                       * applicant was told to fix something where it does not
                       * exist.
                       */
                      const evidence = isDocumentIssue(template, issue.field)
                      return (
                        <tr key={`${issue.stageKey}-${issue.field}-${issue.code}`}>
                          <td>
                            <Link
                              to={
                                evidence
                                  ? '/applications/$id/documents'
                                  : '/applications/$id/form'
                              }
                              params={{ id }}
                              search={
                                evidence
                                  ? undefined
                                  : {
                                      stage:
                                        stageForField(template, issue.field) ??
                                        issue.stageKey,
                                    }
                              }
                              /*
                               * The control itself, not just the screen it is
                               * on. Every field carries its own name as its id,
                               * so the browser scrolls to it and focuses it on
                               * arrival — which for a form of forty questions
                               * is the difference between being told what is
                               * wrong and being taken to it.
                               */
                              hash={issue.field}
                            >
                              {evidence
                                ? 'Evidence'
                                : stageTitle(issue.stageKey, template.stages)}
                            </Link>
                          </td>
                          {/* The question as the form asks it, so somebody sent
                              to fix it is looking for the same words. */}
                          <td className="muted">
                            {fieldLabel(issue.field, template.fields)}
                          </td>
                          <td>{issue.message}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/*
            Before resubmitting, the applicant sees exactly which stages their
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
                {changedStages.length === 0 ? (
                  <p className="muted">
                    Nothing has changed yet. Resubmitting without a change would send
                    the same answers back.
                  </p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                    {changedStages.map((stageKey) => (
                      <li key={stageKey}>{stageTitle(stageKey, template.stages)}</li>
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
        </div>
      </ApplicationJourney>
    </main>
  )
}
