import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  FileText,
  Search as SearchIcon,
} from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { cyclesQuery, statusGuideQuery } from '#/features/application/queries'
import {
  formTemplateQuery,
  validationQuery,
} from '#/features/application/applicationQueries'
import { resolveTemplate } from '#/features/application/formTemplate'
import {
  journeySteps,
  issuesForStep,
  REVIEW,
} from '#/features/application/ApplicationJourney'
import {
  MyApplicationsDocument,
  MyEnterprisesDocument,
} from '#/graphql/generated/operations'
import type { ApplicationStatus, ApplicationType } from '#/graphql/generated/schema'
import { formatDate, formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'
import styles from '#/features/application/Applications.module.css'

const PAGE_SIZE = 20

/** Every status an application can be filtered by, in workflow order. */
const STATUSES: ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'DESK_REVIEW',
  'REVISION_REQUIRED',
  'PARTNER_BANK_EVALUATION',
  'AWAITING_DECISION',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
  'CANCELLED',
]

type Search = {
  after?: string
  enterpriseId?: string
  status?: ApplicationStatus
  programmeCycleId?: string
  applicationType?: ApplicationType
  search?: string
  includeDeleted?: boolean
}

const applicationsQuery = (search: Search) =>
  queryOptions({
    // The whole filter set is the key, so returning to a view already seen is
    // served from cache rather than refetched.
    queryKey: ['applications', search],
    queryFn: async () => {
      const data = await gql(MyApplicationsDocument, {
        first: PAGE_SIZE,
        after: search.after ?? null,
        enterpriseId: search.enterpriseId ?? null,
        status: search.status ?? null,
        programmeCycleId: search.programmeCycleId ?? null,
        applicationType: search.applicationType ?? null,
        search: search.search ?? null,
        includeDeleted: search.includeDeleted ?? false,
      })
      return unwrap(data.seb.application.mine)
    },
    placeholderData: (previous) => previous,
  })

/** Unfiltered list backing the metric cards, so they do not move with filters. */
const allApplicationsQuery = queryOptions({
  queryKey: ['applications-counts-summary'],
  queryFn: async () => {
    const data = await gql(MyApplicationsDocument, {
      first: 100,
      after: null,
      enterpriseId: null,
      status: null,
      programmeCycleId: null,
      applicationType: null,
      search: null,
      includeDeleted: false,
    })
    return unwrap(data.seb.application.mine).nodes
  },
  staleTime: 10_000,
})

/** Only used to name enterprises in the filter, so the whole record is not needed. */
const enterpriseNamesQuery = queryOptions({
  queryKey: ['enterprise-names'],
  queryFn: async () => {
    const data = await gql(MyEnterprisesDocument, {
      first: 100,
      after: null,
      includeDeleted: true,
    })
    return unwrap(data.seb.enterprise.mine).nodes
  },
  staleTime: 60_000,
})

export const Route = createFileRoute('/_shell/_applicant/applications/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    enterpriseId:
      typeof search.enterpriseId === 'string' ? search.enterpriseId : undefined,
    status: STATUSES.includes(search.status as ApplicationStatus)
      ? (search.status as ApplicationStatus)
      : undefined,
    programmeCycleId:
      typeof search.programmeCycleId === 'string' ? search.programmeCycleId : undefined,
    applicationType:
      search.applicationType === 'INITIAL' || search.applicationType === 'EXPANSION'
        ? search.applicationType
        : undefined,
    search:
      typeof search.search === 'string' && search.search ? search.search : undefined,
    includeDeleted: search.includeDeleted === true ? true : undefined,
  }),
  loaderDeps: ({ search }) => search,
  // All of these start together, so the screen costs one round of requests
  // rather than a waterfall of list, then names, then guide.
  loader: async ({ context, deps }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationsQuery(deps)),
      context.queryClient.ensureQueryData(allApplicationsQuery),
      context.queryClient.ensureQueryData(enterpriseNamesQuery),
      context.queryClient.ensureQueryData(statusGuideQuery),
      context.queryClient.ensureQueryData(cyclesQuery),
    ])
  },
  component: ApplicationsPage,
})

function DraftProgress({ applicationId }: { applicationId: string }) {
  const { data: rawTemplate } = useQuery(formTemplateQuery(applicationId))
  const { data: validation } = useQuery(validationQuery(applicationId))

  if (!rawTemplate || !validation) return null

  const template = resolveTemplate(rawTemplate)
  const order = journeySteps(template)
  const totalSteps = order.length

  const completedCount = order.filter((step) => {
    if (step === REVIEW) {
      return order.every(
        (s) => s === REVIEW || issuesForStep(template, validation.issues, s).length === 0,
      )
    }
    return issuesForStep(template, validation.issues, step).length === 0
  }).length

  return (
    <span className={styles.draftStepsProgress}>
      {completedCount} of {totalSteps} steps complete
    </span>
  )
}

function ApplicationsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(applicationsQuery(search))
  const { data: allApps = [] } = useQuery(allApplicationsQuery)
  const mark = useMarker()
  const { data: enterprises } = useQuery(enterpriseNamesQuery)
  const { data: guide } = useQuery(statusGuideQuery)
  const { data: cycles } = useQuery(cyclesQuery)
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')

  const applications = data?.nodes ?? []
  const labelFor = (status: ApplicationStatus) =>
    guide?.find((entry) => entry.status === status)?.label ?? humanize(status)
  const filtered = Boolean(
    search.search ||
    search.enterpriseId ||
    search.status ||
    search.programmeCycleId ||
    search.applicationType,
  )

  /** Any filter change invalidates the cursor: it points into another set. */
  const filter = (change: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...change, after: undefined }) })

  // Summary counts for the metric cards.
  // Quick lookup maps for the cycle and enterprise columns.
  const cycleMap = new Map((cycles?.mine ?? []).map((c) => [c.id, c]))
  const enterpriseMap = new Map((enterprises ?? []).map((e) => [e.id, e]))

  const sortedApplications = [...applications].sort((a, b) => {
    if (sortOrder === 'oldest') {
      return new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
    }
    return (
      new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
      new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()
    )
  })

  /*
   * Whether starting is possible at all: an open cycle without one of this
   * account's applications, and an enterprise to apply on behalf of. All read
   * from data this screen already loads — offering the door otherwise sends
   * somebody to a screen that can only refuse.
   */
  const canStart =
    (cycles?.available ?? []).some(
      (cycle) => !allApps.some((each) => each.programmeCycleId === cycle.id),
    ) && (enterprises?.length ?? 0) > 0

  return (
    <main className="page">
      <PageHeader
        title="Applications"
        description="View and manage all your applications across programme cycles."
        actions={
          canStart ? (
            <Link to="/applications/new" className="button" data-variant="primary">
              <CirclePlus size={15} aria-hidden="true" />
              Start an application
            </Link>
          ) : null
        }
      />

      <div className={styles.pageContainer} {...mark('application-list')}>
        <div className={styles.controlsBar}>
          <div className={styles.searchWrap}>
            <SearchIcon className={styles.searchIcon} aria-hidden="true" />
            <input
              id="application-search"
              aria-label="Reference starts with"
              type="search"
              className={styles.searchInput}
              placeholder="Search by reference, e.g. SEP-2026"
              value={search.search ?? ''}
              onChange={(event) => filter({ search: event.target.value || undefined })}
            />
          </div>

          <div className={styles.filtersRight}>
            <div className={styles.selectWrap}>
              <select
                id="cycle"
                aria-label="Programme cycle"
                className={styles.filterSelect}
                value={search.programmeCycleId ?? ''}
                onChange={(event) =>
                  filter({ programmeCycleId: event.target.value || undefined })
                }
              >
                <option value="">All cycles</option>
                {cycles?.mine.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.displayName}
                  </option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>

            <div className={styles.selectWrap}>
              <select
                id="enterprise"
                aria-label="Enterprise"
                className={styles.filterSelect}
                value={search.enterpriseId ?? ''}
                onChange={(event) =>
                  // The updater form inside `filter` reads the live search
                  // rather than the value captured at render, so changing two
                  // filters in quick succession cannot drop the first.
                  filter({ enterpriseId: event.target.value || undefined })
                }
              >
                <option value="">All enterprises</option>
                {enterprises?.map((enterprise) => (
                  <option key={enterprise.id} value={enterprise.id}>
                    {enterprise.name}
                  </option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>

            <div className={styles.selectWrap}>
              <select
                id="status"
                aria-label="Status"
                className={styles.filterSelect}
                value={search.status ?? ''}
                onChange={(event) =>
                  filter({
                    status: (event.target.value || undefined) as
                      ApplicationStatus | undefined,
                  })
                }
              >
                <option value="">All statuses</option>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {labelFor(status)}
                  </option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>

            <div className={styles.selectWrap}>
              <select
                id="type"
                aria-label="Application type"
                className={styles.filterSelect}
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
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>

            <div className={styles.selectWrap}>
              <select
                id="sort-order"
                aria-label="Sort order"
                className={styles.filterSelect}
                value={sortOrder}
                onChange={(event) =>
                  setSortOrder(event.target.value as 'newest' | 'oldest')
                }
              >
                <option value="newest">Sort by: Newest</option>
                <option value="oldest">Sort by: Oldest</option>
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={search.includeDeleted ?? false}
                onChange={(event) =>
                  filter({ includeDeleted: event.target.checked ? true : undefined })
                }
              />
              Include removed drafts
            </label>
          </div>
        </div>

        {applications.length === 0 ? (
          <div className={styles.tableCard}>
            <div className={styles.emptyCard}>
              <div className={styles.emptyIcon}>
                <FileText size={24} aria-hidden="true" />
              </div>
              {/* Two different facts: nothing matched, or there is nothing here. */}
              {filtered ? (
                <>
                  <h3 className={styles.emptyTitle}>Nothing matches</h3>
                  <p className={styles.emptyDescription}>
                    No application matches these filters. Clearing one may bring some
                    back.
                  </p>
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      filter({
                        search: undefined,
                        enterpriseId: undefined,
                        status: undefined,
                        programmeCycleId: undefined,
                        applicationType: undefined,
                      })
                    }
                  >
                    Clear the filters
                  </button>
                </>
              ) : (
                <>
                  <h3 className={styles.emptyTitle}>Nothing here yet</h3>
                  <p className={styles.emptyDescription}>
                    Start an application in an open programme cycle to apply for seed
                    funding.
                  </p>
                  {canStart ? (
                    <Link to="/applications/new" className="button" data-variant="primary">
                      Start an application
                    </Link>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.tableCard}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="visually-hidden">Your applications</caption>
                <thead>
                  <tr>
                    <th scope="col" className={styles.th}>
                      Application
                    </th>
                    <th scope="col" className={styles.th}>
                      Cycle
                    </th>
                    <th scope="col" className={styles.th}>
                      Enterprise
                    </th>
                    <th scope="col" className={styles.th}>
                      Status
                    </th>
                    <th scope="col" className={styles.th}>
                      Last updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedApplications.map((application) => {
                    const cycle = cycleMap.get(application.programmeCycleId)
                    const enterprise = enterpriseMap.get(application.enterpriseId)
                    return (
                      // The whole row opens the application. The title Link
                      // carries keyboard and screen-reader access; the row
                      // handler only widens the click target, and ignores
                      // clicks on the Link itself so nothing navigates twice.
                      <tr
                        key={application.id}
                        className={styles.tr}
                        style={{ cursor: 'pointer' }}
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest('a')) return
                          void navigate({
                            to: '/applications/$id',
                            params: { id: application.id },
                          })
                        }}
                      >
                        <td className={styles.td}>
                          <div className={styles.cellStack}>
                            <Link
                              to="/applications/$id"
                              params={{ id: application.id }}
                              className={styles.appTitle}
                            >
                              {application.applicationType === 'EXPANSION'
                                ? 'Expansion Application'
                                : 'Seed Grant Application'}
                            </Link>
                            <span className={styles.appRef}>
                              {/* A reference is issued at first submission, so
                                  a draft genuinely has none yet. */}
                              {application.referenceNumber ?? 'Draft'}
                            </span>
                            <span
                              className={styles.typeBadge}
                              data-type={application.applicationType}
                            >
                              {application.applicationType === 'EXPANSION'
                                ? `Expansion · Phase ${application.phaseNumber}`
                                : 'Seed Grant'}
                            </span>
                          </div>
                        </td>
                        <td className={styles.td}>
                          <div className={styles.cellStack}>
                            <span className={styles.cycleName}>
                              {cycle?.displayName ??
                                `${application.cycleCode} · ${application.cycleYear}`}
                            </span>
                            {cycle?.closesAt ? (
                              <span className={styles.cycleCloses}>
                                Closes {formatDateTime(cycle.closesAt)}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className={styles.td}>
                          <div className={styles.cellStack}>
                            <span className={styles.enterpriseName}>
                              {application.businessName ?? enterprise?.name ?? '—'}
                            </span>
                            {enterprise?.registrationNumber ? (
                              <span className={styles.enterpriseRef}>
                                {enterprise.registrationNumber}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className={styles.td}>
                          <div className={styles.cellStack}>
                            <div>
                              <span
                                className={styles.statusPill}
                                data-status={application.status}
                              >
                                {labelFor(application.status)}
                              </span>
                            </div>
                            {application.status === 'DRAFT' ? (
                              <DraftProgress applicationId={application.id} />
                            ) : null}
                          </div>
                        </td>
                        <td className={styles.td}>
                          <div className={styles.cellStack}>
                            <span className={styles.dateText}>
                              {formatDate(application.updatedAt)}
                            </span>
                            <span className={styles.timeText}>
                              {application.updatedAt
                                ? new Intl.DateTimeFormat('en-IN', {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    hour12: true,
                                    timeZone: 'Asia/Kolkata',
                                  })
                                    .format(new Date(application.updatedAt))
                                    .toLowerCase()
                                : ''}
                            </span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className={styles.paginationBar}>
              <span>
                Showing {applications.length} of {data?.pageInfo.totalCount ?? 0}{' '}
                {data?.pageInfo.totalCount === 1 ? 'application' : 'applications'}
              </span>
              <div className={styles.pageControls}>
                <button
                  type="button"
                  className={styles.pageBtn}
                  disabled={!search.after}
                  onClick={() =>
                    navigate({
                      search: (previous) => ({ ...previous, after: undefined }),
                    })
                  }
                  title="First page"
                  aria-label="First page"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.pageBtn}
                  disabled={!data?.pageInfo.hasNextPage}
                  onClick={() =>
                    navigate({
                      search: (previous) => ({
                        ...previous,
                        after: data?.pageInfo.endCursor ?? undefined,
                      }),
                    })
                  }
                  title="Next page"
                  aria-label="Next page"
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
