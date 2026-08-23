import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Pager, SearchBox } from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { cyclesQuery, statusGuideQuery } from '#/features/application/queries'
import {
  MyApplicationsDocument,
  MyEnterprisesDocument,
} from '#/graphql/generated/operations'
import type { ApplicationStatus, ApplicationType } from '#/graphql/generated/schema'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

const PAGE_SIZE = 20

/** Every status an application can be filtered by, in workflow order. */
const STATUSES: ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'DESK_REVIEW',
  'REVISION_REQUIRED',
  'PARTNER_BANK_EVALUATION',
  'TTM_REVIEW',
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
  // All three start together, so the screen costs one round of requests rather
  // than a waterfall of list, then names, then guide.
  loader: async ({ context, deps }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationsQuery(deps)),
      context.queryClient.ensureQueryData(enterpriseNamesQuery),
      context.queryClient.ensureQueryData(statusGuideQuery),
      context.queryClient.ensureQueryData(cyclesQuery),
    ])
  },
  component: ApplicationsPage,
})

function ApplicationsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(applicationsQuery(search))
  const mark = useMarker()
  const { data: enterprises } = useQuery(enterpriseNamesQuery)
  const { data: guide } = useQuery(statusGuideQuery)
  const { data: cycles } = useQuery(cyclesQuery)

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

  return (
    <main className="page">
      <PageHeader
        title="Applications"
        description="Every application you have started, in any programme cycle."
        actions={
          <Link to="/applications/new" className="button" data-variant="primary">
            Start an application
          </Link>
        }
      />

      <div className="filters" {...mark('application-list')}>
        <SearchBox
          id="application-search"
          label="Reference starts with"
          placeholder="SEP-2026"
          value={search.search}
          onChange={(value) => filter({ search: value })}
        />

        <div>
          <label className="field-label" htmlFor="enterprise">
            Enterprise
          </label>
          <select
            id="enterprise"
            className="select"
            value={search.enterpriseId ?? ''}
            onChange={(event) =>
              // The updater form inside `filter` reads the live search rather
              // than the value captured at render, so changing two filters in
              // quick succession cannot drop the first.
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
        </div>

        <div>
          <label className="field-label" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            className="select"
            value={search.status ?? ''}
            onChange={(event) =>
              navigate({
                search: (previous) => ({
                  ...previous,
                  status: (event.target.value || undefined) as
                    ApplicationStatus | undefined,
                  after: undefined,
                }),
              })
            }
          >
            <option value="">Any status</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {labelFor(status)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="cycle">
            Programme cycle
          </label>
          <select
            id="cycle"
            className="select"
            value={search.programmeCycleId ?? ''}
            onChange={(event) =>
              filter({ programmeCycleId: event.target.value || undefined })
            }
          >
            <option value="">Any cycle</option>
            {cycles?.mine.map((cycle) => (
              <option key={cycle.id} value={cycle.id}>
                {cycle.displayName}
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

      {applications.length === 0 ? (
        <div className="card">
          {/* Two different facts: nothing matched, or there is nothing here. */}
          {filtered ? (
            <div className="empty">
              <h3>Nothing matches</h3>
              <p>
                No application matches these filters. Clearing one may bring some back.
              </p>
              <button
                type="button"
                className="button"
                style={{ marginTop: '1rem' }}
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
            </div>
          ) : (
            <div className="empty">
              <h3>Nothing here yet</h3>
              <p>
                Start an application in an open programme cycle to apply for seed funding.
              </p>
              <Link
                to="/applications/new"
                className="button"
                data-variant="primary"
                style={{ marginTop: '1rem' }}
              >
                Start an application
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Your applications</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Enterprise</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last change</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((application) => (
                  <tr key={application.id}>
                    <td>
                      <Link
                        to="/applications/$id"
                        params={{ id: application.id }}
                        className="tabular"
                      >
                        {/* A reference is issued at first submission, so a draft
                            genuinely has none yet. */}
                        {application.referenceNumber ?? 'Draft'}
                      </Link>
                    </td>
                    <td>{application.businessName ?? '—'}</td>
                    <td>
                      {application.cycleCode}
                      <span className="muted"> · {application.cycleYear}</span>
                    </td>
                    <td>
                      {application.applicationType === 'EXPANSION'
                        ? `Expansion · phase ${application.phaseNumber}`
                        : 'Initial'}
                    </td>
                    <td>
                      <span
                        className="badge"
                        data-tone={
                          application.status === 'REVISION_REQUIRED'
                            ? 'action'
                            : application.status === 'REJECTED'
                              ? 'error'
                              : application.status === 'DISBURSED'
                                ? 'ok'
                                : undefined
                        }
                      >
                        {labelFor(application.status)}
                      </span>
                    </td>
                    <td>{formatDate(application.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pager
            shown={applications.length}
            totalCount={data?.pageInfo.totalCount ?? 0}
            hasNextPage={data?.pageInfo.hasNextPage ?? false}
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
        </div>
      )}
    </main>
  )
}
