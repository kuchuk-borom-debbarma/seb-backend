/**
 * One recorded value, shown the way its kind says to read it.
 *
 * The API sends every value as text and a `kind` naming what it is, so this is
 * the one place that decides how money, dates, codes and references look in the
 * history — and money in particular goes through the one money formatter, from
 * paise, like everywhere else on this client.
 *
 * A reference becomes a link only where there is a screen to land on and the
 * reader may open it. A link that leads to a refusal, or to nothing because the
 * record is gone, is a control that does not work.
 */
import { Link } from '@tanstack/react-router'
import type { AuditDetailKind } from '#/graphql/generated/schema'
import { formatDate, formatDateTime, formatMoney, humanize } from '#/lib/format'
import { can, isSuperAdministrator, useCurrentUser } from '#/lib/session'

export type AuditDetail = {
  key: string
  label: string
  kind: AuditDetailKind
  value: string | null
  reference: { id: string; label: string | null; exists: boolean } | null
}

/** The filters an export used, as one readable line per filter. */
const filtersText = (value: string): string => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return Object.entries(parsed)
      .map(
        ([key, entry]) =>
          `${humanize(key)}: ${Array.isArray(entry) ? entry.join(', ') : String(entry)}`,
      )
      .join(' · ')
  } catch {
    return value
  }
}

/** A JSON array the API sent as text, or nothing when it is not one. */
const parsedArray = (value: string): unknown[] | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

type ShownValue = { label: string; kind: string; value: string }

/** One configured value, read by the kind it was recorded with. */
const shownValueText = ({ kind, value }: ShownValue): string => {
  if (kind === 'MONEY') return formatMoney(value)
  if (kind === 'DATE') return formatDate(value)
  if (kind === 'BOOLEAN') return value === 'true' ? 'Yes' : 'No'
  if (kind === 'ENUM') return humanize(value)
  return value
}

export function AuditDetailValue({ detail }: { detail: AuditDetail }) {
  const user = useCurrentUser()
  const { value, reference } = detail
  if (value === null) return <span className="muted">—</span>

  // What a reference is called, falling back to what kind of thing it is.
  const named =
    reference?.label ?? (reference?.exists ? 'A draft application' : 'Unknown')

  switch (detail.kind) {
    case 'MONEY':
      return <span className="tabular">{formatMoney(value)}</span>
    case 'DATE':
      return <span className="tabular">{formatDate(value)}</span>
    case 'DATETIME':
      return <span className="tabular">{formatDateTime(value)}</span>
    case 'ENUM':
      return <span>{humanize(value)}</span>
    case 'BOOLEAN':
      return <span>{value === 'true' ? 'Yes' : 'No'}</span>
    case 'REASON':
      return <q>{value}</q>
    case 'FILTERS':
      return <span>{filtersText(value)}</span>
    case 'LIST': {
      const items = parsedArray(value)
      if (!items) return <span>{value}</span>
      return items.length === 0 ? <span className="muted">None</span> : <span>{items.join(', ')}</span>
    }
    case 'VALUES': {
      const items = parsedArray(value) as ShownValue[] | null
      if (!items) return <span>{value}</span>
      if (items.length === 0) return <span className="muted">None</span>
      return (
        <span>
          {items.map((item, index) => (
            <span key={`${item.label}-${index}`}>
              {index > 0 ? ' · ' : ''}
              {item.label}: <span className="tabular">{shownValueText(item)}</span>
            </span>
          ))}
        </span>
      )
    }
    case 'ID':
      return <span className="tabular muted">{value}</span>
    case 'USER':
      // A person's own history is the one screen every reader of this one may
      // open, so a person links there rather than to account administration.
      return reference?.exists ? (
        <Link to="/admin/audit" search={{ involving: value }}>
          {named}
        </Link>
      ) : (
        <span>{named}</span>
      )
    case 'APPLICATION':
      return reference?.exists && can(user, 'application', 'read') ? (
        <Link to="/admin/applications/$id" params={{ id: value }}>
          {named}
        </Link>
      ) : (
        <span>{named}</span>
      )
    case 'CYCLE':
      return reference?.exists && can(user, 'programme_cycle', 'read') ? (
        <Link to="/admin/cycles/$id" params={{ id: value }}>
          {named}
        </Link>
      ) : (
        <span>{named}</span>
      )
    case 'ROLE':
      // Only a super administrator may open a role, so only they get a link.
      return reference?.exists &&
        isSuperAdministrator(user) &&
        !['APPLICANT', 'SUPER_ADMIN'].includes(value) ? (
        <Link to="/admin/roles/$key" params={{ key: value }}>
          {named}
        </Link>
      ) : (
        <span>{reference?.label ?? humanize(value)}</span>
      )
    case 'ENTERPRISE':
      return <span>{named}</span>
    default:
      return <span>{value}</span>
  }
}
