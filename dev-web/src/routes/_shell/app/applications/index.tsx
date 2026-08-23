import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { statusGuideQuery } from '#/features/application/queries'
import {
  MyApplicationsDocument,
  MyEnterprisesDocument,
} from '#/graphql/generated/operations'
import type { ApplicationStatus } from '#/graphql/generated/schema'
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
  includeDeleted?: boolean
}

const applicationsQuery = (search: Search) =>
  queryOptions({
    queryKey: [
      'applications',
      search.after ?? null,
      search.enterpriseId ?? null,
      search.status ?? null,
      search.includeDeleted ?? false,
    ],
    queryFn: async () => {
      const data = await gql(MyApplicationsDocument, {
        first: PAGE_SIZE,
        after: search.after ?? null,
        enterpriseId: search.enterpriseId ?? null,
        status: search.status ?? null,
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

export const Route = createFileRoute('/_shell/app/applications/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    enterpriseId:
      typeof search.enterpriseId === 'string' ? search.enterpriseId : undefined,
    status: STATUSES.includes(search.status as ApplicationStatus)
      ? (search.status as ApplicationStatus)
      : undefined,
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
    ])
  },
  component: ApplicationsPage,
})

function ApplicationsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(applicationsQuery(search))
  const { data: enterprises } = useQuery(enterpriseNamesQuery)
  const { data: guide } = useQuery(statusGuideQuery)

  const applications = data?.nodes ?? []
  const labelFor = (status: ApplicationStatus) =>
    guide?.find((entry) => entry.status === status)?.label ?? humanize(status)

  return (
    <main className="page">
      <PageHeader
        title="Applications"
        description="Every application you have started, in any programme cycle."
        actions={
          <Link to="/app/applications/new" className="button" data-variant="primary">
            Start an application
          </Link>
        }
      />

      <div className="filters">
        <div>
          <label className="field-label" htmlFor="enterprise">
            Enterprise
          </label>
          <select
            id="enterprise"
            className="select"
            value={search.enterpriseId ?? ''}
            onChange={(event) =>
              navigate({
                // The updater form reads the live search rather than the value
                // captured at render, so changing two filters in quick
                // succession cannot drop the first.
                search: (previous) => ({
                  ...previous,
                  enterpriseId: event.target.value || undefined,
                  after: undefined,
                }),
              })
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

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={search.includeDeleted ?? false}
            onChange={(event) =>
              navigate({
                search: (previous) => ({
                  ...previous,
                  includeDeleted: event.target.checked ? true : undefined,
                  after: undefined,
                }),
              })
            }
          />
          Include removed drafts
        </label>
      </div>

      {applications.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h3>Nothing here yet</h3>
            <p>
              {search.enterpriseId || search.status
                ? 'No application matches these filters.'
                : 'Start an application in an open programme cycle to apply for seed funding.'}
            </p>
          </div>
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
                        to="/app/applications/$id"
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

          {data?.pageInfo.hasNextPage || search.after ? (
            <div className="pager">
              <button
                type="button"
                className="button"
                disabled={!search.after}
                onClick={() =>
                  navigate({ search: (previous) => ({ ...previous, after: undefined }) })
                }
              >
                Start again
              </button>
              <button
                type="button"
                className="button"
                disabled={!data?.pageInfo.hasNextPage}
                onClick={() =>
                  navigate({
                    search: (previous) => ({
                      ...previous,
                      after: data?.pageInfo.endCursor ?? undefined,
                    }),
                  })
                }
              >
                Next page
              </button>
            </div>
          ) : null}
        </div>
      )}
    </main>
  )
}
