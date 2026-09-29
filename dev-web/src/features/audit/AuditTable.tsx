/**
 * A page of the activity history as a table.
 *
 * Each row says, in order, when, who, what and to whom. "What" is the event's
 * own sentence rather than its code, because a code like
 * `SEB.DESK_REVIEW_COMPLETED` is a thing to filter by, not to read; the code
 * is still on the entry, one click away. Opening an entry is a button on that
 * sentence, so the row is keyboard-reachable without making every cell a link.
 */
import { Link } from '@tanstack/react-router'
import type { AuditEventFieldsFragment } from '#/graphql/generated/operations'
import { formatDateTime, humanize } from '#/lib/format'
import { can, useCurrentUser } from '#/lib/session'
import styles from './Audit.module.css'

export type AuditEntry = AuditEventFieldsFragment

/** A person as the history names them, with the roles they hold now. */
export function AuditPerson({ person }: { person: AuditEntry['actor'] }) {
  /*
   * Some events have no actor at all — verified signup and the
   * first-administrator bootstrap are performed by the system rather than by a
   * person, and saying so is more honest than leaving the cell empty.
   */
  if (!person) return <span className="muted">The system</span>
  return (
    <>
      <span>{person.email}</span>
      <span className="field-hint">
        {person.roles.length === 0
          ? 'No active role'
          : person.roles.map(humanize).join(', ')}
      </span>
    </>
  )
}

/** The application an event belongs to, linked where the reader may open it. */
export function AuditApplication({
  application,
}: {
  application: AuditEntry['application']
}) {
  const user = useCurrentUser()
  if (!application) return null
  const label =
    application.label ??
    (application.exists ? 'Draft application' : 'Removed application')
  return application.exists && can(user, 'application', 'read') ? (
    <Link
      to="/admin/applications/$id"
      params={{ id: application.id }}
      className="tabular"
    >
      {label}
    </Link>
  ) : (
    <span className="tabular">{label}</span>
  )
}

export function AuditTable({
  events,
  busy,
  onOpen,
}: {
  events: readonly AuditEntry[]
  /** The rows on screen are the previous page while the next one loads. */
  busy: boolean
  onOpen: (id: string) => void
}) {
  return (
    <div className="table-wrap" aria-busy={busy}>
      <table className="table">
        <caption className="visually-hidden">Recorded activity</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">About</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className="tabular">{formatDateTime(event.createdAt)}</td>
              <td>
                <AuditPerson person={event.actor} />
              </td>
              <td>
                <button
                  type="button"
                  className={styles.summaryButton}
                  onClick={() => onOpen(event.id)}
                >
                  {event.summary}
                </button>
                <span className="field-hint">
                  {humanize(event.category)} · {event.actionLabel}
                </span>
              </td>
              <td>
                {event.subject ? <span>{event.subject.email}</span> : null}
                <span className={event.subject ? 'field-hint' : undefined}>
                  <AuditApplication application={event.application} />
                </span>
                {!event.subject && !event.application ? (
                  <span className="muted">—</span>
                ) : null}
              </td>
              <td>{event.outcome === 'SUCCESS' ? 'Succeeded' : 'Failed'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
