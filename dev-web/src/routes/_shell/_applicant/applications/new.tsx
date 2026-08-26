import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  ChevronDown,
  ExternalLink,
  Info,
  Rocket,
  TrendingUp,
} from 'lucide-react'
import { useEffect, useState } from 'react'
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
import styles from '#/features/application/StartApplication.module.css'

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
  useEffect(() => {
    if (search.step !== 'TYPE' || chosen || refreshingCycles || refreshingEnterprises) {
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

  const selectedCycle = open.find((candidate) => candidate.id === search.cycleId)

  return (
    <main className="page">
      <div className={styles.pageContainer}>
        {/* Header with Back Arrow Link */}
        <div className={styles.headerWrap}>
          <div className={styles.titleRow}>
            <Link
              to="/applications"
              className={styles.backBtn}
              aria-label="Back to applications"
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </Link>
            <h1 className={styles.pageTitle}>Start an application</h1>
          </div>
          <p className={styles.pageDescription}>
            Choose who is applying and the kind of Mission SEP support the enterprise
            needs.
          </p>
        </div>

        {/* Empty States */}
        {enterprises?.length === 0 ? (
          <div className={styles.emptyCard}>
            <h3 className={styles.emptyTitle}>Register an enterprise first</h3>
            <p className={styles.emptyText}>
              An application is always made on behalf of one enterprise.
            </p>
            <Link
              to="/enterprises/new"
              search={{ returnTo: 'application', cycleId: search.cycleId }}
              className="button"
              data-variant="primary"
            >
              Register an enterprise
            </Link>
          </div>
        ) : open.length === 0 ? (
          <div className={styles.emptyCard}>
            <h3 className={styles.emptyTitle}>No cycle is open for new applications</h3>
            <p className={styles.emptyText}>
              A programme cycle must be open before an application can be started. Closed
              cycles stay readable in your history.
            </p>
            <Link to="/cycles" className="button">
              See programme cycles
            </Link>
          </div>
        ) : (
          <>
            {/* Stepper Progress Bar */}
            <div className={styles.stepper} aria-label="Application setup steps">
              {/* Step 1: Application Setup */}
              <div
                className={`${styles.stepItem} ${chosen ? styles.stepItemInteractive : ''}`}
                onClick={() => {
                  if (activeStep === 'TYPE') {
                    navigate({ search: (p) => ({ ...p, step: 'SETUP' }) })
                  }
                }}
              >
                <div
                  className={`${styles.stepCircle} ${
                    activeStep === 'SETUP'
                      ? styles.stepCircleActive
                      : styles.stepCircleComplete
                  }`}
                >
                  1
                </div>
                <div className={styles.stepTextGroup}>
                  <span className={styles.stepLabel}>1. Application setup</span>
                  <span
                    className={
                      activeStep === 'SETUP' ? styles.stepSub : styles.stepSubComplete
                    }
                  >
                    {activeStep === 'SETUP' ? 'Current category' : 'Complete'}
                  </span>
                </div>
              </div>

              {/* Connecting Line */}
              <div className={styles.stepDivider} />

              {/* Step 2: Application Type */}
              <div
                className={`${styles.stepItem} ${chosen ? styles.stepItemInteractive : ''}`}
                onClick={() => {
                  if (chosen && activeStep === 'SETUP') {
                    navigate({ search: (p) => ({ ...p, step: 'TYPE' }) })
                  }
                }}
              >
                <div
                  className={`${styles.stepCircle} ${
                    activeStep === 'TYPE'
                      ? styles.stepCircleActive
                      : styles.stepCircleInactive
                  }`}
                >
                  2
                </div>
                <div className={styles.stepTextGroup}>
                  <span
                    className={`${styles.stepLabel} ${
                      activeStep !== 'TYPE' ? styles.stepLabelInactive : ''
                    }`}
                  >
                    2. Application type
                  </span>
                  <span
                    className={`${styles.stepSub} ${
                      activeStep !== 'TYPE' ? styles.stepSubInactive : ''
                    }`}
                  >
                    {activeStep === 'TYPE'
                      ? 'Current category'
                      : chosen
                        ? 'Available'
                        : 'Complete earlier categories first'}
                  </span>
                </div>
              </div>
            </div>

            {/* Error Message */}
            {start.isError ? (
              <p className="notice" data-tone="error" role="alert">
                {messageFor(start.error)}
              </p>
            ) : null}

            {/* Main Form Card */}
            <div className={styles.card} {...mark('start-application')}>
              <div className={styles.categoryTag}>
                Category {activeStep === 'SETUP' ? '1 of 2' : '2 of 2'}
              </div>
              <h2 className={styles.cardTitle}>
                {activeStep === 'SETUP' ? 'Application setup' : 'Application type'}
              </h2>
              <p className={styles.cardDescription}>
                {activeStep === 'SETUP'
                  ? 'Choose the enterprise applying and the open programme cycle whose rules will govern this application.'
                  : 'Choose an initial application or, when programme records allow it, the enterprise’s next expansion phase.'}
              </p>

              {activeStep === 'SETUP' ? (
                <div className={styles.formGrid}>
                  {/* Enterprise Select */}
                  <div className={styles.fieldGroup}>
                    <label className={styles.fieldLabel} htmlFor="enterprise">
                      Enterprise
                    </label>
                    <div className={styles.selectWrap}>
                      <select
                        id="enterprise"
                        aria-label="Enterprise"
                        className={styles.selectInput}
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
                      <ChevronDown className={styles.selectChevron} aria-hidden="true" />
                    </div>
                    <div className={styles.helperText}>
                      Need to apply for a different business?{' '}
                      <Link
                        to="/enterprises/new"
                        search={{
                          returnTo: 'application',
                          cycleId: search.cycleId,
                        }}
                        className={styles.helperLink}
                      >
                        Register another enterprise
                        <ExternalLink size={13} aria-hidden="true" />
                      </Link>
                    </div>
                  </div>

                  <hr className={styles.divider} />

                  {/* Programme Cycle Select */}
                  <div className={styles.fieldGroup}>
                    <label className={styles.fieldLabel} htmlFor="cycle">
                      Programme cycle
                    </label>
                    <div className={styles.selectWrap}>
                      <select
                        id="cycle"
                        aria-label="Programme cycle"
                        className={styles.selectInput}
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
                      <ChevronDown className={styles.selectChevron} aria-hidden="true" />
                    </div>

                    {selectedCycle?.closesAt ? (
                      <div className={styles.cycleNotice}>
                        <div className={styles.cycleIconBadge}>
                          <Calendar aria-hidden="true" />
                        </div>
                        <span>
                          Applications close {formatDate(selectedCycle.closesAt)} —{' '}
                          <span className={styles.relativeTime}>
                            {formatRelative(selectedCycle.closesAt)}.
                          </span>
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                /* Step 2: Application Type Selection */
                <div>
                  {checkingEligibility ? (
                    <p
                      style={{
                        color: '#6b7280',
                        fontSize: '13px',
                        margin: '0 0 16px',
                      }}
                    >
                      Checking expansion eligibility…
                    </p>
                  ) : null}

                  {/* 2-Column Choice Cards Grid */}
                  <div className={styles.choiceGrid}>
                    {/* Initial Application Choice Card */}
                    <label
                      htmlFor="kind-initial"
                      className={`${styles.choiceCard} ${
                        kind === 'INITIAL' ? styles.choiceCardSelected : ''
                      }`}
                    >
                      <input
                        id="kind-initial"
                        type="radio"
                        name="applicationKind"
                        aria-label="Initial application"
                        value="INITIAL"
                        checked={kind === 'INITIAL'}
                        onChange={() => setKind('INITIAL')}
                        style={{
                          position: 'absolute',
                          inset: 0,
                          width: '100%',
                          height: '100%',
                          opacity: 0,
                          cursor: 'pointer',
                          zIndex: 1,
                        }}
                      />
                      <div
                        className={`${styles.customRadio} ${
                          kind === 'INITIAL' ? styles.customRadioSelected : ''
                        }`}
                      >
                        {kind === 'INITIAL' && <div className={styles.radioDot} />}
                      </div>

                      <div className={styles.choiceIconBadge} data-tone="blue">
                        <Rocket aria-hidden="true" />
                      </div>

                      <div className={styles.choiceContent}>
                        <strong className={styles.choiceTitle}>
                          Initial application
                        </strong>
                        <span className={styles.choiceDescription}>
                          The first Mission SEP funding phase for this enterprise.
                        </span>
                      </div>
                    </label>

                    {/* Expansion Application Choice Card */}
                    <label
                      htmlFor="kind-expansion"
                      className={`${styles.choiceCard} ${
                        kind === 'EXPANSION' ? styles.choiceCardSelected : ''
                      } ${!eligibility?.eligible ? styles.choiceCardDisabled : ''}`}
                      aria-disabled={!eligibility?.eligible}
                    >
                      <input
                        id="kind-expansion"
                        type="radio"
                        name="applicationKind"
                        aria-label="Expansion application"
                        value="EXPANSION"
                        disabled={!eligibility?.eligible}
                        checked={kind === 'EXPANSION'}
                        onChange={() => setKind('EXPANSION')}
                        style={{
                          position: 'absolute',
                          inset: 0,
                          width: '100%',
                          height: '100%',
                          opacity: 0,
                          cursor: eligibility?.eligible ? 'pointer' : 'not-allowed',
                          zIndex: 1,
                        }}
                      />
                      <div
                        className={`${styles.customRadio} ${
                          kind === 'EXPANSION' ? styles.customRadioSelected : ''
                        }`}
                      >
                        {kind === 'EXPANSION' && <div className={styles.radioDot} />}
                      </div>

                      <div className={styles.choiceIconBadge} data-tone="green">
                        <TrendingUp aria-hidden="true" />
                      </div>

                      <div className={styles.choiceContent}>
                        <strong className={styles.choiceTitle}>
                          {eligibility?.nextPhaseNumber
                            ? `Expansion — phase ${eligibility.nextPhaseNumber}`
                            : 'Expansion application'}
                        </strong>
                        <span className={styles.choiceDescription}>
                          The next phase for an enterprise already funded by Mission SEP.
                        </span>
                      </div>
                    </label>
                  </div>

                  {/* Eligibility Alert Callout */}
                  {eligibility && !eligibility.eligible ? (
                    <div className={styles.eligibilityPanel}>
                      <Info className={styles.eligibilityIcon} aria-hidden="true" />
                      <div className={styles.eligibilityTextGroup}>
                        <h4 className={styles.eligibilityTitle}>
                          This enterprise cannot start an expansion yet
                        </h4>
                        <ul className={styles.eligibilityList}>
                          {eligibility.reasons.map((reason) => (
                            <li key={`${reason.code}${reason.obligationId ?? ''}`}>
                              {reason.message}
                            </li>
                          ))}
                        </ul>
                        {eligibility.eligibleAt ? (
                          <p className={styles.eligibilityDate}>
                            The earliest it can apply is{' '}
                            {formatDate(eligibility.eligibleAt)}.
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Card Footer Actions */}
              <div className={styles.cardFooter}>
                {activeStep === 'SETUP' ? (
                  <>
                    <Link to="/applications" className={styles.cancelBtn}>
                      Cancel
                    </Link>
                    <button
                      type="button"
                      className={styles.nextBtn}
                      disabled={!chosen}
                      onClick={() =>
                        navigate({
                          search: (previous) => ({ ...previous, step: 'TYPE' }),
                        })
                      }
                    >
                      Next
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.cancelBtn}
                      disabled={start.isPending}
                      onClick={() =>
                        navigate({
                          search: (previous) => ({ ...previous, step: 'SETUP' }),
                        })
                      }
                    >
                      <ArrowLeft size={16} aria-hidden="true" />
                      Back
                    </button>
                    <button
                      type="button"
                      className={styles.nextBtn}
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
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
