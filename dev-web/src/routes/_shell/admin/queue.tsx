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
import { useEffect, useRef, useState } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  FileCheck,
  FileText,
  Landmark,
  List,
  type LucideIcon,
  RefreshCw,
  Scale,
  Search as SearchIcon,
  XCircle,
} from 'lucide-react'
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
import styles from '#/features/admin/Queue.module.css'
import { rupeesToPaise } from '#/features/application/money'
import { AdminCyclesDocument } from '#/graphql/generated/operations'
import type {
  AdminIntakeOrder,
  AdminIntakeQueueKey,
  ApplicationCategory,
  ApplicationType,
  BusinessSector,
  TripuraDistrict,
} from '#/graphql/generated/schema'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

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

const CATEGORIES: ApplicationCategory[] = ['CATEGORY_A', 'CATEGORY_B']

const DISTRICTS: TripuraDistrict[] = [
  'DHALAI',
  'GOMATI',
  'KHOWAI',
  'NORTH_TRIPURA',
  'SEPAHIJALA',
  'SOUTH_TRIPURA',
  'UNAKOTI',
  'WEST_TRIPURA',
]

/**
 * The cycles the cycle filter offers.
 *
 * The first hundred covers years of a programme that opens a handful of
 * cycles annually; a cycle beyond it is still filterable by URL.
 */
const cycleOptionsQuery = queryOptions({
  queryKey: ['queue-cycle-options'],
  queryFn: async () => {
    const data = await gql(AdminCyclesDocument, {
      first: 100,
      after: null,
      includeDeleted: false,
      status: null,
      cycleYear: null,
      search: null,
    })
    return unwrap(data.admin.programmeCycle.list).nodes
  },
  staleTime: 60_000,
})

/** The queues waiting on the office get a tab each; the rest fold into More. */
const PRIMARY_QUEUES: AdminIntakeQueueKey[] = [
  'NEW_SUBMISSIONS',
  'REVISION_RESPONSES',
  'DESK_REVIEW',
]

const MORE_QUEUES: AdminIntakeQueueKey[] = [
  'PARTNER_BANK_EVALUATION',
  'AWAITING_DECISION',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
]

const QUEUE_ICONS: Record<AdminIntakeQueueKey, LucideIcon> = {
  NEW_SUBMISSIONS: FileText,
  REVISION_RESPONSES: RefreshCw,
  DESK_REVIEW: SearchIcon,
  PARTNER_BANK_EVALUATION: Landmark,
  AWAITING_DECISION: Scale,
  APPROVED: CheckCircle2,
  REJECTED: XCircle,
  SANCTIONED: FileCheck,
  DISBURSED: Landmark,
}

type Search = {
  queue?: AdminIntakeQueueKey
  after?: string
  applicationType?: ApplicationType
  categories?: ApplicationCategory[]
  sectors?: BusinessSector[]
  districts?: TripuraDistrict[]
  cycleId?: string
  /** Rupees as typed; converted to paise at the API boundary. */
  requestedMin?: string
  requestedMax?: string
  /** Calendar days; widened to whole-day instants at the API boundary. */
  submittedFrom?: string
  submittedTo?: string
  decidedFrom?: string
  decidedTo?: string
  order?: AdminIntakeOrder
  mine?: boolean
  search?: string
}

const oneOf = <TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): TValue | undefined =>
  allowed.includes(value as TValue) ? (value as TValue) : undefined

/**
 * A multi-value key, kept only where it names real values.
 *
 * A single string is accepted too, so a bookmark from the single-select era
 * (`?sector=OTHER`) still applies the filter it always did.
 */
const manyOf = <TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): TValue[] | undefined => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kept = raw.filter((entry): entry is TValue => allowed.includes(entry as TValue))
  return kept.length > 0 ? kept : undefined
}

/** A calendar day, or nothing — never a partial date the API would refuse. */
const dayOf = (value: unknown): string | undefined =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined

/** A rupee amount as typed, kept only while it still parses to paise. */
const rupeesOf = (value: unknown): string | undefined =>
  typeof value === 'string' && typeof rupeesToPaise(value) === 'number'
    ? value
    : undefined

export const Route = createFileRoute('/_shell/admin/queue')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    queue: oneOf(QUEUE_KEYS, search.queue),
    after: typeof search.after === 'string' ? search.after : undefined,
    applicationType: oneOf(['INITIAL', 'EXPANSION'] as const, search.applicationType),
    // The old single-value keys are folded in so bookmarks keep filtering.
    categories: manyOf(CATEGORIES, search.categories) ?? manyOf(CATEGORIES, search.category),
    sectors: manyOf(SECTORS, search.sectors) ?? manyOf(SECTORS, search.sector),
    districts: manyOf(DISTRICTS, search.districts),
    cycleId: typeof search.cycleId === 'string' && search.cycleId ? search.cycleId : undefined,
    requestedMin: rupeesOf(search.requestedMin),
    requestedMax: rupeesOf(search.requestedMax),
    submittedFrom: dayOf(search.submittedFrom),
    submittedTo: dayOf(search.submittedTo),
    decidedFrom: dayOf(search.decidedFrom),
    decidedTo: dayOf(search.decidedTo),
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
      // The signed-in account, so "only mine" prefetches the key the component
      // then reads. Passing null here filled a different cache entry and the
      // screen fetched again on arrival, with the loading flash that implies.
      context.queryClient.ensureQueryData(
        queueQuery(inputFor(deps, context.user?.id ?? null)),
      ),
      context.queryClient.ensureQueryData(queueSummaryQuery()),
    ])
  },
  component: QueuePage,
})

/**
 * Turns the URL into the API's input.
 *
 * `assigneeUserId` is filled from the signed-in account when "only mine" is on.
 * It is passed rather than read here so both callers name it explicitly: the
 * loader takes it from route context and the component from its own, and a
 * mismatch between the two is what made the prefetch miss.
 */
/** Rupees as typed, converted to the paise string the Money scalar takes. */
const paiseOf = (rupees: string | undefined): string | null => {
  if (!rupees) return null
  const paise = rupeesToPaise(rupees)
  return typeof paise === 'number' ? String(paise) : null
}

/*
 * A day from the picker widens to the whole day in UTC, both bounds
 * inclusive — asking for "to the 12th" must include the 12th's afternoon.
 */
const dayStart = (day: string | undefined): string | null =>
  day ? `${day}T00:00:00.000Z` : null
const dayEnd = (day: string | undefined): string | null =>
  day ? `${day}T23:59:59.999Z` : null

const inputFor = (search: Search, assigneeUserId: string | null) => ({
  first: QUEUE_PAGE_SIZE,
  after: search.after ?? null,
  queue: search.queue ?? null,
  applicationType: search.applicationType ?? null,
  categories: search.categories ?? null,
  sectors: search.sectors ?? null,
  districts: search.districts ?? null,
  cycleId: search.cycleId ?? null,
  requestedMinPaise: paiseOf(search.requestedMin),
  requestedMaxPaise: paiseOf(search.requestedMax),
  submittedFrom: dayStart(search.submittedFrom),
  submittedTo: dayEnd(search.submittedTo),
  decidedFrom: dayStart(search.decidedFrom),
  decidedTo: dayEnd(search.decidedTo),
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
  const { data: cycles } = useQuery(cycleOptionsQuery)
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

  const totalAllCount = summary?.reduce((total, entry) => total + entry.count, 0) ?? 0

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
    search.categories ||
    search.sectors ||
    search.districts ||
    search.cycleId ||
    search.requestedMin ||
    search.requestedMax ||
    search.submittedFrom ||
    search.submittedTo ||
    search.decidedFrom ||
    search.decidedTo ||
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

      {/* The queues, as tabs. Counts come from the summary rather than from
          this page, so switching queues does not have to load one to know how
          big the other is. */}
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
              {isMoreQueueActive && search.queue ? QUEUE_TITLES[search.queue] : 'More'}
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
          {/* SearchBox debounces and mirrors the URL; only its shell is styled. */}
          <div className={styles.filterField}>
            <SearchBox
              id="queue-search"
              label="Reference or enterprise starts with"
              placeholder="SEP-2026 or Khumulwng"
              value={search.search}
              onChange={(value) => filter({ search: value })}
            />
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

          {/* Cycle Dropdown */}
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="cycle">
              Cycle
            </label>
            <div className={styles.selectWrap}>
              <select
                id="cycle"
                className={styles.selectControl}
                value={search.cycleId ?? ''}
                onChange={(event) =>
                  filter({ cycleId: event.target.value || undefined })
                }
              >
                <option value="">Any cycle</option>
                {(cycles ?? []).map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.cycleCode}
                  </option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>
          </div>
        </div>

        {/* Multi-value dimensions. Several values OR together; dimensions AND. */}
        <div className={styles.sectorGrid}>
          <MultiSelectFilter
            id="categories"
            label="Categories"
            options={CATEGORIES}
            selected={search.categories}
            onChange={(categories) => filter({ categories })}
          />
          <MultiSelectFilter
            id="sectors"
            label="Sectors"
            options={SECTORS}
            selected={search.sectors}
            onChange={(sectors) => filter({ sectors })}
          />
          <MultiSelectFilter
            id="districts"
            label="Districts"
            options={DISTRICTS}
            selected={search.districts}
            onChange={(districts) => filter({ districts })}
          />

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

        {/* Amounts are typed in rupees and land on blur, once they mean a number. */}
        <div className={styles.sectorGrid}>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="requested-min">
              Requested at least (₹)
            </label>
            <input
              id="requested-min"
              className={styles.textControl}
              inputMode="decimal"
              placeholder="Any amount"
              key={`min-${search.requestedMin ?? ''}`}
              defaultValue={search.requestedMin ?? ''}
              onBlur={(event) =>
                filter({ requestedMin: rupeesOf(event.target.value.trim()) })
              }
            />
          </div>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="requested-max">
              Requested at most (₹)
            </label>
            <input
              id="requested-max"
              className={styles.textControl}
              inputMode="decimal"
              placeholder="Any amount"
              key={`max-${search.requestedMax ?? ''}`}
              defaultValue={search.requestedMax ?? ''}
              onBlur={(event) =>
                filter({ requestedMax: rupeesOf(event.target.value.trim()) })
              }
            />
          </div>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="submitted-from">
              Submitted from
            </label>
            <input
              id="submitted-from"
              type="date"
              className={styles.textControl}
              value={search.submittedFrom ?? ''}
              onChange={(event) =>
                filter({ submittedFrom: event.target.value || undefined })
              }
            />
          </div>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="submitted-to">
              Submitted to
            </label>
            <input
              id="submitted-to"
              type="date"
              className={styles.textControl}
              value={search.submittedTo ?? ''}
              onChange={(event) =>
                filter({ submittedTo: event.target.value || undefined })
              }
            />
          </div>
        </div>

        <div className={styles.sectorGrid}>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="decided-from">
              Decided from
            </label>
            <input
              id="decided-from"
              type="date"
              className={styles.textControl}
              value={search.decidedFrom ?? ''}
              onChange={(event) =>
                filter({ decidedFrom: event.target.value || undefined })
              }
            />
          </div>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="decided-to">
              Decided to
            </label>
            <input
              id="decided-to"
              type="date"
              className={styles.textControl}
              value={search.decidedTo ?? ''}
              onChange={(event) =>
                filter({ decidedTo: event.target.value || undefined })
              }
            />
          </div>
        </div>
      </div>

      {/* Applications Table Card */}
      {rows.length === 0 ? (
        <div className={styles.emptyCard}>
          {/* Three different facts, and the heading has to say which one. */}
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
                  categories: undefined,
                  sectors: undefined,
                  districts: undefined,
                  cycleId: undefined,
                  requestedMin: undefined,
                  requestedMax: undefined,
                  submittedFrom: undefined,
                  submittedTo: undefined,
                  decidedFrom: undefined,
                  decidedTo: undefined,
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
                      <span className={styles.enterpriseText}>{row.enterpriseName}</span>
                    </td>
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
                        // Who claimed it is an internal user id; the workspace
                        // is where a name can be resolved, so this says only
                        // that somebody has it.
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

/**
 * One multi-value dimension as a native listbox.
 *
 * A native `<select multiple>` rather than a custom popover: it is keyboard
 * and screen-reader complete for free, and the URL — not the control — is the
 * record of what is selected. Clearing every option clears the key entirely,
 * so "nothing selected" reads as "no filter", never as "match nothing".
 */
function MultiSelectFilter<TValue extends string>({
  id,
  label,
  options,
  selected,
  onChange,
}: {
  id: string
  label: string
  options: readonly TValue[]
  selected: TValue[] | undefined
  onChange: (selected: TValue[] | undefined) => void
}) {
  return (
    <div className={styles.filterField}>
      <label className={styles.filterLabel} htmlFor={id}>
        {label}
        {selected?.length ? ` (${selected.length})` : ''}
      </label>
      <select
        id={id}
        multiple
        size={4}
        className={styles.multiSelect}
        value={selected ?? []}
        onChange={(event) => {
          const chosen = Array.from(
            event.target.selectedOptions,
            (option) => option.value as TValue,
          )
          onChange(chosen.length > 0 ? chosen : undefined)
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {humanize(option)}
          </option>
        ))}
      </select>
    </div>
  )
}
