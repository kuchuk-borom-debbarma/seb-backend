/**
 * One work queue.
 *
 * Every filter here is one the API accepts, and the whole filter set lives in
 * the URL — so a queue view can be bookmarked, sent to a colleague, or reached
 * again by the back button with the same rows in it.
 *
 * Queue and status are mutually exclusive: two of the queues are subsets of a
 * single status, and the API refuses both rather than silently intersecting
 * them. The interface enforces that by offering one control, not two.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Pager, SearchBox } from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import {
  QUEUE_PAGE_SIZE,
  queueQuery,
  queueSummaryQuery,
} from '#/features/admin/intakeQueries'
import {
  QUEUE_DESCRIPTIONS,
  QUEUE_KEYS,
  QUEUE_TITLES,
  statusTone,
  waitingFor,
} from '#/features/admin/queues'
import type {
  AdminIntakeOrder,
  AdminIntakeQueueKey,
  ApplicationCategory,
  ApplicationType,
  BusinessSector,
} from '#/graphql/generated/schema'
import { formatDate, humanize } from '#/lib/format'

/** The sorts the API offers, named for what a person is trying to do. */
const ORDERS: { value: AdminIntakeOrder; label: string }[] = [
  { value: 'OLDEST_WAITING', label: 'Longest waiting first' },
  { value: 'NEWEST_SUBMISSION', label: 'Newest submission first' },
  { value: 'LAST_ACTIVITY', label: 'Most recently changed first' },
]

const SECTORS: BusinessSector[] = [
  'AGRICULTURE_AND_ALLIED',
  'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  'FOOD_PROCESSING',
  'TOURISM_AND_HOSPITALITY',
  'INFORMATION_TECHNOLOGY',
  'MANUFACTURING_AND_SERVICES',
  'OTHER',
]

type Search = {
  queue?: AdminIntakeQueueKey
  after?: string
  applicationType?: ApplicationType
  category?: ApplicationCategory
  sector?: BusinessSector
  order?: AdminIntakeOrder
  mine?: boolean
  search?: string
}

const oneOf = <TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): TValue | undefined =>
  allowed.includes(value as TValue) ? (value as TValue) : undefined

export const Route = createFileRoute('/_shell/admin/queue')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    queue: oneOf(QUEUE_KEYS, search.queue),
    after: typeof search.after === 'string' ? search.after : undefined,
    applicationType: oneOf(['INITIAL', 'EXPANSION'] as const, search.applicationType),
    category: oneOf(['CATEGORY_A', 'CATEGORY_B'] as const, search.category),
    sector: oneOf(SECTORS, search.sector),
    order: oneOf(
      ORDERS.map((order) => order.value),
      search.order,
    ),
    mine: search.mine === true ? true : undefined,
    search:
      typeof search.search === 'string' && search.search ? search.search : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(queueQuery(inputFor(deps, null))),
      context.queryClient.ensureQueryData(queueSummaryQuery()),
    ])
  },
  component: QueuePage,
})

/**
 * Turns the URL into the API's input.
 *
 * `assigneeUserId` is filled from the signed-in account when "only mine" is on,
 * which is why it is passed rather than read here — a query key built from a
 * value the loader does not have would miss the cache the component fills.
 */
const inputFor = (search: Search, assigneeUserId: string | null) => ({
  first: QUEUE_PAGE_SIZE,
  after: search.after ?? null,
  queue: search.queue ?? null,
  applicationType: search.applicationType ?? null,
  category: search.category ?? null,
  sector: search.sector ?? null,
  order: search.order ?? 'OLDEST_WAITING',
  assigneeUserId: search.mine ? assigneeUserId : null,
  search: search.search ?? null,
})

function QueuePage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { user } = Route.useRouteContext()
  const { data, isPlaceholderData } = useQuery(
    queueQuery(inputFor(search, user?.id ?? null)),
  )
  const { data: summary } = useQuery(queueSummaryQuery())
  const mark = useMarker()

  const rows = data?.nodes ?? []
  const countOf = (queue: AdminIntakeQueueKey) =>
    summary?.find((entry) => entry.queue === queue)?.count ?? 0

  /** Resets paging: a filter change makes the old cursor meaningless. */
  const filter = (change: Partial<Search>) =>
    navigate({
      search: (previous) => ({ ...previous, ...change, after: undefined }),
    })

  /*
   * Whether an empty queue means "nothing matched" or "nothing to do".
   *
   * `queue` is deliberately not counted. It is the tab, not a filter — clearing
   * it as part of "clear the filters" would eject somebody from the queue they
   * chose to open, which is not what that button offers to do.
   */
  const filtered = Boolean(
    search.search ||
    search.applicationType ||
    search.category ||
    search.sector ||
    search.mine,
  )

  return (
    <main className="page">
      <PageHeader
        title={search.queue ? QUEUE_TITLES[search.queue] : 'All applications'}
        description={
          search.queue
            ? QUEUE_DESCRIPTIONS[search.queue]
            : 'Every submitted application, in any queue.'
        }
        actions={
          <Link to="/admin" className="button">
            Back to intake
          </Link>
        }
      />

      {/* The queues, as tabs. Counts come from the summary rather than from
          this page, so switching queues does not have to load one to know how
          big the other is. */}
      <div className="tabs" role="tablist" aria-label="Queues">
        <Link
          to="/admin/queue"
          search={(previous) => ({
            ...previous,
            queue: undefined,
            after: undefined,
          })}
          role="tab"
          aria-selected={!search.queue}
          className="tab"
        >
          All
        </Link>
        {QUEUE_KEYS.map((queue) => (
          <Link
            key={queue}
            to="/admin/queue"
            search={(previous) => ({ ...previous, queue, after: undefined })}
            role="tab"
            aria-selected={search.queue === queue}
            className="tab"
          >
            {QUEUE_TITLES[queue]}
            <span className="tab-count tabular">{countOf(queue)}</span>
          </Link>
        ))}
      </div>

      <div className="filters" {...mark('queue-filters')}>
        <SearchBox
          id="queue-search"
          label="Reference or enterprise starts with"
          placeholder="SEP-2026 or Khumulwng"
          value={search.search}
          onChange={(value) => filter({ search: value })}
        />

        <div>
          <label className="field-label" htmlFor="order">
            Order
          </label>
          <select
            id="order"
            className="select"
            value={search.order ?? 'OLDEST_WAITING'}
            onChange={(event) =>
              filter({ order: event.target.value as AdminIntakeOrder })
            }
          >
            {ORDERS.map((order) => (
              <option key={order.value} value={order.value}>
                {order.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="type">
            Type
          </label>
          <select
            id="type"
            className="select"
            value={search.applicationType ?? ''}
            onChange={(event) =>
              filter({
                applicationType: (event.target.value || undefined) as
                  ApplicationType | undefined,
              })
            }
          >
            <option value="">Any type</option>
            <option value="INITIAL">Initial</option>
            <option value="EXPANSION">Expansion</option>
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="category">
            Category
          </label>
          <select
            id="category"
            className="select"
            value={search.category ?? ''}
            onChange={(event) =>
              filter({
                category: (event.target.value || undefined) as
                  ApplicationCategory | undefined,
              })
            }
          >
            <option value="">Any category</option>
            <option value="CATEGORY_A">Category A</option>
            <option value="CATEGORY_B">Category B</option>
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="sector">
            Sector
          </label>
          <select
            id="sector"
            className="select"
            value={search.sector ?? ''}
            onChange={(event) =>
              filter({
                sector: (event.target.value || undefined) as BusinessSector | undefined,
              })
            }
          >
            <option value="">Any sector</option>
            {SECTORS.map((sector) => (
              <option key={sector} value={sector}>
                {humanize(sector)}
              </option>
            ))}
          </select>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={search.mine ?? false}
            onChange={(event) =>
              filter({ mine: event.target.checked ? true : undefined })
            }
          />
          Only what I have claimed
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <div className="empty">
            {/* Three different facts, and the heading has to say which one. */}
            <h3>
              {filtered
                ? 'Nothing matches'
                : search.queue
                  ? 'Nothing in this queue'
                  : 'No applications yet'}
            </h3>
            <p>
              {filtered
                ? 'No application matches these filters. Clearing one may bring some back.'
                : search.queue
                  ? 'Everything here has been dealt with.'
                  : 'Nothing has been submitted to the programme office yet.'}
            </p>
            {filtered ? (
              <button
                type="button"
                className="button"
                style={{ marginTop: '1rem' }}
                onClick={() =>
                  filter({
                    search: undefined,
                    applicationType: undefined,
                    category: undefined,
                    sector: undefined,
                    mine: undefined,
                  })
                }
              >
                Clear the filters
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="card" aria-busy={isPlaceholderData} {...mark('queue-rows')}>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Applications in this queue</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Enterprise</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Claimed by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        to="/admin/applications/$id"
                        params={{ id: row.id }}
                        className="tabular"
                      >
                        {row.referenceNumber ?? '—'}
                      </Link>
                    </td>
                    <td>{row.enterpriseName}</td>
                    <td className="tabular">{row.cycleCode}</td>
                    <td>
                      {row.applicationType === 'EXPANSION'
                        ? `Expansion · phase ${row.phaseNumber}`
                        : 'Initial'}
                      {/* A resubmission is a different job from a first look,
                          and the number says which this is. */}
                      {row.submissionNumber > 1 ? (
                        <span className="muted">
                          {' '}
                          · submission {row.submissionNumber}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className="badge" data-tone={statusTone(row.status)}>
                        {humanize(row.status)}
                      </span>
                    </td>
                    <td>
                      {waitingFor(row.statusChangedAt)}
                      <span className="field-hint">
                        submitted {formatDate(row.submittedAt)}
                      </span>
                    </td>
                    <td>
                      {row.assignedToUserId ? (
                        // Who claimed it is an internal user id; the workspace
                        // is where a name can be resolved, so this says only
                        // that somebody has it.
                        <span className="badge">Claimed</span>
                      ) : (
                        <span className="muted">Nobody</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pager
            shown={rows.length}
            totalCount={data?.pageInfo.totalCount ?? 0}
            hasNextPage={data?.pageInfo.hasNextPage ?? false}
            atStart={!search.after}
            pageSize={QUEUE_PAGE_SIZE}
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
        </div>
      )}
    </main>
  )
}
