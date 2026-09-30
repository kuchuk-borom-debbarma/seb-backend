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
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { cyclesQuery } from '#/features/application/queries'
import { useMarker } from '#/features/guide/GuideContext'
import {
  ApplicationKindEligibilityDocument,
  MyEnterprisesDocument,
  StartApplicationDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatRelative } from '#/lib/format'
import { applicantDashboardQuery } from '#/features/dashboard/dashboardQueries'
import { gql } from '#/lib/graphql'
import { humanize } from '#/lib/format'
import { messageFor, unwrap } from '#/lib/result'
import styles from '#/features/application/StartApplication.module.css'

type SetupStep = 'SETUP' | 'TYPE'
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
 * The kinds of application a cycle accepts, judged for one enterprise.
 *
 * Only asked once both are chosen, because the API needs both to answer: the
 * kinds are the cycle's, and whether each is open is the enterprise's history
 * read against that kind's rules.
 */
const kindsQuery = (enterpriseId: string, programmeCycleId: string) =>
  queryOptions({
    queryKey: ['application-kinds', enterpriseId, programmeCycleId],
    queryFn: async () => {
      const data = await gql(ApplicationKindEligibilityDocument, {
        enterpriseId,
        programmeCycleId,
      })
      return unwrap(data.seb.application.applicationKinds).kinds
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
  const [kind, setKind] = useState<string | null>(null)
  // Which of the two setup categories is on screen. Local state rather than a
  // search param, so an unreachable step can never be typed into the URL.
  const [step, setStep] = useState<SetupStep>('SETUP')

  const { data: enterprises } = useQuery(liveEnterprisesQuery)
  const { data: cycles } = useQuery(cyclesQuery)
  // The account's own applications, from the shared dashboard call: a cycle
  // this enterprise has already applied in is not a choice, it is history.
  const { data: mine } = useQuery(applicantDashboardQuery)

  const open = cycles?.available ?? []
  /*
   * A draft already under way for this enterprise is offered back rather than
   * a second one started. Whether a further application may start once one is
   * submitted is the kind's own rules' question, answered below per kind.
   */
  const liveApplication = search.enterpriseId
    ? ((mine?.applications.nodes ?? []).find(
        (application) =>
          application.enterpriseId === search.enterpriseId &&
          application.status === 'DRAFT',
      ) ?? null)
    : null

  /*
   * A choice of one is not a choice. With a single enterprise or a single
   * open cycle, the select is filled in and locked — the applicant reads
   * what will be used instead of being asked to pick it.
   */
  const soleEnterpriseId = enterprises?.length === 1 ? enterprises[0]!.id : null
  const soleCycleId = open.length === 1 ? open[0]!.id : null
  useEffect(() => {
    const enterpriseId =
      search.enterpriseId ?? (soleEnterpriseId !== null ? soleEnterpriseId : undefined)
    const cycleId = search.cycleId ?? (soleCycleId !== null ? soleCycleId : undefined)
    if (enterpriseId === search.enterpriseId && cycleId === search.cycleId) return
    void navigate({
      search: (previous) => ({ ...previous, enterpriseId, cycleId }),
      replace: true,
    })
  }, [navigate, search.cycleId, search.enterpriseId, soleCycleId, soleEnterpriseId])

  const chosen = Boolean(
    enterprises?.some((enterprise) => enterprise.id === search.enterpriseId) &&
    open.some((cycle) => cycle.id === search.cycleId),
  )
  const activeStep: SetupStep = step === 'TYPE' && chosen ? 'TYPE' : 'SETUP'

  const { data: kinds, isFetching: checkingEligibility } = useQuery({
    ...kindsQuery(search.enterpriseId ?? '', search.cycleId ?? ''),
    enabled: chosen,
  })
  const chosenKind = kinds?.find((each) => each.kindKey === kind) ?? null

  const start = useMutation({
    mutationFn: async (applicationKind: string) => {
      const data = await gql(StartApplicationDocument, {
        enterpriseId: search.enterpriseId ?? '',
        programmeCycleId: search.cycleId ?? '',
        applicationKind,
      })
      return unwrap(data.seb.application.start)
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
        ) : liveApplication ? (
          <div className={styles.emptyCard}>
            <h3 className={styles.emptyTitle}>
              This enterprise already has a live application
            </h3>
            <p className={styles.emptyText}>
              A {humanize(liveApplication.status).toLowerCase()} is already under way for
              this enterprise. Finish or remove it before starting another.
            </p>
            <Link
              to="/applications/$id"
              params={{ id: liveApplication.id }}
              className="button"
              data-variant="primary"
            >
              Open that application
            </Link>
          </div>
        ) : open.length === 0 ? (
          <div className={styles.emptyCard}>
            <h3 className={styles.emptyTitle}>No cycle is open for new applications</h3>
            <p className={styles.emptyText}>
              A programme cycle must be open before an application can be started.
              Closed cycles stay readable in your history.
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
                  : 'Choose one of the kinds of application this cycle accepts. A kind this enterprise cannot start yet says why.'}
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
                        disabled={soleEnterpriseId !== null}
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
                        disabled={soleCycleId !== null}
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
                      Checking which kinds this enterprise may start…
                    </p>
                  ) : null}

                  <div className={styles.choiceGrid}>
                    {(kinds ?? []).map((option) => (
                      <label
                        key={option.kindKey}
                        htmlFor={`kind-${option.kindKey}`}
                        className={`${styles.choiceCard} ${
                          kind === option.kindKey ? styles.choiceCardSelected : ''
                        } ${option.eligible ? '' : styles.choiceCardDisabled}`}
                        aria-disabled={!option.eligible}
                      >
                        <input
                          id={`kind-${option.kindKey}`}
                          type="radio"
                          name="applicationKind"
                          aria-label={option.label}
                          value={option.kindKey}
                          disabled={!option.eligible}
                          checked={kind === option.kindKey}
                          onChange={() => setKind(option.kindKey)}
                          style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            opacity: 0,
                            cursor: option.eligible ? 'pointer' : 'not-allowed',
                            zIndex: 1,
                          }}
                        />
                        <div
                          className={`${styles.customRadio} ${
                            kind === option.kindKey ? styles.customRadioSelected : ''
                          }`}
                        >
                          {kind === option.kindKey && <div className={styles.radioDot} />}
                        </div>

                        <div className={styles.choiceIconBadge} data-tone="blue">
                          <Rocket aria-hidden="true" />
                        </div>

                        <div className={styles.choiceContent}>
                          <strong className={styles.choiceTitle}>{option.label}</strong>
                          {option.description ? (
                            <span className={styles.choiceDescription}>
                              {option.description}
                            </span>
                          ) : null}
                        </div>
                      </label>
                    ))}
                  </div>

                  {/*
                    Every unmet rule is listed separately, because an applicant
                    blocked by three things needs to see three things.
                  */}
                  {(kinds ?? [])
                    .filter((option) => !option.eligible)
                    .map((option) => (
                      <div key={option.kindKey} className={styles.eligibilityPanel}>
                        <Info className={styles.eligibilityIcon} aria-hidden="true" />
                        <div className={styles.eligibilityTextGroup}>
                          <h4 className={styles.eligibilityTitle}>
                            This enterprise cannot start {option.label.toLowerCase()} yet
                          </h4>
                          <ul className={styles.eligibilityList}>
                            {option.reasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ))}
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
                      disabled={start.isPending || !chosenKind?.eligible}
                      onClick={() => kind && start.mutate(kind)}
                    >
                      {start.isPending
                        ? 'Starting…'
                        : chosenKind
                          ? `Start: ${chosenKind.label}`
                          : 'Choose a kind of application'}
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
