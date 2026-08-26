import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronDown,
  FileCheck,
  FileText,
  Landmark,
  List,
  type LucideIcon,
  RefreshCw,
  Search as SearchIcon,
  Users,
  XCircle,
} from 'lucide-react'
import { Pager } from '#/components/ListControls'
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
import styles from '#/features/admin/Queue.module.css'
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

const PRIMARY_QUEUES: AdminIntakeQueueKey[] = [
  'NEW_SUBMISSIONS',
  'REVISION_RESPONSES',
  'DESK_REVIEW',
]

const MORE_QUEUES: AdminIntakeQueueKey[] = [
  'PARTNER_BANK_EVALUATION',
  'TTM_REVIEW',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
]

const QUEUE_ICONS: Record<AdminIntakeQueueKey, LucideIcon> = {
  NEW_SUBMISSIONS: FileText,
  REVISION_RESPONSES: RefreshCw,
  DESK_REVIEW: SearchIcon,
  PARTNER_BANK_EVALUATION: Building2,
  TTM_REVIEW: Users,
  APPROVED: CheckCircle2,
  REJECTED: XCircle,
  SANCTIONED: FileCheck,
  DISBURSED: Landmark,
}

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
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const rows = data?.nodes ?? []
  const countOf = (queue: AdminIntakeQueueKey) =>
    summary?.find((entry) => entry.queue === queue)?.count ?? 0

  const totalAllCount =
    summary?.reduce((total, entry) => total + entry.count, 0) ?? 0

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

  const isMoreQueueActive = Boolean(search.queue && MORE_QUEUES.includes(search.queue))

  return (
    <main className={styles.pageWrap}>
      <PageHeader
        title={search.queue ? QUEUE_TITLES[search.queue] : 'All applications'}
        description={
          search.queue
            ? QUEUE_DESCRIPTIONS[search.queue]
            : 'Every submitted application, in any queue.'
        }
        actions={
          <Link to="/admin" className={styles.backButton}>
            <ArrowLeft size={15} aria-hidden="true" />
            Back to dashboard
          </Link>
        }
      />

      {/* Top Queue Filter / Tab Strip */}
      <div className={styles.tabStripCard} role="tablist" aria-label="Queues">
        <Link
          to="/admin/queue"
          search={(previous) => ({
            ...previous,
            queue: undefined,
            after: undefined,
          })}
          role="tab"
          aria-selected={!search.queue}
          className={`${styles.queueTab} ${!search.queue ? styles.queueTabActive : ''}`}
        >
          <List className={styles.queueTabIcon} aria-hidden="true" />
          <span>All</span>
          <span
            className={`${styles.countBadge} ${
              !search.queue ? styles.countBadgeActive : ''
            }`}
          >
            {totalAllCount}
          </span>
        </Link>

        {PRIMARY_QUEUES.map((queueKey) => {
          const Icon = QUEUE_ICONS[queueKey]
          const isActive = search.queue === queueKey
          const tone =
            queueKey === 'NEW_SUBMISSIONS'
              ? 'blue'
              : queueKey === 'REVISION_RESPONSES'
                ? 'green'
                : 'amber'
          return (
            <Link
              key={queueKey}
              to="/admin/queue"
              search={(previous) => ({ ...previous, queue: queueKey, after: undefined })}
              role="tab"
              aria-selected={isActive}
              className={`${styles.queueTab} ${isActive ? styles.queueTabActive : ''}`}
            >
              <Icon
                className={styles.queueTabIcon}
                data-color={tone}
                aria-hidden="true"
              />
              <span>{QUEUE_TITLES[queueKey]}</span>
              <span
                className={`${styles.countBadge} ${
                  isActive ? styles.countBadgeActive : ''
                }`}
              >
                {countOf(queueKey)}
              </span>
            </Link>
          )
        })}

        {/* More Queues Dropdown */}
        <div className={styles.moreDropdownWrap} ref={moreRef}>
          <button
            type="button"
            className={`${styles.queueTab} ${
              isMoreQueueActive ? styles.queueTabActive : ''
            }`}
            onClick={() => setMoreOpen((previous) => !previous)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          >
            <span>
              {isMoreQueueActive && search.queue
                ? QUEUE_TITLES[search.queue]
                : 'More'}
            </span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>

          {moreOpen && (
            <div className={styles.moreDropdownMenu} role="menu">
              {MORE_QUEUES.map((queueKey) => {
                const Icon = QUEUE_ICONS[queueKey]
                const isActive = search.queue === queueKey
                return (
                  <Link
                    key={queueKey}
                    to="/admin/queue"
                    search={(previous) => ({
                      ...previous,
                      queue: queueKey,
                      after: undefined,
                    })}
                    role="menuitem"
                    className={`${styles.moreMenuItem} ${
                      isActive ? styles.moreMenuItemActive : ''
                    }`}
                    onClick={() => setMoreOpen(false)}
                  >
                    <div className={styles.moreMenuLeft}>
                      <Icon size={15} aria-hidden="true" />
                      <span>{QUEUE_TITLES[queueKey]}</span>
                    </div>
                    <span
                      className={`${styles.countBadge} ${
                        isActive ? styles.countBadgeActive : ''
                      }`}
                    >
                      {countOf(queueKey)}
                    </span>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Filters Card */}
      <div className={styles.filtersCard} {...mark('queue-filters')}>
        <div className={styles.filtersGrid}>
          {/* Reference or Enterprise Input */}
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="queue-search">
              Reference or enterprise starts with
            </label>
            <div className={styles.searchFieldWrap}>
              <input
                id="queue-search"
                type="search"
                className={styles.searchInput}
                placeholder="Enter reference or enterprise"
                value={search.search ?? ''}
                onChange={(event) =>
                  filter({ search: event.target.value || undefined })
                }
              />
              <SearchIcon className={styles.searchIcon} aria-hidden="true" />
            </div>
          </div>

          {/* Order Dropdown */}
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="order">
              Order
            </label>
            <div className={styles.selectWrap}>
              <select
                id="order"
                className={styles.selectControl}
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
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>
          </div>

          {/* Type Dropdown */}
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="type">
              Type
            </label>
            <div className={styles.selectWrap}>
              <select
                id="type"
                className={styles.selectControl}
                value={search.applicationType ?? ''}
                onChange={(event) =>
                  filter({
                    applicationType: (event.target.value || undefined) as
                      | ApplicationType
                      | undefined,
                  })
                }
              >
                <option value="">Any type</option>
                <option value="INITIAL">Initial</option>
                <option value="EXPANSION">Expansion</option>
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>
          </div>

          {/* Category Dropdown */}
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="category">
              Category
            </label>
            <div className={styles.selectWrap}>
              <select
                id="category"
                className={styles.selectControl}
                value={search.category ?? ''}
                onChange={(event) =>
                  filter({
                    category: (event.target.value || undefined) as
                      | ApplicationCategory
                      | undefined,
                  })
                }
              >
                <option value="">Any category</option>
                <option value="CATEGORY_A">Category A</option>
                <option value="CATEGORY_B">Category B</option>
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>
          </div>
        </div>

        {/* Sector Filter Row */}
        <div className={styles.sectorGrid}>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="sector">
              Sector
            </label>
            <div className={styles.selectWrap}>
              <select
                id="sector"
                className={styles.selectControl}
                value={search.sector ?? ''}
                onChange={(event) =>
                  filter({
                    sector: (event.target.value || undefined) as
                      | BusinessSector
                      | undefined,
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
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>

      {/* Applications Table Card */}
      {rows.length === 0 ? (
        <div className={styles.emptyCard}>
          <h3 className={styles.emptyTitle}>
            {filtered
              ? 'Nothing matches'
              : search.queue
                ? 'Nothing in this queue'
                : 'No applications yet'}
          </h3>
          <p className={styles.emptyText}>
            {filtered
              ? 'No application matches these filters. Clearing one may bring some back.'
              : search.queue
                ? 'Everything here has been dealt with.'
                : 'Nothing has been submitted to the programme office yet.'}
          </p>
          {filtered ? (
            <button
              type="button"
              className={styles.clearFilterBtn}
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
      ) : (
        <div
          className={styles.tableCard}
          aria-busy={isPlaceholderData}
          {...mark('queue-rows')}
        >
          <h2 className={styles.tableTitle}>Applications in this queue</h2>
          <div className={styles.tableWrap}>
            <table className={styles.appsTable}>
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
                  <tr key={row.id} className={styles.appsTableRow}>
                    <td>
                      <Link
                        to="/admin/applications/$id"
                        params={{ id: row.id }}
                        className={styles.refLink}
                      >
                        {row.referenceNumber ?? '—'}
                      </Link>
                    </td>
                    <td>
                      <span className={styles.enterpriseText}>
                        {row.enterpriseName}
                      </span>
                    </td>
                    <td className="tabular">{row.cycleCode}</td>
                    <td>
                      {row.applicationType === 'EXPANSION'
                        ? `Expansion · phase ${row.phaseNumber}`
                        : 'Initial'}
                      {row.submissionNumber > 1 ? (
                        <span className="muted">
                          {' '}
                          · submission {row.submissionNumber}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={styles.statusBadge}
                        data-tone={statusTone(row.status)}
                      >
                        {humanize(row.status)}
                      </span>
                    </td>
                    <td>
                      <div className={styles.waitingCell}>
                        <span className={styles.waitingPrimary}>
                          {waitingFor(row.statusChangedAt)}
                        </span>
                        <span className={styles.waitingSub}>
                          submitted {formatDate(row.submittedAt)}
                        </span>
                      </div>
                    </td>
                    <td>
                      {row.assignedToUserId ? (
                        <span className={styles.statusBadge}>Claimed</span>
                      ) : (
                        <span className="muted">Nobody</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.resultsFooter}>
            <span>{data?.pageInfo.totalCount ?? rows.length} results</span>
            <Pager
              shown={rows.length}
              totalCount={data?.pageInfo.totalCount ?? 0}
              hasNextPage={data?.pageInfo.hasNextPage ?? false}
              atStart={!search.after}
              pageSize={QUEUE_PAGE_SIZE}
              onFirst={() =>
                navigate({
                  search: (previous) => ({ ...previous, after: undefined }),
                })
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
        </div>
      )}
    </main>
  )
}

