/**
 * The evidence screen.
 *
 * One row per document the application can carry, showing what is attached and
 * what is still wanted. Which documents are *required* is decided by the cycle's
 * rules and by the answers given, and only the server knows that — so the
 * requirement shown against each row is the validation report's own message,
 * not a rule restated here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import {
  applicationQuery,
  loadApplication,
  validationQuery,
} from '#/features/application/applicationQueries'
import {
  DOCUMENT_TITLES,
  DOCUMENT_TYPES,
  FILE_ACCEPT,
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
import type { DocumentType } from '#/graphql/generated/schema'
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
  const queryClient = useQueryClient()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: validation } = useQuery(validationQuery(id))

  /** The API's message for each document type it says is missing. */
  const requirements = useMemo(() => {
    const byType: Partial<Record<DocumentType, string>> = {}
    for (const issue of validation?.issues ?? []) {
      if (issue.section === 'DOCUMENTS' && issue.code === 'DOCUMENT_REQUIRED') {
        byType[issue.field as DocumentType] = issue.message
      }
    }
    return byType
  }, [validation])

  /** The document attached for each type, deleted ones included. */
  const attached = useMemo(() => {
    const byType: Partial<Record<DocumentType, Document>> = {}
    for (const document of application?.documents ?? []) {
      byType[document.documentType] = document
    }
    return byType
  }, [application])

  /** Both queries are stale the moment any document changes. */
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['application', id] }),
      queryClient.invalidateQueries({ queryKey: ['validation', id] }),
    ])
  }

  if (!application) return null

  const editable = application.editableSections.includes('DOCUMENTS')

  return (
    <main className="page">
      <PageHeader
        title="Evidence"
        description={
          editable
            ? 'Attach a PDF, JPEG or PNG for each document, up to 5 MB.'
            : 'These documents are part of a submitted application and can no longer be changed.'
        }
      />

      <div className="stack">
        {DOCUMENT_TYPES.map((documentType) => (
          <DocumentRow
            key={documentType}
            applicationId={id}
            documentType={documentType}
            document={attached[documentType]}
            requirement={requirements[documentType]}
            editable={editable}
            onChanged={refresh}
          />
        ))}
      </div>

      <div className="row" style={{ marginTop: '1.5rem' }}>
        <Link
          to="/applications/$id/review"
          params={{ id }}
          className="button"
          data-variant="primary"
        >
          Check and submit
        </Link>
        <Link to="/applications/$id/form" params={{ id }} className="button">
          Back to the form
        </Link>
      </div>
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
  documentType,
  document,
  requirement,
  editable,
  onChanged,
}: {
  applicationId: string
  documentType: DocumentType
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
        documentType,
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
    <section className="card">
      <div className="card-header">
        <div>
          <h3>{DOCUMENT_TITLES[documentType]}</h3>
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
