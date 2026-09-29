/**
 * One entry of the activity history, in full.
 *
 * Opened from a row and addressed by the URL (`?event=`), so the back button
 * closes it and an entry can be sent to a colleague as a link. It shows what
 * the table cannot fit: every recorded value, labelled; where the request came
 * from; the other entries the same request produced; and the record exactly as
 * stored, for anybody who needs the raw form.
 */
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Dialog } from '#/components/Dialog'
import { formatDateTime, humanize } from '#/lib/format'
import { messageFor } from '#/lib/result'
import { AuditDetailValue } from './AuditDetailValue'
import { auditEventQuery } from './auditQueries'
import { AuditApplication, AuditPerson } from './AuditTable'
import styles from './Audit.module.css'
import timeline from './AuditTimeline.module.css'

export function AuditEntryDialog({
  id,
  onClose,
  onOpen,
  onShowRequest,
}: {
  id: string
  onClose: () => void
  /** Another entry, chosen from this one's request. */
  onOpen: (id: string) => void
  /** The whole request as a filter on the history itself. */
  onShowRequest: (requestId: string) => void
}) {
  const { data, error, isPending } = useQuery(auditEventQuery(id))
  const event = data?.event

  return (
    <Dialog open onClose={onClose}>
      <div
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-entry-title"
      >
        <div className={styles.dialog}>
          <div className={styles.dialogHeader}>
            <div>
              <p className="eyebrow">
                {event
                  ? `${humanize(event.category)} · ${event.actionLabel}`
                  : 'Activity'}
              </p>
              <h2 id="audit-entry-title">{event?.summary ?? 'Entry'}</h2>
            </div>
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
            {isPending ? <p className="muted">Reading the entry…</p> : null}
            {error ? (
              <p className="notice" data-tone="error" role="alert">
                {messageFor(error)}
              </p>
            ) : null}

            {event ? (
              <>
                {/*
                  Said, rather than left for somebody to wonder why this entry
                  has so little in it: it was written before each action
                  declared what it records, and it is shown exactly as stored.
                */}
                {!event.detailed ? (
                  <p className="notice">
                    Recorded before detailed history. What it stored is shown below
                    exactly as written.
                  </p>
                ) : null}

                <dl className={styles.details}>
                  <dt>When</dt>
                  <dd className="tabular">{formatDateTime(event.createdAt)}</dd>
                  <dt>Who</dt>
                  <dd>
                    <AuditPerson person={event.actor} />
                  </dd>
                  {event.subject ? (
                    <>
                      <dt>About</dt>
                      <dd>{event.subject.email}</dd>
                    </>
                  ) : null}
                  {event.application ? (
                    <>
                      <dt>Application</dt>
                      <dd>
                        <AuditApplication application={event.application} />
                      </dd>
                    </>
                  ) : null}
                  <dt>Outcome</dt>
                  <dd>{event.outcome === 'SUCCESS' ? 'Succeeded' : 'Failed'}</dd>
                  {event.details.map((detail) => (
                    <div key={detail.key} style={{ display: 'contents' }}>
                      <dt>{detail.label}</dt>
                      <dd>
                        <AuditDetailValue detail={detail} />
                      </dd>
                    </div>
                  ))}
                  <dt>Action code</dt>
                  <dd className="tabular">{event.action}</dd>
                  <dt>Record</dt>
                  <dd className="tabular">
                    {humanize(event.entityType)}
                    {event.entityId ? ` · ${event.entityId}` : ''}
                  </dd>
                </dl>

                <section>
                  <h3>Where it came from</h3>
                  <dl className={styles.details}>
                    <dt>Request</dt>
                    <dd className="tabular">{event.requestId ?? 'Not recorded'}</dd>
                    <dt>Address</dt>
                    <dd className="tabular">{event.ipAddress ?? 'Not recorded'}</dd>
                    <dt>Browser</dt>
                    <dd>{event.userAgent ?? 'Not recorded'}</dd>
                  </dl>
                  {/*
                    The credential paths record no request on purpose — their
                    caller is not yet anybody and could otherwise write chosen
                    text into the history — so an absent request is an answer,
                    not a gap.
                  */}
                </section>

                <section>
                  <h3>The same request</h3>
                  {data.sameRequest.length === 0 ? (
                    <p className="muted">
                      {event.requestId
                        ? 'Nothing else was recorded by this request.'
                        : 'No request was recorded, so nothing can be linked to it.'}
                    </p>
                  ) : (
                    <ul className={timeline.timeline}>
                      {data.sameRequest.map((other) => (
                        <li key={other.id}>
                          <button
                            type="button"
                            className={styles.summaryButton}
                            onClick={() => onOpen(other.id)}
                          >
                            {other.summary}
                          </button>
                          <span className="field-hint tabular">
                            {formatDateTime(other.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <details>
                  <summary>The record as stored</summary>
                  <pre className={styles.raw}>
                    {event.payloadJson ?? 'Nothing was stored with it.'}
                  </pre>
                </details>
              </>
            ) : null}
          </div>

          <div className={styles.dialogFooter}>
            {event?.requestId && data && data.sameRequest.length > 0 ? (
              <button
                type="button"
                className="button"
                onClick={() => onShowRequest(event.requestId!)}
              >
                Show this whole request
              </button>
            ) : null}
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
