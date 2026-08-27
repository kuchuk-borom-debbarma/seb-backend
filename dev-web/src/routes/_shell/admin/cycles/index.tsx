import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Calendar, Plus, Search } from 'lucide-react'
import { Pager } from '#/components/ListControls'
import { useMarker } from '#/features/guide/GuideContext'
import {
  AdminCyclesDocument,
  RestoreCycleDraftDocument,
} from '#/graphql/generated/operations'
import type { ProgrammeCycleStatus } from '#/graphql/generated/schema'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import styles from '#/features/admin/Cycles.module.css'

const PAGE_SIZE = 20

const STATUSES: ProgrammeCycleStatus[] = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED']

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = [
  CURRENT_YEAR + 1,
  CURRENT_YEAR,
  CURRENT_YEAR - 1,
  CURRENT_YEAR - 2,
  CURRENT_YEAR - 3,
]

type Search = {
  after?: string
  status?: ProgrammeCycleStatus
  cycleYear?: number
  search?: string
  includeDeleted?: boolean
}

const cyclesQuery = (search: Search) =>
  queryOptions({
    queryKey: ['admin-cycles', search],
    queryFn: async () => {
      const data = await gql(AdminCyclesDocument, {
        first: PAGE_SIZE,
        after: search.after ?? null,
        includeDeleted: search.includeDeleted ?? false,
        status: search.status ?? null,
        cycleYear: search.cycleYear ?? null,
        search: search.search ?? null,
      })
      return unwrap(data.admin.programmeCycle.list)
    },
    placeholderData: (previous) => previous,
  })

export const Route = createFileRoute('/_shell/admin/cycles/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    status: STATUSES.includes(search.status as ProgrammeCycleStatus)
      ? (search.status as ProgrammeCycleStatus)
      : undefined,
    // A year is four digits or it is not a year.
    cycleYear:
      typeof search.cycleYear === 'number' && Number.isInteger(search.cycleYear)
        ? search.cycleYear
        : undefined,
    search:
      typeof search.search === 'string' && search.search ? search.search : undefined,
    includeDeleted: search.includeDeleted === true ? true : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(cyclesQuery(deps)),
  component: AdminCyclesPage,
})

function CyclesBannerIllustration() {
  return (
    <div className={styles.bannerIllustration}>
      <svg
        className={styles.bannerSvg}
        viewBox="0 0 520 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <filter id="softShadow" x="-10%" y="-10%" width="130%" height="130%">
            <feDropShadow
              dx="0"
              dy="6"
              stdDeviation="8"
              floodColor="#0f172a"
              floodOpacity="0.06"
            />
          </filter>
        </defs>

        {/* Soft Background Clouds */}
        <path
          d="M60 135 C60 105 90 85 120 85 C135 55 180 45 210 65 C240 35 300 35 330 65 C360 50 410 65 420 95 C450 100 470 125 460 150 C450 175 420 185 390 185 L100 185 C75 185 60 165 60 135 Z"
          fill="#e0f2fe"
          opacity="0.65"
        />
        <circle cx="100" cy="75" r="4" fill="#93c5fd" opacity="0.6" />
        <circle cx="430" cy="65" r="6" fill="#93c5fd" opacity="0.6" />
        <circle cx="390" cy="40" r="3" fill="#60a5fa" opacity="0.5" />

        {/* Potted Plant on Left */}
        <g transform="translate(110, 100)">
          {/* Stem & Leaves */}
          <path d="M22 45 C15 30 10 18 8 5 C15 10 20 18 22 45" fill="#16a34a" />
          <path d="M22 45 C25 25 30 12 40 0 C38 15 32 30 22 45" fill="#22c55e" />
          <path d="M22 45 C20 32 18 20 22 10 C26 22 25 35 22 45" fill="#4ade80" />
          {/* Pot */}
          <polygon points="10,45 34,45 28,68 16,68" fill="#3b82f6" />
          <path d="M8 43 Q22 40 36 43 L34 46 Q22 43 10 46 Z" fill="#2563eb" />
        </g>

        {/* Document Card behind */}
        <g transform="translate(245, 32)" filter="url(#softShadow)">
          <rect
            x="0"
            y="0"
            width="160"
            height="145"
            rx="12"
            fill="#ffffff"
            stroke="#e2e8f0"
            strokeWidth="1.5"
          />
          {/* Document Content Lines */}
          <rect x="18" y="28" width="55" height="7" rx="3.5" fill="#93c5fd" />
          <rect x="18" y="46" width="105" height="5" rx="2.5" fill="#e2e8f0" />
          <rect x="18" y="58" width="85" height="5" rx="2.5" fill="#e2e8f0" />
          <rect x="18" y="70" width="95" height="5" rx="2.5" fill="#e2e8f0" />
          <rect x="18" y="82" width="70" height="5" rx="2.5" fill="#e2e8f0" />
          {/* Decorative signature line */}
          <path
            d="M18 110 Q50 105 80 115"
            stroke="#cbd5e1"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            fill="none"
          />
          {/* Green Verified Check Badge */}
          <circle cx="132" cy="24" r="16" fill="#22c55e" />
          <path
            d="M125 24 L130 29 L140 18"
            stroke="#ffffff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* Calendar Card in front */}
        <g transform="translate(150, 35)" filter="url(#softShadow)">
          <rect
            x="0"
            y="0"
            width="170"
            height="145"
            rx="12"
            fill="#ffffff"
            stroke="#e2e8f0"
            strokeWidth="1.5"
          />
          {/* Blue Header Bar */}
          <path
            d="M0 12 C0 5.37 5.37 0 12 0 L158 0 C164.63 0 170 5.37 170 12 L170 32 L0 32 Z"
            fill="#3b82f6"
          />
          {/* Calendar Ring clips */}
          <rect x="25" y="-6" width="6" height="12" rx="3" fill="#1e40af" />
          <rect x="139" y="-6" width="6" height="12" rx="3" fill="#1e40af" />
          {/* Calendar Grid Cells */}
          <g transform="translate(18, 44)">
            {/* Row 1 */}
            <rect x="0" y="0" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="26" y="0" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="52" y="0" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="78" y="0" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="104" y="0" width="18" height="13" rx="3" fill="#f1f5f9" />
            {/* Row 2 */}
            <rect x="0" y="19" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="26" y="19" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="52" y="19" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="78" y="19" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="104" y="19" width="18" height="13" rx="3" fill="#f1f5f9" />
            {/* Row 3 */}
            <rect x="0" y="38" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="26" y="38" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="52" y="38" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="78" y="38" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="104" y="38" width="18" height="13" rx="3" fill="#f1f5f9" />
            {/* Row 4 */}
            <rect x="0" y="57" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="26" y="57" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="52" y="57" width="18" height="13" rx="3" fill="#f1f5f9" />
            <rect x="78" y="57" width="18" height="13" rx="3" fill="#f1f5f9" />
            {/* Highlighted Selected Date with Checkmark */}
            <rect x="104" y="57" width="18" height="13" rx="3" fill="#3b82f6" />
            <path
              d="M109 63.5 L112 66.5 L118 60.5"
              stroke="#ffffff"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </g>
      </svg>
    </div>
  )
}

function AdminCyclesPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const { data } = useQuery(cyclesQuery(search))
  const mark = useMarker()

  /**
   * Puts a removed draft back. Only reachable rows are removed ones, which the
   * list shows under "Include removed drafts" — removal itself lives on the
   * cycle's own page, beside the reason input every change here retains.
   */
  const restore = useMutation({
    mutationFn: async (cycle: { id: string; currentVersion: number }) => {
      const result = await gql(RestoreCycleDraftDocument, {
        id: cycle.id,
        expectedVersion: cycle.currentVersion,
      })
      return unwrap(result.admin.programmeCycle.restoreDraft)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-cycles'] }),
  })

  const cycles = data?.nodes ?? []
  const totalCount = data?.pageInfo.totalCount ?? cycles.length
  const filtered = Boolean(
    search.search || search.status || search.cycleYear || search.includeDeleted,
  )

  /** Any filter change invalidates the cursor: it points into another set. */
  const filter = (change: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...change, after: undefined }) })

  return (
    <main className={styles.pageWrap}>
      {/* Header */}
      <div className={styles.headerRow}>
        <div className={styles.headerTitleGroup}>
          <h1 className={styles.pageTitle}>Programme cycles</h1>
          <p className={`${styles.pageSubtitle} page-header-description`}>
            A cycle is the policy an application is judged by. Its rules are frozen into
            every draft started while it is open.
          </p>
        </div>
        <Link
          to="/admin/cycles/new"
          className={styles.createCycleButton}
          {...mark('cycle-list')}
        >
          <Plus size={16} aria-hidden="true" />
          Create a cycle
        </Link>
      </div>

      {/* Illustration Banner */}
      <CyclesBannerIllustration />

      {/* Filter Card */}
      <div className={styles.filterCard}>
        <div className={styles.filterGrid}>
          {/* Code starts with */}
          <div className={styles.filterItem}>
            <label className={styles.filterLabel} htmlFor="cycle-search">
              Code starts with
            </label>
            <div className={styles.searchInputWrap}>
              <input
                id="cycle-search"
                type="text"
                className={styles.searchInput}
                placeholder="Enter code"
                value={search.search ?? ''}
                onChange={(event) =>
                  filter({ search: event.target.value ? event.target.value : undefined })
                }
              />
              <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            </div>
          </div>

          {/* State */}
          <div className={styles.filterItem}>
            <label className={styles.filterLabel} htmlFor="cycle-status">
              State
            </label>
            <select
              id="cycle-status"
              className={styles.selectInput}
              value={search.status ?? ''}
              onChange={(event) =>
                filter({
                  status: (event.target.value || undefined) as
                    ProgrammeCycleStatus | undefined,
                })
              }
            >
              <option value="">Any state</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {humanize(status)}
                </option>
              ))}
            </select>
          </div>

          {/* Programme year */}
          <div className={styles.filterItem}>
            <label className={styles.filterLabel} htmlFor="cycle-year">
              Programme year
            </label>
            <select
              id="cycle-year"
              className={styles.selectInput}
              value={search.cycleYear ?? ''}
              onChange={(event) =>
                filter({
                  cycleYear: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            >
              <option value="">Any year</option>
              {YEAR_OPTIONS.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>

          {/* Include removed drafts toggle */}
          <div className={styles.toggleWrap}>
            <span className={styles.filterLabel}>Include removed drafts</span>
            <label className={styles.switch}>
              <input
                type="checkbox"
                checked={search.includeDeleted ?? false}
                onChange={(event) =>
                  filter({ includeDeleted: event.target.checked ? true : undefined })
                }
              />
              <span className={styles.slider} />
            </label>
          </div>
        </div>
      </div>

      {restore.isError ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginBottom: '1rem' }}
        >
          {messageFor(restore.error)}
        </p>
      ) : null}

      {/* Programme cycles List Card */}
      <div className={styles.cyclesCard}>
        <h2 className={styles.cyclesCardTitle}>Programme cycles</h2>

        {cycles.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyTitle}>
              {filtered ? 'Nothing matches' : 'No cycles yet'}
            </p>
            <p className={styles.emptyDesc}>
              {filtered
                ? 'No cycle matches these filters. Clearing one may bring some back.'
                : 'Applicants cannot start an application until a cycle is open.'}
            </p>
            {filtered ? (
              <button
                type="button"
                className="button"
                onClick={() =>
                  filter({
                    search: undefined,
                    status: undefined,
                    cycleYear: undefined,
                    includeDeleted: undefined,
                  })
                }
              >
                Clear the filters
              </button>
            ) : (
              <Link to="/admin/cycles/new" className="button" data-variant="primary">
                Create the first cycle
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="visually-hidden">Programme cycles</caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: '38%' }}>
                      Cycle
                    </th>
                    <th scope="col" style={{ width: '12%' }}>
                      Year
                    </th>
                    <th scope="col" style={{ width: '14%' }}>
                      State
                    </th>
                    <th scope="col" style={{ width: '14%' }}>
                      Opens
                    </th>
                    <th scope="col" style={{ width: '14%' }}>
                      Closes
                    </th>
                    <th scope="col" style={{ width: '8%' }}>
                      Version
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cycles.map((cycle) => (
                    <tr key={cycle.id} className={styles.tableRow}>
                      <td>
                        <div className={styles.cycleTitleCell}>
                          <div className={styles.calendarIconBadge}>
                            <Calendar size={17} aria-hidden="true" />
                          </div>
                          <div>
                            <Link
                              to="/admin/cycles/$id"
                              params={{ id: cycle.id }}
                              className={styles.cycleLink}
                            >
                              {cycle.displayName}
                            </Link>
                            <span className={styles.cycleCode}> · {cycle.cycleCode}</span>
                          </div>
                        </div>
                      </td>
                      <td>{cycle.cycleYear}</td>
                      <td>
                        {cycle.deletedAt ? (
                          // A removed draft is out of every default view; the
                          // state worth showing is the removal, not "Draft".
                          <span className="row" style={{ gap: '0.5rem' }}>
                            <span className={styles.statusBadge}>Removed</span>
                            <button
                              type="button"
                              className="button"
                              data-variant="ghost"
                              disabled={restore.isPending}
                              onClick={() =>
                                restore.mutate({
                                  id: cycle.id,
                                  currentVersion: cycle.currentVersion,
                                })
                              }
                            >
                              Restore
                            </button>
                          </span>
                        ) : (
                          <span
                            className={styles.statusBadge}
                            data-tone={cycle.status.toLowerCase()}
                          >
                            {humanize(cycle.status)}
                          </span>
                        )}
                      </td>
                      <td>{formatDate(cycle.opensAt)}</td>
                      <td>{formatDate(cycle.closesAt)}</td>
                      <td>{cycle.currentVersion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.resultCount}>
              {totalCount} {totalCount === 1 ? 'result' : 'results'}
            </div>

            {data?.pageInfo.hasNextPage || search.after ? (
              <Pager
                shown={cycles.length}
                totalCount={totalCount}
                hasNextPage={data?.pageInfo.hasNextPage ?? false}
                atStart={!search.after}
                pageSize={PAGE_SIZE}
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
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}
