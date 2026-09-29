import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  FileText,
  Upload,
} from 'lucide-react'
import {
  ATTACH_EVIDENCE,
  ApplicationJourney,
  issuesForStep,
} from '#/features/application/ApplicationJourney'
import { ClosingNotice } from '#/features/application/ClosingNotice'
import {
  applicationQuery,
  formTemplateQuery,
  loadApplication,
  validationQuery,
} from '#/features/application/applicationQueries'
import { resolveTemplate, visibleFields } from '#/features/application/formTemplate'
import {
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
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { assertSucceeded, messageFor, unwrap } from '#/lib/result'
import { FormArtwork } from './$id.form'
import styles from './DraftForm.module.css'

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
    <div className={styles.pageShell}>
      <div className={styles.headerWrap}>
        <div className={styles.headerLeft}>
          <h1 className={styles.pageTitle}>Application form</h1>
          <p className={styles.pageDescription}>
            {editableStages.size > 0
              ? 'Your answers are saved as you type.'
              : 'These documents are part of a submitted application and can no longer be changed.'}
          </p>
        </div>
        <FormArtwork />
      </div>

      {editableStages.size > 0 ? (
        <ClosingNotice programmeCycleId={application.programmeCycleId} />
      ) : null}

      <ApplicationJourney
        applicationId={id}
        template={template}
        activeStep={ATTACH_EVIDENCE}
        issues={validation?.issues ?? []}
        editableStageKeys={application.editableStageKeys}
        footerLeft={
          <button
            type="button"
            className={styles.backButton}
            onClick={() =>
              void router.navigate({
                to: '/applications/$id/form',
                params: { id },
                search: lastStageKey ? { stage: lastStageKey } : undefined,
              })
            }
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back</span>
          </button>
        }
        footerRight={
          <button
            type="button"
            className={styles.nextButton}
            onClick={continueToReview}
          >
            <span>Check and submit</span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {slots.map((slot, index) => (
              <DocumentRow
                key={slot.key}
                applicationId={id}
                fieldKey={slot.key}
                title={slot.label}
                hint={slot.helpText}
                document={attached[slot.key]}
                requirement={requirements[slot.key]}
                isLast={index === slots.length - 1}
                editable={editableStages.has(slot.stageKey)}
                onChanged={refresh}
              />
            ))}
          </div>

          {documentIssues.length > 0 ? (
            <div
              role="alert"
              style={{
                background: '#fdf2f2',
                border: '1px solid #fca5a5',
                borderRadius: '8px',
                padding: '12px 18px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginTop: '24px',
              }}
            >
              <AlertTriangle size={18} color="#C92929" strokeWidth={2} />
              <span style={{ color: '#C92929', fontSize: '14px', fontWeight: 600 }}>
                {documentIssues.length}{' '}
                {documentIssues.length === 1 ? 'required file missing' : 'required files missing'}
              </span>
            </div>
          ) : null}
        </div>
      </ApplicationJourney>
    </div>
  )
}
function DocumentRow({
  applicationId,
  fieldKey,
  title,
  document,
  requirement,
  isLast,
  editable,
  onChanged,
}: {
  applicationId: string
  fieldKey: string
  title: string
  hint: string | null
  document: Document | undefined
  requirement: string | undefined
  isLast: boolean
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
    <div
      id={fieldKey}
      tabIndex={-1}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 8px',
        borderBottom: isLast ? 'none' : '1px solid #f1f5f9',
        gap: '16px',
      }}
    >
      {/* Left: Document icon + Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: '220px', flex: '0 0 240px' }}>
        <FileText size={18} color="var(--ink)" strokeWidth={1.8} />
        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)' }}>
          {title}
        </span>
      </div>

      {/* Middle: Upload status */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {present ? (
          <span style={{ fontSize: '13px', color: 'var(--ink-secondary)', fontWeight: 500 }}>
            <span className="tabular">{present.originalFilename}</span> · {formatBytes(present.sizeBytes)}
            {present.currentVersion > 1 ? ` · v${present.currentVersion}` : ''}
          </span>
        ) : removed ? (
          <span style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            Removed {formatDateTime(removed.deletedAt)}. Can be restored.
          </span>
        ) : requirement ? (
          <span style={{ fontSize: '13px', color: 'var(--danger)', fontWeight: 400 }}>
            {title} has not been uploaded.
          </span>
        ) : (
          <span style={{ fontSize: '13px', color: 'var(--ink-muted)', fontWeight: 400 }}>
            Not attached. This one is optional.
          </span>
        )}
        {error ? (
          <p className="field-error" style={{ margin: '4px 0 0', fontSize: '12px' }} role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {/* Right: Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        {present ? (
          <button
            type="button"
            className="button"
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              fontWeight: 500,
              background: '#ffffff',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--ink)',
            }}
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
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              fontWeight: 500,
              background: '#ffffff',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--ink)',
            }}
            disabled={busy}
            onClick={() => restore.mutate(removed)}
          >
            {restore.isPending ? 'Putting back…' : 'Put back'}
          </button>
        ) : null}

        {editable && !removed ? (
          <>
            <input
              ref={picker}
              type="file"
              accept={FILE_ACCEPT}
              hidden
              onChange={(event) => {
                choose(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            <button
              type="button"
              className="button"
              style={{
                padding: '6px 14px',
                fontSize: '13px',
                fontWeight: 500,
                background: '#ffffff',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                color: 'var(--ink)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
              disabled={busy}
              onClick={() => picker.current?.click()}
            >
              <span>{upload.isPending ? 'Uploading…' : present ? 'Replace' : 'Attach a file'}</span>
              <Upload size={13} strokeWidth={2} />
            </button>
          </>
        ) : null}

        {editable && present ? (
          <button
            type="button"
            className="button"
            data-variant="danger"
            style={{
              padding: '6px 10px',
              fontSize: '13px',
            }}
            disabled={busy}
            onClick={() => remove.mutate(present)}
          >
            {remove.isPending ? 'Removing…' : 'Remove'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
