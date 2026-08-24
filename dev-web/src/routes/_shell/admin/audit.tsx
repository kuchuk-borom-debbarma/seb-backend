/**
 * The activity history.
 *
 * Every other office screen answers "what is the state of this application".
 * This one answers "who changed it, and when" — which is the question asked
 * after something has gone wrong, and the one the portal could not answer at
 * all until now.
 *
 * It is the most personal read in the product: who did what, from which
 * address. Only a super administrator may open it, and the route says so
 * before it renders anything rather than letting the API refuse and showing an
 * empty table.
 */
import { queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Pager } from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { OFFICE_LEDES } from '#/features/admin/officeGuidance'
import { CapabilityRefusal } from '#/features/portal/CapabilityRefusal'
import { AuditActionsDocument, AuditEventsDocument } from '#/graphql/generated/operations'
import type { UserRole } from '#/graphql/generated/schema'
import { formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { can } from '#/lib/session'
import { unwrap } from '#/lib/result'

const PAGE_SIZE = 20

/** Only roles somebody can act as. An applicant's events are found by id. */
const STAFF_ROLES: UserRole[] = ['REVIEWER', 'APPROVER', 'ADMIN', 'SUPER_ADMIN']

type Search = {
  after?: string
  actorRole?: UserRole
  action?: string
  outcome?: 'SUCCESS' | 'FAILURE'
  /*
   * Named `oldest` rather than `order` on purpose. Every route's search
   * parameters share one namespace in the router's types, and `order` already
   * means something narrower on the intake queue — reusing the key made that
   * screen's own links stop type-checking.
   */
  oldest?: true
}

const eventsQuery = (search: Search) =>
  queryOptions({
    queryKey: ['audit-events', search],
    queryFn: async () => {
      const data = await gql(AuditEventsDocument, {
        input: {
          first: PAGE_SIZE,
          after: search.after ?? null,
          actorRole: search.actorRole ?? null,
          // One action at a time from the picker; the API takes a list because
          // a future screen may offer several at once.
          action: search.action ? [search.action] : null,
          outcome: search.outcome ?? null,
          order: search.oldest ? 'OLDEST_FIRST' : 'NEWEST_FIRST',
        },
      })
      return unwrap(data.audit.events)
    },
    placeholderData: (previous) => previous,
  })

/**
 * The action names that actually occur.
 *
 * Read from the recorded history rather than from a constant, so the picker
 * never offers a filter that matches nothing. Cached for the session: the set
 * changes only when a new kind of event is recorded for the first time.
 */
const actionsQuery = queryOptions({
  queryKey: ['audit-actions'],
  queryFn: async () => unwrap((await gql(AuditActionsDocument)).audit.actions),
  staleTime: 5 * 60_000,
})

export const Route = createFileRoute('/_shell/admin/audit')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    actorRole: STAFF_ROLES.includes(search.actorRole as UserRole)
      ? (search.actorRole as UserRole)
      : undefined,
    action:
      typeof search.action === 'string' && search.action ? search.action : undefined,
    outcome:
      search.outcome === 'SUCCESS' || search.outcome === 'FAILURE'
        ? search.outcome
        : undefined,
    oldest: search.oldest === true ? true : undefined,
  }),
  component: AuditPage,
})

function AuditPage() {
  const { user } = Route.useRouteContext()
  /*
   * Checked here as well as by the API. A screen nobody may use should not
   * render and then fill with a refusal.
   *
   * A capability refusal rather than a portal one: a reviewer reaching this is
   * in the right place and simply does not hold this, which is a different
   * sentence from "this part is for the programme office".
   */
  if (!can(user, 'AUDIT_READ')) {
    return <CapabilityRefusal title="Activity history" needs="super administrators" />
  }
  return <AuditHistory />
}

function AuditHistory() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(eventsQuery(search))
  const { data: actions } = useQuery(actionsQuery)

  const events = data?.nodes ?? []

  /*
   * Any filter change drops the cursor. A cursor is a position in one ordered
   * set; carried into a different set it seeks to a row that is no longer
   * there, and the API refuses it rather than guessing.
   */
  const filter = (change: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...change, after: undefined }) })

  return (
    <main className="page">
      <PageHeader title="Activity history" description={OFFICE_LEDES.audit} />

      <div className="filters">
        <div>
          <label className="field-label" htmlFor="audit-role">
            Done by
          </label>
          <select
            id="audit-role"
            className="select"
            value={search.actorRole ?? ''}
            onChange={(event) =>
              filter({
                actorRole: (event.target.value || undefined) as UserRole | undefined,
              })
            }
          >
            <option value="">Anybody</option>
            {STAFF_ROLES.map((role) => (
              <option key={role} value={role}>
                Anybody who is a {humanize(role).toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="audit-action">
            Action
          </label>
          <select
            id="audit-action"
            className="select"
            value={search.action ?? ''}
            onChange={(event) => filter({ action: event.target.value || undefined })}
          >
            <option value="">Any action</option>
            {(actions ?? []).map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="audit-outcome">
            Outcome
          </label>
          <select
            id="audit-outcome"
            className="select"
            value={search.outcome ?? ''}
            onChange={(event) =>
              filter({
                outcome: (event.target.value || undefined) as Search['outcome'],
              })
            }
          >
            <option value="">Any outcome</option>
            <option value="SUCCESS">Succeeded</option>
            <option value="FAILURE">Failed</option>
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="audit-order">
            Order
          </label>
          <select
            id="audit-order"
            className="select"
            value={search.oldest ? 'oldest' : 'newest'}
            onChange={(event) =>
              filter({ oldest: event.target.value === 'oldest' ? true : undefined })
            }
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="empty">
          Nothing matches these filters. Widen them, or clear the action.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Recorded activity</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Did what</th>
                <th scope="col">To</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="tabular">{formatDateTime(event.createdAt)}</td>
                  <td>
                    {/*
                      Some events have no actor at all — verified signup and the
                      first-administrator bootstrap are performed by the system
                      rather than by a person, and saying so is more honest than
                      leaving the cell empty.
                    */}
                    {event.actor ? (
                      <>
                        <span>{event.actor.email}</span>
                        <span className="field-hint">
                          {event.actor.roles.length === 0
                            ? 'No active role'
                            : event.actor.roles.map(humanize).join(', ')}
                        </span>
                      </>
                    ) : (
                      <span className="muted">The system</span>
                    )}
                  </td>
                  <td className="tabular">{event.action}</td>
                  <td>
                    <span>{humanize(event.entityType)}</span>
                    {event.entityId ? (
                      <span className="field-hint tabular">{event.entityId}</span>
                    ) : null}
                  </td>
                  <td>{event.outcome === 'SUCCESS' ? 'Succeeded' : 'Failed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        shown={events.length}
        totalCount={data?.pageInfo.totalCount ?? 0}
        hasNextPage={Boolean(data?.pageInfo.hasNextPage)}
        atStart={!search.after}
        pageSize={PAGE_SIZE}
        onFirst={() =>
          navigate({ search: (previous) => ({ ...previous, after: undefined }) })
        }
        onNext={() =>
          navigate({
            search: (previous) => ({
              ...previous,
              after: data?.pageInfo.endCursor ?? undefined,
            }),
          })
        }
      />
    </main>
  )
}
