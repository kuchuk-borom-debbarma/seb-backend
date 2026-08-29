/**
 * The cycle's policy PDF: what is published, its scan verdict, its history,
 * and the controls to publish or replace it.
 *
 * The upload is the same three-step shape as applicant evidence — authorize,
 * PUT to the signed URL, finalize — because the bytes must not pass through
 * the Worker. The download URL is fetched on click: it expires in minutes and
 * must never sit in a cached query.
 */
import { useState } from 'react'
import {
  FinalizePolicyDocumentUploadDocument,
  IssuePolicyDocumentUploadDocument,
  PolicyDocumentDownloadUrlDocument,
} from '#/graphql/generated/operations'
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_MEGABYTES,
  checksumOf,
  formatBytes,
} from '#/features/application/documents'
import { formatDate } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

type PolicyDocument = {
  currentVersion: number
  originalFilename: string
  sizeBytes: number
  uploadedAt: string
  scanStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'ERROR'
  versions: Array<{
    version: number
    originalFilename: string
    sizeBytes: number
    uploadedAt: string
    scanStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'ERROR'
  }>
}

/** The verdict, said as what the officer can do about it. */
const SCAN_NOTES: Record<PolicyDocument['scanStatus'], string | null> = {
  ACCEPTED: null,
  PENDING: 'Being checked for malware — downloads unlock when it passes.',
  REJECTED: 'Failed its malware check. Upload a clean copy.',
  ERROR: 'The malware check could not conclude and will be retried.',
}

/** PDF-only, unlike applicant evidence, so the shared rejector does not fit. */
const rejectPolicyFile = (file: File): string | null => {
  if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) {
    return 'The policy document must be a PDF.'
  }
  if (file.size < 1) return 'This file is empty. Choose another one.'
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `This file is ${formatBytes(file.size)}. The largest the policy PDF can be is ${
      MAX_DOCUMENT_MEGABYTES
    } MB.`
  }
  return null
}

export function PolicyDocumentCard({
  cycleId,
  document,
  canManage,
  onChanged,
}: {
  cycleId: string
  document: PolicyDocument | null
  /** Whether upload/replace is offered: CYCLE_ADMIN, on a draft or open cycle. */
  canManage: boolean
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = async (version?: number) => {
    setError(null)
    try {
      const data = await gql(PolicyDocumentDownloadUrlDocument, {
        cycleId,
        version: version ?? null,
      })
      const link = unwrap(data.admin.programmeCycle.policyDocumentDownloadUrl)
      window.open(link.downloadUrl, '_blank', 'noopener')
    } catch (caught) {
      setError(messageFor(caught))
    }
  }

  const upload = async (file: File) => {
    const refused = rejectPolicyFile(file)
    if (refused) {
      setError(refused)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const issued = await gql(IssuePolicyDocumentUploadDocument, {
        input: {
          cycleId,
          expectedDocumentVersion: document?.currentVersion ?? 0,
          originalFilename: file.name,
          contentType: 'application/pdf',
          sizeBytes: file.size,
          checksumSha256: await checksumOf(file),
        },
      })
      const authorization = unwrap(issued.admin.programmeCycle.issuePolicyDocumentUpload)
      const stored = await fetch(authorization.uploadUrl, {
        method: 'PUT',
        // Exactly the headers the signature covers, sent as given.
        headers: Object.fromEntries(
          authorization.requiredHeaders.map((header) => [header.name, header.value]),
        ),
        body: file,
      })
      if (!stored.ok) {
        throw new Error(
          `The file could not be stored (${stored.status}). Check your connection and try again.`,
        )
      }
      const finalized = await gql(FinalizePolicyDocumentUploadDocument, {
        input: { uploadId: authorization.uploadId },
      })
      unwrap(finalized.admin.programmeCycle.finalizePolicyDocumentUpload)
      await onChanged()
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setBusy(false)
    }
  }

  const scanNote = document ? SCAN_NOTES[document.scanStatus] : null
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {document ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>
            {document.originalFilename} · {formatBytes(document.sizeBytes)} · version{' '}
            {document.currentVersion}
          </span>
          <button
            type="button"
            className="button"
            disabled={document.scanStatus !== 'ACCEPTED'}
            title={scanNote ?? undefined}
            onClick={() => void download()}
          >
            Download
          </button>
        </div>
      ) : (
        <span className="muted">
          Not uploaded yet. The cycle cannot open without the order or circular it
          implements.
        </span>
      )}
      {scanNote ? (
        <p className="notice" data-tone="warning" style={{ margin: 0 }}>
          {scanNote}
        </p>
      ) : null}
      {canManage ? (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="button" aria-hidden="true">
            {busy ? 'Uploading…' : document ? 'Replace (PDF)' : 'Upload the policy (PDF)'}
          </span>
          <input
            type="file"
            accept="application/pdf"
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              // Cleared so choosing the same corrected file again re-fires.
              event.target.value = ''
              if (file) void upload(file)
            }}
          />
        </label>
      ) : null}
      {document && document.versions.length > 1 ? (
        <details>
          <summary className="muted">
            Every version kept ({document.versions.length})
          </summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {document.versions.map((version) => (
              <li key={version.version}>
                v{version.version} · {version.originalFilename} ·{' '}
                {formatBytes(version.sizeBytes)} · {formatDate(version.uploadedAt)}
                {version.scanStatus === 'ACCEPTED' ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="button"
                      onClick={() => void download(version.version)}
                    >
                      Download
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? (
        <p className="notice" data-tone="error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
