import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Search as SearchIcon,
} from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { MyEnterprisesDocument } from '#/graphql/generated/operations'
import type { BusinessSector, EnterpriseStatus } from '#/graphql/generated/schema'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'
import styles from '#/features/enterprise/Enterprises.module.css'

/** The server's page size. Kept small because these lists are browsed, not scanned. */
const PAGE_SIZE = 20

type Search = {
  after?: string
  includeDeleted?: boolean
  search?: string
  status?: EnterpriseStatus
  sector?: BusinessSector
}

const STATUSES: EnterpriseStatus[] = ['PROPOSED', 'ACTIVE', 'INACTIVE']

const SECTORS: BusinessSector[] = [
  'AGRICULTURE_AND_ALLIED',
  'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  'FOOD_PROCESSING',
  'TOURISM_AND_HOSPITALITY',
  'INFORMATION_TECHNOLOGY',
  'MANUFACTURING_AND_SERVICES',
  'OTHER',
]

const oneOf = <TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): TValue | undefined =>
  allowed.includes(value as TValue) ? (value as TValue) : undefined

const enterprisesQuery = (search: Search) =>
  queryOptions({
    // Keyed by the search parameters, so paging back to a page already seen is
    // served from cache instead of refetched.
    queryKey: ['enterprises', search],
    queryFn: async () => {
      const data = await gql(MyEnterprisesDocument, {
        first: PAGE_SIZE,
        after: search.after ?? null,
        includeDeleted: search.includeDeleted ?? false,
        search: search.search ?? null,
        status: search.status ?? null,
        sector: search.sector ?? null,
      })
      return unwrap(data.seb.enterprise.mine)
    },
    // Keeps the current rows on screen while the next page or filter loads,
    // rather than blanking the table and shifting the layout.
    placeholderData: (previous) => previous,
  })

export const Route = createFileRoute('/_shell/_applicant/enterprises/')({
  // Filters and the cursor live in the URL, so a page can be linked, shared and
  // returned to by the back button rather than living in component state.
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    includeDeleted: search.includeDeleted === true ? true : undefined,
    search:
      typeof search.search === 'string' && search.search ? search.search : undefined,
    status: oneOf(STATUSES, search.status),
    sector: oneOf(SECTORS, search.sector),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(enterprisesQuery(deps)),
  component: EnterprisesPage,
})

function EnterprisesPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(enterprisesQuery(search))
  const mark = useMarker()

  const enterprises = data?.nodes ?? []
  const filtered = Boolean(search.search || search.status || search.sector)

  /** Any filter change invalidates the cursor: it points into another set. */
  const filter = (change: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...change, after: undefined }) })

  return (
    <main className="page">
      <PageHeader
        title="Enterprises"
        description="Each application is made on behalf of one enterprise. Register it here first."
        actions={
          <Link
            to="/enterprises/new"
            className="button"
            data-variant="primary"
            {...mark('enterprise-list')}
          >
            <CirclePlus size={15} aria-hidden="true" />
            Register an enterprise
          </Link>
        }
      />

      <div className={styles.pageContainer}>
        {/* Top filter card */}
        <section className={styles.filterCard} aria-label="Enterprise filters">
          <div className={styles.filterGrid}>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="enterprise-search">
                Name starts with
              </label>
              <div className={styles.searchWrap}>
                <input
                  id="enterprise-search"
                  type="search"
                  className={styles.searchInput}
                  placeholder="Khumulwng"
                  value={search.search ?? ''}
                  onChange={(event) =>
                    filter({ search: event.target.value || undefined })
                  }
                />
                <SearchIcon className={styles.searchIcon} aria-hidden="true" />
              </div>
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="enterprise-status">
                State
              </label>
              <div className={styles.selectWrap}>
                <select
                  id="enterprise-status"
                  className={styles.filterSelect}
                  value={search.status ?? ''}
                  onChange={(event) =>
                    filter({
                      status: (event.target.value || undefined) as
                        | EnterpriseStatus
                        | undefined,
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
                <ChevronDown className={styles.selectChevron} aria-hidden="true" />
              </div>
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="enterprise-sector">
                Sector
              </label>
              <div className={styles.selectWrap}>
                <select
                  id="enterprise-sector"
                  className={styles.filterSelect}
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

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={search.includeDeleted ?? false}
              onChange={(event) =>
                filter({ includeDeleted: event.target.checked ? true : undefined })
              }
            />
            Include removed enterprises
          </label>
        </section>

        {/* Your enterprises card */}
        {enterprises.length === 0 ? (
          <div className={styles.tableCard}>
            {/* Two different facts, and telling them apart is the point of
                knowing the total: nothing matched, or there is nothing here. */}
            <div className={styles.emptyCard}>
              <div className={styles.emptyIcon}>
                <Building2 size={24} aria-hidden="true" />
              </div>
              {filtered ? (
                <>
                  <h3 className={styles.emptyTitle}>Nothing matches</h3>
                  <p className={styles.emptyDescription}>
                    No enterprise matches these filters. Clearing one may bring some
                    back.
                  </p>
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      filter({ search: undefined, status: undefined, sector: undefined })
                    }
                  >
                    Clear the filters
                  </button>
                </>
              ) : (
                <>
                  <h3 className={styles.emptyTitle}>No enterprises yet</h3>
                  <p className={styles.emptyDescription}>
                    Register the enterprise you are applying for, then start an
                    application in an open programme cycle.
                  </p>
                  <Link to="/enterprises/new" className="button" data-variant="primary">
                    Register an enterprise
                  </Link>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.tableCard}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Your enterprises</h2>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="visually-hidden">Your enterprises</caption>
                <thead>
                  <tr>
                    <th scope="col" className={styles.th}>
                      Enterprise
                    </th>
                    <th scope="col" className={styles.th}>
                      Sector
                    </th>
                    <th scope="col" className={styles.th}>
                      Where
                    </th>
                    <th scope="col" className={styles.th}>
                      Established
                    </th>
                    <th scope="col" className={styles.th}>
                      State
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {enterprises.map((enterprise) => (
                    // The whole row opens the enterprise. The name Link carries
                    // keyboard and screen-reader access; the row handler only
                    // widens the click target, and ignores clicks on the Link
                    // itself so nothing navigates twice.
                    <tr
                      key={enterprise.id}
                      className={styles.tr}
                      style={{ cursor: 'pointer' }}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest('a')) return
                        void navigate({
                          to: '/enterprises/$id',
                          params: { id: enterprise.id },
                        })
                      }}
                    >
                      <td className={styles.td}>
                        <Link
                          to="/enterprises/$id"
                          params={{ id: enterprise.id }}
                          className={styles.enterpriseLink}
                        >
                          {enterprise.name}
                        </Link>
                      </td>
                      <td className={styles.td}>
                        {enterprise.businessSector
                          ? enterprise.businessSector === 'OTHER'
                            ? (enterprise.otherBusinessSector ?? 'Other')
                            : humanize(enterprise.businessSector)
                          : '—'}
                      </td>
                      <td className={styles.td}>
                        {[enterprise.businessBlockOrVillage, enterprise.businessDistrict]
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </td>
                      <td className={styles.td}>
                        {formatDate(enterprise.establishmentDate)}
                      </td>
                      <td className={styles.td}>
                        {enterprise.deletedAt ? (
                          <span className={styles.statusPill} data-status="REMOVED">
                            Removed
                          </span>
                        ) : (
                          <span
                            className={styles.statusPill}
                            data-status={enterprise.status}
                          >
                            {humanize(enterprise.status)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/*
              Cursor paging only ever moves forward, because that is what the
              API provides. "First page" replaces a back button that could not
              be made correct.
            */}
            <div className={styles.cardFooter}>
              <span className={styles.resultsCount}>
                Showing {enterprises.length} of {data?.pageInfo.totalCount ?? 0}{' '}
                {data?.pageInfo.totalCount === 1 ? 'enterprise' : 'enterprises'}
              </span>
              {(data?.pageInfo.hasNextPage || search.after) && (
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
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
