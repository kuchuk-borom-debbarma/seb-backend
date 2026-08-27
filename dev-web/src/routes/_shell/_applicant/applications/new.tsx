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
  Info,
  Rocket,
  TrendingUp,
} from 'lucide-react'
import { useState } from 'react'
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
  const mark = useMarker()
  const [kind, setKind] = useState<ApplicationKind | null>(null)
  // Which of the two setup categories is on screen. Local state rather than a
  // search param, so an unreachable step can never be typed into the URL.
  const [step, setStep] = useState<SetupStep>('SETUP')

  const { data: enterprises } = useQuery(liveEnterprisesQuery)
  const { data: cycles } = useQuery(cyclesQuery)

  const open = cycles?.available ?? []
  const chosen = Boolean(
    enterprises?.some((enterprise) => enterprise.id === search.enterpriseId) &&
    open.some((cycle) => cycle.id === search.cycleId),
  )
  const activeStep: SetupStep = step === 'TYPE' && chosen ? 'TYPE' : 'SETUP'

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
        to: '/applications/$id',
        params: { id: application.id },
      })
    },
  })

  const selectedCycle = open.find((candidate) => candidate.id === search.cycleId)

  return (
    <main className="page">
      <div className={styles.pageContainer}>
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

        {enterprises?.length === 0 ? (
          <div className={styles.emptyCard}>
            <h3 className={styles.emptyTitle}>Register an enterprise first</h3>
            <p className={styles.emptyText}>
              An application is always made on behalf of one enterprise.
            </p>
            <Link to="/enterprises/new" className="button" data-variant="primary">
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
            <div className={styles.stepper} aria-label="Application setup steps">
              <div
                className={`${styles.stepItem} ${chosen ? styles.stepItemInteractive : ''}`}
                onClick={() => {
                  if (activeStep === 'TYPE') setStep('SETUP')
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

              <div className={styles.stepDivider} />

              <div
                className={`${styles.stepItem} ${chosen ? styles.stepItemInteractive : ''}`}
                onClick={() => {
                  if (chosen && activeStep === 'SETUP') setStep('TYPE')
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

            {start.isError ? (
              <p className="notice" data-tone="error" role="alert">
                {messageFor(start.error)}
              </p>
            ) : null}

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
                // This pair is the whole decision, because the cycle chosen
                // fixes the rules the application is judged by for the rest of
                // its life.
                <div className={styles.formGrid}>
                  <div className={styles.fieldGroup}>
                    <label className={styles.fieldLabel} htmlFor="enterprise">
                      Enterprise
                    </label>
                    <div className={styles.selectWrap}>
                      <select
                        id="enterprise"
                        className={styles.selectInput}
                        value={search.enterpriseId ?? ''}
                        onChange={(event) => {
                          setKind(null)
                          void navigate({
                            search: (previous) => ({
                              ...previous,
                              enterpriseId: event.target.value || undefined,
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
                      <Link to="/enterprises/new" className={styles.helperLink}>
                        Register another enterprise
                      </Link>
                    </div>
                  </div>

                  <hr className={styles.divider} />

                  <div className={styles.fieldGroup}>
                    <label className={styles.fieldLabel} htmlFor="cycle">
                      Programme cycle
                    </label>
                    <div className={styles.selectWrap}>
                      <select
                        id="cycle"
                        className={styles.selectInput}
                        value={search.cycleId ?? ''}
                        onChange={(event) => {
                          setKind(null)
                          void navigate({
                            search: (previous) => ({
                              ...previous,
                              cycleId: event.target.value || undefined,
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

                    {selectedCycle ? (
                      <div className={styles.cycleNotice}>
                        <div className={styles.cycleIconBadge}>
                          <Calendar aria-hidden="true" />
                        </div>
                        <span>
                          {selectedCycle.closesAt ? (
                            <>
                              Applications close {formatDate(selectedCycle.closesAt)} —{' '}
                              <span className={styles.relativeTime}>
                                {formatRelative(selectedCycle.closesAt)}.
                              </span>
                            </>
                          ) : (
                            'No closing date has been set.'
                          )}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div>
                  {checkingEligibility ? (
                    <p className="muted" style={{ fontSize: '13px', margin: '0 0 16px' }}>
                      Checking expansion eligibility…
                    </p>
                  ) : null}

                  <div className={styles.choiceGrid}>
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

                  {/*
                    Every unmet rule is listed separately, because an applicant
                    blocked by three things needs to see three things.
                  */}
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
                      onClick={() => setStep('TYPE')}
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
                      onClick={() => setStep('SETUP')}
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
