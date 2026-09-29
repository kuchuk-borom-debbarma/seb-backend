/**
 * Taking a copy of the activity history.
 *
 * The one read that leaves the portal, so it asks why. The reason is required
 * by the API and recorded with the export — who took it, when, which filter
 * chose the rows and how many there were — and that record is written before
 * the file is handed over. The file holds exactly the rows the screen is
 * filtered to, because it is sent the same filter.
 */
import { useMutation } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Dialog } from '#/components/Dialog'
import { ExportAuditEventsDocument } from '#/graphql/generated/operations'
import type { AuditFilterInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import styles from './Audit.module.css'

/** Hands the browser a file without navigating away from the history. */
const download = (filename: string, csv: string) => {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // Revoked after the click has been handled, or the download can lose its source.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function ExportDialog({
  filter,
  onClose,
}: {
  filter: AuditFilterInput
  onClose: () => void
}) {
  const [purpose, setPurpose] = useState('')
  const exported = useMutation({
    mutationFn: async () =>
      unwrap(
        (await gql(ExportAuditEventsDocument, { input: { filter, purpose } })).audit
          .exportEvents,
      ),
    onSuccess: (file) => download(file.filename, file.csv),
  })

  return (
    <Dialog open onClose={onClose}>
      <div
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-export-title"
      >
        <form
          className={styles.dialog}
          onSubmit={(submitted) => {
            submitted.preventDefault()
            exported.mutate()
          }}
        >
          <div className={styles.dialogHeader}>
            <h2 id="audit-export-title">Export the activity history</h2>
            <button
              type="button"
              className="button"
              data-variant="ghost"
              aria-label="Close"
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.dialogBody}>
            <p>
              The file holds the entries these filters show, oldest first, up to 10,000.
              Taking it is recorded in this history with the reason you give.
            </p>
            <div>
              <label className="field-label" htmlFor="audit-export-purpose">
                Why is this being exported?
              </label>
              <textarea
                id="audit-export-purpose"
                className="textarea"
                required
                maxLength={500}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </div>
            {exported.error ? (
              <p className="notice" data-tone="error" role="alert">
                {messageFor(exported.error)}
              </p>
            ) : null}
            {exported.data ? (
              <p
                className="notice"
                data-tone={exported.data.truncated ? 'action' : 'ok'}
                role="status"
              >
                Downloaded {exported.data.rowCount}{' '}
                {exported.data.rowCount === 1 ? 'entry' : 'entries'}.
                {/* Said out loud: a file that silently stopped at the limit
                    would read as the whole history. */}
                {exported.data.truncated
                  ? ' The filters matched more than one export holds — narrow them to take the rest.'
                  : ''}
              </p>
            ) : null}
          </div>
          <div className={styles.dialogFooter}>
            <button type="button" className="button" onClick={onClose}>
              {exported.data ? 'Done' : 'Cancel'}
            </button>
            <button
              type="submit"
              className="button"
              data-variant="primary"
              disabled={exported.isPending || purpose.trim() === ''}
            >
              {exported.isPending ? 'Preparing…' : 'Export'}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}
