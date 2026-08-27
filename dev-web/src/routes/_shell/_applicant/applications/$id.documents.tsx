/**
 * The evidence screen.
 *
 * One row per `FILE` question the cycle asks, showing what is attached and what
 * is still wanted. Which documents exist at all, and which are *required*, are
 * both the cycle's decisions — the rows come from the template and the
 * requirement shown against each is the validation report's own message, not a
 * rule restated here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import {
  ATTACH_EVIDENCE,
  ApplicationJourney,
  issuesForStep,
} from '#/features/application/ApplicationJourney'
import {
  applicationQuery,
  formTemplateQuery,
  loadApplication,
  validationQuery,
} from '#/features/application/applicationQueries'
import { resolveTemplate, visibleFields } from '#/features/application/formTemplate'
import {
  FILE_ACCEPT,
  MAX_DOCUMENT_MEGABYTES,
  formatBytes,
  rejectFile,
  uploadDocument,
} from '#/features/application/documents'
import {
  DocumentDownloadUrlDocument,
  RestoreDocumentDocument,
  SoftDeleteDocumentDocument,
} from '#/graphql/generated/operations'
import type { ApplicationByIdQuery } from '#/graphql/generated/operations'
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { assertSucceeded, messageFor, unwrap } from '#/lib/result'

type Application = NonNullable<
  ApplicationByIdQuery['seb']['application']['byId']['response']
>
type Document = Application['documents'][number]

export const Route = createFileRoute('/_shell/_applicant/applications/$id/documents')({
  loader: ({ context, params }) => loadApplication(context.queryClient, params.id),
  component: DocumentsPage,
})

function DocumentsPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: validation } = useQuery(validationQuery(id))
  const { data: rawTemplate } = useQuery(formTemplateQuery(id))
  const template = useMemo(
    () => (rawTemplate ? resolveTemplate(rawTemplate) : null),
    [rawTemplate],
  )
  const hash = useLocation({ select: (location) => location.hash })

  /*
   * Arriving from the review table with a document slot named in the address.
   * Waits for the application, because until then the rows are not on the page
   * to focus.
   */
  useEffect(() => {
    if (!hash || !application) return
    const slot = document.getElementById(hash)
    if (!slot) return
    const stillness = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    slot.scrollIntoView({ block: 'center', behavior: stillness ? 'auto' : 'smooth' })
    slot.focus({ preventScroll: true })
  }, [application, hash])

  /** The API's message for each slot it says is missing. */
  const requirements = useMemo(() => {
    const byKey: Record<string, string> = {}
    for (const issue of validation?.issues ?? []) {
      if (issue.code === 'DOCUMENT_REQUIRED') byKey[issue.field] = issue.message
    }
    return byKey
  }, [validation])

  /** The document attached in each slot, deleted ones included. */
  const attached = useMemo(() => {
    const byKey: Record<string, Document> = {}
    for (const document of application?.documents ?? []) {
      byKey[document.fieldKey] = document
    }
    return byKey
  }, [application])

  /*
   * Only the slots this cycle asks, and only the ones its conditions leave on
   * screen: a document demanded by a question the applicant answered "no" to is
   * not asked for at all.
   */
  const slots = useMemo(() => {
    if (!template || !application) return []
    const visible = visibleFields(template, application.answers)
    return template.fields.filter(
      (field) => field.type === 'FILE' && visible.has(field.key),
    )
  }, [template, application])

  /** Both queries are stale the moment any document changes. */
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['application', id] }),
      queryClient.invalidateQueries({ queryKey: ['validation', id] }),
    ])
  }

  if (!application || !template) return null

  const editableStages = new Set(application.editableStageKeys)
  const documentIssues = issuesForStep(
    template,
    validation?.issues ?? [],
    ATTACH_EVIDENCE,
  )
  const lastStageKey = template.stages[template.stages.length - 1]?.key

  const continueToReview = async () => {
    if (documentIssues.length > 0) {
      const row = document.getElementById(documentIssues[0]?.field ?? '')
      row?.focus()
      row?.scrollIntoView({ block: 'center' })
      return
    }
    await router.navigate({ to: '/applications/$id/review', params: { id } })
  }

  return (
    <main className="page">
      <PageHeader
        title="Application form"
        description={
          editableStages.size > 0
            ? `Attach a PDF, JPEG or PNG for each document, up to ${MAX_DOCUMENT_MEGABYTES} MB.`
            : 'These documents are part of a submitted application and can no longer be changed.'
        }
      />

      <ApplicationJourney
        applicationId={id}
        template={template}
        activeStep={ATTACH_EVIDENCE}
        issues={validation?.issues ?? []}
        editableStageKeys={application.editableStageKeys}
        footerStatus={
          documentIssues.length > 0 ? (
            <span className="badge" data-tone="error" aria-live="polite">
              {documentIssues.length}{' '}
              {documentIssues.length === 1 ? 'required file' : 'required files'} missing
            </span>
          ) : (
            <span className="badge" data-tone="ok">
              Evidence requirements complete
            </span>
          )
        }
        footer={
          <>
            <button
              type="button"
              className="button"
              onClick={() =>
                void router.navigate({
                  to: '/applications/$id/form',
                  params: { id },
                  search: lastStageKey ? { stage: lastStageKey } : undefined,
                })
              }
            >
              Back
            </button>
            <button
              type="button"
              className="button"
              data-variant="primary"
              onClick={continueToReview}
            >
              Check and submit
            </button>
          </>
        }
      >
        <div className="stack">
          {slots.map((slot) => (
            <DocumentRow
              key={slot.key}
              applicationId={id}
              fieldKey={slot.key}
              title={slot.label}
              hint={slot.helpText}
              document={attached[slot.key]}
              requirement={requirements[slot.key]}
              /*
               * Per slot, because a document belongs to the stage its question
               * sits in and a revision reopens named stages. The API refuses on
               * exactly this rule, so a control offered here is one that works.
               */
              editable={editableStages.has(slot.stageKey)}
              onChanged={refresh}
            />
          ))}
        </div>
      </ApplicationJourney>
    </main>
  )
}

/**
 * One document: what is attached, and the one or two things that can be done
 * to it right now.
 *
 * A removed document is kept rather than hidden. The API soft-deletes it and
 * can restore the same version, so offering that is more honest — and cheaper
 * for the applicant — than making them upload the file again.
 */
function DocumentRow({
  applicationId,
  fieldKey,
  title,
  hint,
  document,
  requirement,
  editable,
  onChanged,
}: {
  applicationId: string
  fieldKey: string
  title: string
  hint: string | null
  document: Document | undefined
  requirement: string | undefined
  editable: boolean
  onChanged: () => Promise<void>
}) {
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const present = document && !document.deletedAt ? document : undefined
  const removed = document?.deletedAt ? document : undefined

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadDocument({
        applicationId,
        fieldKey,
        // 0 means "nothing attached yet"; anything else replaces that exact
        // version, and the server refuses if it moved in the meantime.
        expectedVersion: present?.currentVersion ?? 0,
        file,
      }),
    onSuccess: onChanged,
    onError: (cause) => setError(messageFor(cause)),
  })

  const remove = useMutation({
    mutationFn: async (target: Document) => {
      const data = await gql(SoftDeleteDocumentDocument, {
        input: {
          applicationId,
          documentId: target.id,
          expectedVersion: target.currentVersion,
        },
      })
      assertSucceeded(data.seb.application.softDeleteDocument)
    },
    onSuccess: onChanged,
    onError: (cause) => setError(messageFor(cause)),
  })

  const restore = useMutation({
    mutationFn: async (target: Document) => {
      const data = await gql(RestoreDocumentDocument, {
        input: {
          applicationId,
          documentId: target.id,
          expectedVersion: target.currentVersion,
        },
      })
      assertSucceeded(data.seb.application.restoreDocument)
    },
    onSuccess: onChanged,
    onError: (cause) => setError(messageFor(cause)),
  })

  /*
   * The download URL is signed and short-lived, so it is fetched at the moment
   * of the click rather than rendered into the page — a link put on screen
   * minutes earlier would already have expired.
   */
  const download = useMutation({
    mutationFn: async (target: Document) => {
      const data = await gql(DocumentDownloadUrlDocument, {
        documentId: target.id,
      })
      return unwrap(data.seb.application.documentDownloadUrl).downloadUrl
    },
    onSuccess: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    onError: (cause) => setError(messageFor(cause)),
  })

  const busy = upload.isPending || remove.isPending || restore.isPending

  const choose = (file: File | undefined) => {
    setError(null)
    if (!file) return
    const refusal = rejectFile(file)
    if (refusal) {
      setError(refusal)
      return
    }
    upload.mutate(file)
  }

  return (
    <section className="card" id={fieldKey} tabIndex={-1}>
      <div className="card-header">
        <div>
          <h3>{title}</h3>
          {hint ? <p className="field-hint">{hint}</p> : null}
          {present ? (
            <p className="field-hint">
              <span className="tabular">{present.originalFilename}</span> ·{' '}
              {formatBytes(present.sizeBytes)} · attached{' '}
              {formatDateTime(present.createdAt)}
              {present.currentVersion > 1 ? ` · version ${present.currentVersion}` : ''}
            </p>
          ) : removed ? (
            <p className="field-hint">
              Removed {formatDateTime(removed.deletedAt)}. It can be put back.
            </p>
          ) : requirement ? (
            <p className="field-error">{requirement}</p>
          ) : (
            <p className="field-hint">Not attached. This one is optional.</p>
          )}
        </div>

        <div className="row">
          {present ? (
            <button
              type="button"
              className="button"
              disabled={download.isPending}
              onClick={() => download.mutate(present)}
            >
              {download.isPending ? 'Opening…' : 'Open'}
            </button>
          ) : null}

          {editable && removed ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => restore.mutate(removed)}
            >
              {restore.isPending ? 'Putting back…' : 'Put back'}
            </button>
          ) : null}

          {/*
            Not while a removed document is sitting there.

            The button relabelled itself to "Attach a file" and stayed enabled,
            but the soft-deleted row still exists, so the API refuses every
            possible `expectedDocumentVersion` — 0 because a row is present,
            anything else because it is deleted. There was no value the client
            could have sent. The refusal even read "The document changed.
            Refresh it and try again", which refreshing never fixed. "Put back"
            above is the way through.
          */}
          {editable && !removed ? (
            <>
              <input
                ref={picker}
                type="file"
                accept={FILE_ACCEPT}
                hidden
                onChange={(event) => {
                  choose(event.target.files?.[0])
                  // Cleared so choosing the same file twice still fires.
                  event.target.value = ''
                }}
              />
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => picker.current?.click()}
              >
                {upload.isPending ? 'Uploading…' : present ? 'Replace' : 'Attach a file'}
              </button>
            </>
          ) : null}

          {editable && present ? (
            <button
              type="button"
              className="button"
              data-variant="danger"
              disabled={busy}
              onClick={() => remove.mutate(present)}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </button>
          ) : null}
        </div>
      </div>

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
