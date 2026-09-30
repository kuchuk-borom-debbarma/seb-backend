import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Dialog } from '#/components/Dialog'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Lightbulb,
  Pencil,
} from 'lucide-react'
import {
  ApplicationJourney,
  isDocumentIssue,
  stageForField,
} from '#/features/application/ApplicationJourney'
import { ClosingNotice } from '#/features/application/ClosingNotice'
import { cyclesQuery } from '#/features/application/queries'
import {
  applicationQuery,
  draftChangesQuery,
  formTemplateQuery,
  loadApplication,
  validationQuery,
} from '#/features/application/applicationQueries'
import { readAnswer } from '#/features/application/AnswerSummary'
import { entriesOf, type AnswerEntry, type AnswerMap, type AnswerValue } from '#/features/application/answers'
import { formatBytes } from '#/features/application/documents'
import { fieldLabel, stageTitle } from '#/features/application/draft'
import {
  isRequiredWhenVisible,
  resolveTemplate,
  visibleFields,
  type FormField,
  type ResolvedTemplate,
} from '#/features/application/formTemplate'
import {
  DocumentDownloadUrlDocument,
  ResubmitApplicationDocument,
  SubmitApplicationDocument,
  type ApplicationByIdQuery,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { FormArtwork } from './$id.form'
import styles from './DraftForm.module.css'
import { awaitingCorrection } from '#/features/application/revision'

type Application = NonNullable<
  ApplicationByIdQuery['seb']['application']['byId']['response']
>
type Document = Application['documents'][number]

export const Route = createFileRoute('/_shell/_applicant/applications/$id/review')({
  loader: ({ context, params }) =>
    Promise.all([
      loadApplication(context.queryClient, params.id),
      context.queryClient.fetchQuery(draftChangesQuery(params.id)),
      // Read by the closing notice as the page mounts; asked for here so it
      // travels in the same request as the rest.
      context.queryClient.prefetchQuery(cyclesQuery),
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
  const resubmission = awaitingCorrection(application)

  // Submitting cannot be undone, so it is asked once more, in words.
  const [confirming, setConfirming] = useState(false)

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
    onSuccess: async (submitted) => {
      /*
       * The submission answers with the application as it now is, so that is
       * what the cache holds — the next page renders the reference number and
       * the stage straight away, with no request of its own.
       *
       * It used to only mark the application stale and move on. The next
       * page's loader then found the stale copy still in the cache and showed
       * it: no reference number, and "Where it is now: Draft" for an
       * application the office already had.
       *
       * What changed about the comparison to the last submission is not in
       * the response, so it is dropped rather than marked stale: the loader
       * has to fetch it, and cannot serve the old number meanwhile. The rest
       * is marked stale, not waited on.
       */
      queryClient.setQueryData(applicationQuery(id).queryKey, submitted)
      queryClient.removeQueries({ queryKey: ['draft-changes', id] })
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['applications'] }),
        queryClient.invalidateQueries({ queryKey: ['application-timeline', id] }),
      ])
      await router.navigate({ to: '/applications/$id/submitted', params: { id } })
    },
  })

  const download = useMutation({
    mutationFn: async (target: Document) => {
      const data = await gql(DocumentDownloadUrlDocument, {
        documentId: target.id,
      })
      return unwrap(data.seb.application.documentDownloadUrl).downloadUrl
    },
    onSuccess: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  })

  if (!application || !validation || !template) return null

  const issues = validation.issues
  const changedStages = changes?.response?.stageKeys ?? []
  const documents = application.documents.filter((document) => !document.deletedAt)
  const editable = (stageKey: string) =>
    !resubmission || application.editableStageKeys.includes(stageKey)
  const visible = visibleFields(template, application.answers)

  return (
    <div className={styles.pageShell}>
      <div className={styles.headerWrap}>
        <div className={styles.headerLeft}>
          <h1 className={styles.pageTitle}>Application form</h1>
          <p className={styles.pageDescription}>
            {resubmission
              ? 'Your corrections are checked against the whole application, not just the stages you changed.'
              : 'Submission freezes a copy of your answers and the documents attached to them.'}
          </p>
        </div>
        <FormArtwork />
      </div>

      <ClosingNotice programmeCycleId={application.programmeCycleId} />

      <ApplicationJourney
        applicationId={id}
        template={template}
        activeStep="REVIEW"
        issues={issues}
        correctionStageKeys={application.revisionRequests
          .filter((request) => request.resolvedAt === null && request.cancelledAt === null)
          .map((request) => request.stageKey)}
        editableStageKeys={application.editableStageKeys}
        footerLeft={
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <Link to="/applications/$id/documents" params={{ id }} className={styles.backButton}>
              <ArrowLeft size={16} aria-hidden="true" />
              <span>Back</span>
            </Link>
            {validation.valid ? (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: '#FEF9E7',
                  border: '1px solid #F5ECC8',
                  borderRadius: '8px',
                  padding: '8px 20px',
                }}
              >
                <Lightbulb size={16} color="#B8930C" />
                <span style={{ color: 'var(--ink)', fontSize: '13.5px', fontWeight: 600 }}>
                  Ready to submit
                </span>
              </div>
            ) : (
              <span className="badge" data-tone="error">
                {issues.length} {issues.length === 1 ? 'item' : 'items'} to fix
              </span>
            )}
          </div>
        }
        footerRight={
          <button
            type="button"
            className={styles.nextButton}
            disabled={!validation.valid || submit.isPending}
            onClick={() => setConfirming(true)}
          >
            <span>
              {submit.isPending
                ? 'Submitting…'
                : resubmission
                  ? 'Resubmit application'
                  : 'Submit application'}
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%' }}>
          {!validation.valid ? (
            <div className="card" style={{ marginBottom: '8px' }}>
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
                              hash={issue.field}
                            >
                              {evidence
                                ? 'Evidence'
                                : stageTitle(issue.stageKey, template.stages)}
                            </Link>
                          </td>
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
          ) : null}

          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--ink)', margin: '0 0 16px' }}>
              Your answers, read back
            </h3>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
                gap: '20px',
                width: '100%',
              }}
            >
              {template.stages.map((stage) => {
                const fields = template
                  .fieldsOfStage(stage.key)
                  .filter((field) => visible.has(field.key) && field.type !== 'FILE')
                // A stage with a file question lists the documents attached
                // to it, read from the template rather than guessed from the
                // stage's key, which is the cycle author's to choose.
                const isEvidenceStage = template
                  .fieldsOfStage(stage.key)
                  .some((field) => field.type === 'FILE' && visible.has(field.key))
                const stageDocuments = documents.filter(
                  (document) => template.byKey.get(document.fieldKey)?.stageKey === stage.key,
                )
                const stageTitleText = stage.title

                if (fields.length === 0 && !isEvidenceStage) return null

                return (
                  <div
                    key={stage.key}
                    style={{
                      background: '#ffffff',
                      border: '1px solid #D9DDE2',
                      borderRadius: '8px',
                      padding: '20px 22px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '16px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--ink)', margin: 0 }}>
                        {stageTitleText}
                      </h4>
                      {editable(stage.key) ? (
                        <Link
                          to="/applications/$id/form"
                          params={{ id }}
                          search={{ stage: stage.key }}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '4px 10px',
                            fontSize: '12px',
                            fontWeight: 500,
                            color: '#4271B7',
                            background: '#ffffff',
                            border: '1px solid #D9DDE2',
                            borderRadius: '6px',
                            textDecoration: 'none',
                          }}
                        >
                          <Pencil size={12} />
                          <span>Edit</span>
                        </Link>
                      ) : null}
                    </div>

                    {/* Fields */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {fields.map((field) =>
                        field.type === 'REPEAT_GROUP' ? (
                          <GroupEntries
                            key={field.key}
                            template={template}
                            field={field}
                            answers={application.answers}
                          />
                        ) : (
                          <FactRow
                            key={field.key}
                            label={
                              isRequiredWhenVisible(template, field, application.answers, visible)
                                ? field.label
                                : `${field.label} (optional)`
                            }
                            value={readAnswer(field, (application.answers[field.key] ?? null) as AnswerValue)}
                          />
                        ),
                      )}
                    </div>

                    {/* If Evidence Stage, show Documents attached table */}
                    {isEvidenceStage ? (
                      <div
                        style={{
                          marginTop: '4px',
                          paddingTop: '14px',
                          borderTop: '1px solid #F1F5F9',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--ink)' }}>
                            Documents attached
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
                              {stageDocuments.length} {stageDocuments.length === 1 ? 'document' : 'documents'}
                            </span>
                            <Link
                              to="/applications/$id/documents"
                              params={{ id }}
                              style={{
                                fontSize: '12px',
                                fontWeight: 500,
                                color: '#4271B7',
                                textDecoration: 'none',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '2px',
                              }}
                            >
                              <span>Change documents</span>
                              <ArrowUpRight size={13} />
                            </Link>
                          </div>
                        </div>

                        {stageDocuments.length === 0 ? (
                          <p style={{ fontSize: '12.5px', color: 'var(--ink-muted)', margin: 0 }}>
                            No documents are attached.
                          </p>
                        ) : (
                          <div style={{ width: '100%', overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid #E2E8F0', textAlign: 'left' }}>
                                  <th style={{ padding: '6px 8px 6px 0', fontSize: '11px', fontWeight: 600, color: 'var(--ink-muted)' }}>
                                    For
                                  </th>
                                  <th style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 600, color: 'var(--ink-muted)' }}>
                                    File
                                  </th>
                                  <th style={{ padding: '6px 0 6px 8px', fontSize: '11px', fontWeight: 600, color: 'var(--ink-muted)', textAlign: 'right' }}>
                                    File size
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {stageDocuments.map((doc) => (
                                  <tr key={doc.id} style={{ borderBottom: '1px solid #F1F5F9' }}>
                                    <td style={{ padding: '8px 8px 8px 0', fontWeight: 500, color: 'var(--ink)' }}>
                                      {template.byKey.get(doc.fieldKey)?.label ?? doc.fieldKey}
                                    </td>
                                    <td style={{ padding: '8px' }}>
                                      <button
                                        type="button"
                                        onClick={() => download.mutate(doc)}
                                        style={{
                                          background: 'transparent',
                                          border: 'none',
                                          padding: 0,
                                          color: '#4271B7',
                                          fontSize: '12px',
                                          textAlign: 'left',
                                          cursor: 'pointer',
                                          textDecoration: 'underline',
                                          wordBreak: 'break-all',
                                        }}
                                      >
                                        {doc.originalFilename}
                                      </button>
                                    </td>
                                    <td style={{ padding: '8px 0 8px 8px', textAlign: 'right', color: 'var(--ink-muted)', whiteSpace: 'nowrap' }} className="tabular">
                                      {formatBytes(doc.sizeBytes)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Revision history comparison */}
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
      <Dialog open={confirming} onClose={submit.isPending ? undefined : () => setConfirming(false)}>
        <div className={styles.leaveBackdrop} role="presentation">
          <div
            className={styles.leaveDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="submit-title"
            aria-describedby="submit-body"
          >
            <h2 id="submit-title" className={styles.leaveTitle}>
              {resubmission ? 'Send your corrections?' : 'Submit your application?'}
            </h2>
            <p id="submit-body" className={styles.leaveBody}>
              {resubmission
                ? 'Your corrected application goes back to the reviewers who asked for the changes. The sections you corrected are closed again once it is sent.'
                : 'The programme office receives a copy of your answers and documents exactly as they are now. You cannot change them afterwards unless the office asks you to.'}
            </p>
            {submit.isError ? (
              <p className="notice" data-tone="error" role="alert">
                {messageFor(submit.error)}
              </p>
            ) : null}
            <div className={styles.leaveActions}>
              <button
                type="button"
                className={styles.backButton}
                onClick={() => setConfirming(false)}
                disabled={submit.isPending}
              >
                Not yet
              </button>
              <button
                type="button"
                className={styles.nextButton}
                onClick={() => submit.mutate()}
                disabled={submit.isPending}
                autoFocus
              >
                {submit.isPending
                  ? 'Sending…'
                  : resubmission
                    ? 'Send corrections'
                    : 'Submit application'}
              </button>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '16px',
        fontSize: '13px',
      }}
    >
      <span style={{ color: 'var(--ink)', fontWeight: 600, flex: '1 1 auto' }}>
        {label}
      </span>
      <span style={{ color: 'var(--ink)', fontWeight: 400, textAlign: 'right', flex: '0 1 auto' }}>
        {value}
      </span>
    </div>
  )
}

function GroupEntries({
  template,
  field,
  answers,
}: {
  template: ResolvedTemplate
  field: FormField
  answers: AnswerMap
}) {
  const entries = entriesOf(answers, field.key)
  if (entries.length === 0) {
    return <FactRow label={field.label} value="None" />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {entries.map((entry: AnswerEntry, index) => {
        const visible = visibleFields(template, answers, entry, field.key)
        return (
          <div key={index} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {template
              .membersOfGroup(field.key)
              .filter((member) => visible.has(member.key) && member.type !== 'FILE')
              .map((member) => (
                <FactRow
                  key={member.key}
                  label={member.label}
                  value={readAnswer(member, entry[member.key] ?? null)}
                />
              ))}
          </div>
        )
      })}
    </div>
  )
}
