import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { cyclesQuery } from '#/features/application/queries'
import {
  ExpansionEligibilityDocument,
  MyEnterprisesDocument,
  StartExpansionApplicationDocument,
  StartInitialApplicationDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatRelative } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

type Search = { enterpriseId?: string; cycleId?: string }

/** Only live enterprises can carry a new application. */
const liveEnterprisesQuery = queryOptions({
  queryKey: ['enterprises', 'live'],
  queryFn: async () => {
    const data = await gql(MyEnterprisesDocument, {
      first: 100,
      after: null,
      includeDeleted: false,
    })
    return unwrap(data.seb.enterprise.mine).nodes
  },
  staleTime: 60_000,
})

/**
 * Expansion eligibility for one enterprise in one cycle.
 *
 * Only asked once both are chosen, because the API needs both to answer, and
 * the answer is what decides whether an expansion can be offered at all.
 */
const eligibilityQuery = (enterpriseId: string, programmeCycleId: string) =>
  queryOptions({
    queryKey: ['expansion-eligibility', enterpriseId, programmeCycleId],
    queryFn: async () => {
      const data = await gql(ExpansionEligibilityDocument, {
        enterpriseId,
        programmeCycleId,
      })
      return unwrap(data.seb.application.expansionEligibility)
    },
  })

export const Route = createFileRoute('/_shell/_applicant/applications/new')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    enterpriseId:
      typeof search.enterpriseId === 'string' ? search.enterpriseId : undefined,
    cycleId: typeof search.cycleId === 'string' ? search.cycleId : undefined,
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(liveEnterprisesQuery),
      context.queryClient.ensureQueryData(cyclesQuery),
    ])
  },
  component: StartApplicationPage,
})

function StartApplicationPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()

  const { data: enterprises } = useQuery(liveEnterprisesQuery)
  const { data: cycles } = useQuery(cyclesQuery)

  const chosen = search.enterpriseId && search.cycleId
  const { data: eligibility } = useQuery({
    ...eligibilityQuery(search.enterpriseId ?? '', search.cycleId ?? ''),
    enabled: Boolean(chosen),
  })

  const start = useMutation({
    mutationFn: async (kind: 'INITIAL' | 'EXPANSION') => {
      const variables = {
        enterpriseId: search.enterpriseId ?? '',
        programmeCycleId: search.cycleId ?? '',
      }
      if (kind === 'EXPANSION') {
        const data = await gql(StartExpansionApplicationDocument, variables)
        return unwrap(data.seb.application.startExpansion)
      }
      const data = await gql(StartInitialApplicationDocument, variables)
      return unwrap(data.seb.application.startInitial)
    },
    onSuccess: async (application) => {
      await queryClient.invalidateQueries({ queryKey: ['applications'] })
      await router.navigate({
        to: '/applications/$id',
        params: { id: application.id },
      })
    },
  })

  const open = cycles?.available ?? []

  return (
    <main className="page">
      <PageHeader
        title="Start an application"
        description="Choose the enterprise applying and the programme cycle to apply in."
      />

      {enterprises?.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h3>Register an enterprise first</h3>
            <p>An application is always made on behalf of one enterprise.</p>
            <Link
              to="/enterprises/new"
              className="button"
              data-variant="primary"
              style={{ marginTop: '1rem' }}
            >
              Register an enterprise
            </Link>
          </div>
        </div>
      ) : open.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h3>No cycle is open for new applications</h3>
            <p>
              A programme cycle must be open before an application can be started. Closed
              cycles stay readable in your history.
            </p>
            <Link to="/cycles" className="button" style={{ marginTop: '1rem' }}>
              See programme cycles
            </Link>
          </div>
        </div>
      ) : (
        <div className="stack">
          <div className="card">
            <div className="card-body">
              <div className="detail-grid">
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
                        search: (previous) => ({
                          ...previous,
                          enterpriseId: event.target.value || undefined,
                        }),
                      })
                    }
                  >
                    <option value="">Choose an enterprise</option>
                    {enterprises?.map((enterprise) => (
                      <option key={enterprise.id} value={enterprise.id}>
                        {enterprise.name}
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
                    value={search.cycleId ?? ''}
                    onChange={(event) =>
                      navigate({
                        search: (previous) => ({
                          ...previous,
                          cycleId: event.target.value || undefined,
                        }),
                      })
                    }
                  >
                    <option value="">Choose a cycle</option>
                    {open.map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {cycle.displayName} ({cycle.cycleCode})
                      </option>
                    ))}
                  </select>
                  {search.cycleId ? (
                    <span className="field-hint">
                      {(() => {
                        const cycle = open.find(
                          (candidate) => candidate.id === search.cycleId,
                        )
                        return cycle?.closesAt
                          ? `Applications close ${formatDate(cycle.closesAt)} — ${formatRelative(cycle.closesAt)}.`
                          : 'No closing date has been set.'
                      })()}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          {start.isError ? (
            <p className="notice" data-tone="error" role="alert">
              {messageFor(start.error)}
            </p>
          ) : null}

          {chosen ? (
            <div className="card">
              <div className="card-body stack">
                <div>
                  <h3>A first application</h3>
                  <p
                    className="muted"
                    style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}
                  >
                    For an enterprise that has not been funded by Mission SEP before.
                  </p>
                  <button
                    type="button"
                    className="button"
                    data-variant="primary"
                    style={{ marginTop: '0.75rem' }}
                    disabled={start.isPending}
                    onClick={() => start.mutate('INITIAL')}
                  >
                    Start an initial application
                  </button>
                </div>

                <hr style={{ border: 0, borderTop: '1px solid var(--hairline)' }} />

                <div>
                  <h3>An expansion</h3>
                  <p
                    className="muted"
                    style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}
                  >
                    For the next phase of an enterprise already funded by an earlier
                    award.
                  </p>

                  {/*
                    Every unmet rule is listed separately, because an applicant
                    blocked by three things needs to see three things.
                  */}
                  {eligibility && !eligibility.eligible ? (
                    <div
                      className="notice"
                      data-tone="action"
                      style={{ marginTop: '0.75rem' }}
                    >
                      <span className="notice-title">
                        This enterprise cannot start an expansion yet
                      </span>
                      <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                        {eligibility.reasons.map((reason) => (
                          <li key={`${reason.code}${reason.obligationId ?? ''}`}>
                            {reason.message}
                          </li>
                        ))}
                      </ul>
                      {eligibility.eligibleAt ? (
                        <p style={{ marginTop: '0.5rem' }}>
                          The earliest it can apply is{' '}
                          {formatDate(eligibility.eligibleAt)}.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="button"
                    style={{ marginTop: '0.75rem' }}
                    disabled={start.isPending || !eligibility?.eligible}
                    onClick={() => start.mutate('EXPANSION')}
                  >
                    {eligibility?.nextPhaseNumber
                      ? `Start phase ${eligibility.nextPhaseNumber}`
                      : 'Start an expansion'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </main>
  )
}
