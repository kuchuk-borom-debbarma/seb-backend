/** The two decisions that create an initial or expansion application draft. */
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { FormJourney, type JourneyStep } from '#/features/forms/FormJourney'
import { cyclesQuery } from '#/features/application/queries'
import { useMarker } from '#/features/guide/GuideContext'
import {
  ExpansionEligibilityDocument,
  MyEnterprisesDocument,
  StartExpansionApplicationDocument,
  StartInitialApplicationDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatRelative } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

type SetupStep = 'SETUP' | 'TYPE'
type ApplicationKind = 'INITIAL' | 'EXPANSION'
type Search = {
  enterpriseId?: string
  cycleId?: string
  step?: SetupStep
}

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

/** Eligibility is meaningful only after the enterprise and cycle are fixed. */
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
    step: search.step === 'SETUP' || search.step === 'TYPE' ? search.step : undefined,
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
  const mark = useMarker()
  const [kind, setKind] = useState<ApplicationKind | null>(null)

  const { data: enterprises, isFetching: refreshingEnterprises } =
    useQuery(liveEnterprisesQuery)
  const { data: cycles, isFetching: refreshingCycles } = useQuery(cyclesQuery)

  const open = cycles?.available ?? []
  const chosen = Boolean(
    enterprises?.some((enterprise) => enterprise.id === search.enterpriseId) &&
    open.some((cycle) => cycle.id === search.cycleId),
  )
  const activeStep: SetupStep = search.step === 'TYPE' && chosen ? 'TYPE' : 'SETUP'

  // A typed but unreachable step must not remain in history claiming the
  // applicant is on Application type while the setup questions are on screen.
  // Wait for invalidated setup queries: immediately after contextual
  // registration, the cached enterprise list does not contain the new record
  // yet and an early rewrite would discard the intended resume step.
  useEffect(() => {
    if (search.step !== 'TYPE' || chosen || refreshingEnterprises || refreshingCycles) {
      return
    }
    void navigate({
      search: (previous) => ({ ...previous, step: 'SETUP' }),
      replace: true,
    })
  }, [chosen, navigate, refreshingCycles, refreshingEnterprises, search.step])

  const { data: eligibility, isFetching: checkingEligibility } = useQuery({
    ...eligibilityQuery(search.enterpriseId ?? '', search.cycleId ?? ''),
    enabled: chosen,
  })

  const start = useMutation({
    mutationFn: async (applicationKind: ApplicationKind) => {
      const variables = {
        enterpriseId: search.enterpriseId ?? '',
        programmeCycleId: search.cycleId ?? '',
      }
      if (applicationKind === 'EXPANSION') {
        const data = await gql(StartExpansionApplicationDocument, variables)
        return unwrap(data.seb.application.startExpansion)
      }
      const data = await gql(StartInitialApplicationDocument, variables)
      return unwrap(data.seb.application.startInitial)
    },
    onSuccess: async (application) => {
      await queryClient.invalidateQueries({ queryKey: ['applications'] })
      await router.navigate({
        to: '/applications/$id/form',
        params: { id: application.id },
        search: { section: 'ENTERPRISE' },
      })
    },
  })

  return (
    <main className="page">
      <PageHeader
        title="Start an application"
        description="Choose who is applying and the kind of Mission SEP support the enterprise needs."
      />

      {enterprises?.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h3>Register an enterprise first</h3>
            <p>An application is always made on behalf of one enterprise.</p>
            <Link
              to="/enterprises/new"
              search={{ returnTo: 'application', cycleId: search.cycleId }}
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
        <FormJourney
          steps={setupSteps(activeStep, chosen)}
          activeStepId={activeStep}
          onStepSelect={(step) =>
            navigate({
              search: (previous) => ({
                ...previous,
                step: step === 'TYPE' && chosen ? 'TYPE' : 'SETUP',
              }),
            })
          }
          footerStatus={
            activeStep === 'TYPE' && checkingEligibility ? (
              <span className="muted">Checking expansion eligibility…</span>
            ) : null
          }
          footer={
            activeStep === 'SETUP' ? (
              <>
                <Link to="/applications" className="button">
                  Cancel
                </Link>
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  disabled={!chosen}
                  onClick={() =>
                    navigate({
                      search: (previous) => ({ ...previous, step: 'TYPE' }),
                    })
                  }
                >
                  Next
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={start.isPending}
                  onClick={() =>
                    navigate({
                      search: (previous) => ({ ...previous, step: 'SETUP' }),
                    })
                  }
                >
                  Back
                </button>
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  disabled={
                    start.isPending ||
                    kind === null ||
                    (kind === 'EXPANSION' && !eligibility?.eligible)
                  }
                  onClick={() => kind && start.mutate(kind)}
                >
                  {start.isPending
                    ? 'Starting…'
                    : kind === 'INITIAL'
                      ? 'Start an initial application'
                      : kind === 'EXPANSION' && eligibility?.nextPhaseNumber
                        ? `Start phase ${eligibility.nextPhaseNumber}`
                        : 'Choose an application type'}
                </button>
              </>
            )
          }
        >
          {start.isError ? (
            <p
              className="notice"
              data-tone="error"
              role="alert"
              style={{ marginBottom: '1rem' }}
            >
              {messageFor(start.error)}
            </p>
          ) : null}

          {activeStep === 'SETUP' ? (
            <div className="detail-grid" {...mark('start-application')}>
              <div>
                <label className="field-label" htmlFor="enterprise">
                  Enterprise
                </label>
                <select
                  id="enterprise"
                  className="select"
                  value={search.enterpriseId ?? ''}
                  onChange={(event) => {
                    setKind(null)
                    navigate({
                      search: (previous) => ({
                        ...previous,
                        enterpriseId: event.target.value || undefined,
                        step: 'SETUP',
                      }),
                    })
                  }}
                >
                  <option value="">Choose an enterprise</option>
                  {enterprises?.map((enterprise) => (
                    <option key={enterprise.id} value={enterprise.id}>
                      {enterprise.name}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  Need to apply for a different business?{' '}
                  <Link
                    to="/enterprises/new"
                    search={{
                      returnTo: 'application',
                      cycleId: search.cycleId,
                    }}
                  >
                    Register another enterprise
                  </Link>
                  .
                </span>
              </div>

              <div>
                <label className="field-label" htmlFor="cycle">
                  Programme cycle
                </label>
                <select
                  id="cycle"
                  className="select"
                  value={search.cycleId ?? ''}
                  onChange={(event) => {
                    setKind(null)
                    navigate({
                      search: (previous) => ({
                        ...previous,
                        cycleId: event.target.value || undefined,
                        step: 'SETUP',
                      }),
                    })
                  }}
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
          ) : (
            <div className="stack">
              <label className="choice-block">
                <input
                  type="radio"
                  name="applicationKind"
                  value="INITIAL"
                  checked={kind === 'INITIAL'}
                  onChange={() => setKind('INITIAL')}
                />
                <span>
                  <strong>Initial application</strong>
                  <span className="field-hint">
                    The first Mission SEP funding phase for this enterprise.
                  </span>
                </span>
              </label>

              <label className="choice-block" aria-disabled={!eligibility?.eligible}>
                <input
                  type="radio"
                  name="applicationKind"
                  value="EXPANSION"
                  disabled={!eligibility?.eligible}
                  checked={kind === 'EXPANSION'}
                  onChange={() => setKind('EXPANSION')}
                />
                <span>
                  <strong>
                    {eligibility?.nextPhaseNumber
                      ? `Expansion — phase ${eligibility.nextPhaseNumber}`
                      : 'Expansion application'}
                  </strong>
                  <span className="field-hint">
                    The next phase for an enterprise already funded by Mission SEP.
                  </span>
                </span>
              </label>

              {eligibility && !eligibility.eligible ? (
                <div className="notice" data-tone="action">
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
                      The earliest it can apply is {formatDate(eligibility.eligibleAt)}.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </FormJourney>
      )}
    </main>
  )
}

function setupSteps(
  activeStep: SetupStep,
  chosen: boolean,
): Array<JourneyStep<SetupStep>> {
  return [
    {
      id: 'SETUP',
      label: 'Application setup',
      description:
        'Choose the enterprise applying and the open programme cycle whose rules will govern this application.',
      status: activeStep === 'TYPE' ? 'complete' : 'available',
    },
    {
      id: 'TYPE',
      label: 'Application type',
      description:
        'Choose an initial application or, when programme records allow it, the enterprise’s next expansion phase.',
      status: chosen ? 'available' : 'blocked',
    },
  ]
}
