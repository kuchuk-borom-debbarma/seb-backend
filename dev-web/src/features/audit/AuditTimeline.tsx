/**
 * A short slice of the activity history, for embedding in another screen.
 *
 * The application workspace shows its own latest events here; the full view,
 * with filters, paging and the entry dialog, is one link away. It asks the same
 * API with the same filter the full view would use, so the two can never
 * disagree about what happened to a file.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { AuditFilterInput } from '#/graphql/generated/schema'
import { formatDateTime, humanize } from '#/lib/format'
import { messageFor } from '#/lib/result'
import { auditEventsQuery } from './auditEvents'
import type { AuditSearch } from './auditQueries'
import styles from './AuditTimeline.module.css'

export function AuditTimeline({
  filter,
  link,
  first = 10,
}: {
  filter: AuditFilterInput
  /** The same slice in the full history, where it can be filtered and opened. */
  link: AuditSearch
  first?: number
}) {
  const { data, error, isPending } = useQuery(
    auditEventsQuery({ first, after: null, oldest: false, filter }),
  )
  if (isPending) return <p className="muted">Reading the history…</p>
  if (error) {
    return (
      <p className="notice" data-tone="error" role="alert">
        {messageFor(error)}
      </p>
    )
  }
  if (data.nodes.length === 0)
    return <p className="muted">Nothing has been recorded yet.</p>
  return (
    <>
      <ol className={styles.timeline}>
        {data.nodes.map((event) => (
          <li key={event.id}>
            <span>
              <Link to="/admin/audit" search={{ ...link, event: event.id }}>
                {event.summary}
              </Link>
              <span className="field-hint">
                {event.actor?.email ?? 'The system'} · {humanize(event.category)}
              </span>
            </span>
            <span className="field-hint tabular">{formatDateTime(event.createdAt)}</span>
          </li>
        ))}
      </ol>
      <Link to="/admin/audit" search={link}>
        {data.pageInfo.totalCount > data.nodes.length
          ? `All ${data.pageInfo.totalCount} entries in the activity history`
          : 'Open in the activity history'}
      </Link>
    </>
  )
}
