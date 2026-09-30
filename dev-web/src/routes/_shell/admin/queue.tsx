/**
 * Every submitted application, office-wide.
 *
 * Every filter here is one the API accepts, and the whole filter set lives in
 * the URL — so a view can be bookmarked, sent to a colleague, or reached again
 * by the back button with the same rows in it.
 *
 * The named queues of the hard-coded workflow are gone: which stage holds a
 * file is its pipeline's. This list filters by pipeline, by stage and by the
 * status flags a file holds, and shows the stage each file is at; a stage's
 * own worklist, oldest arrival first, is under "My stages".
 */
import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import {
  filterFieldClass,
  filterLabelClass,
  ListEmpty,
  MultiSelectFilter,
  Pager,
  SearchBox,
} from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { QUEUE_PAGE_SIZE, queueQuery } from '#/features/admin/intakeQueries'
import { statusTone, waitingFor } from '#/features/admin/queues'
import styles from '#/features/admin/Queue.module.css'
import { rupeesToPaise } from '#/features/application/money'
import { AdminCyclesDocument } from '#/graphql/generated/operations'
import type {
  AdminIntakeOrder,
  ApplicationCategory,
  BusinessSector,
  TripuraDistrict,
} from '#/graphql/generated/schema'
import { formatDate, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'
import { dayEnd, dayOf, dayStart, manyOf, oneOf } from '#/lib/search'
import { can } from '#/lib/session'
import {
  myStagesQuery,
  pipelineChoicesQuery,
  pipelineShapeQuery,
} from '#/features/stage/stageQueries'

/** The sorts the API offers, named for what a person is trying to do. */
const ORDERS: { value: AdminIntakeOrder; label: string }[] = [
  { value: 'OLDEST_WAITING', label: 'Longest waiting first' },
  { value: 'NEWEST_SUBMISSION', label: 'Newest submission first' },
  { value: 'LAST_ACTIVITY', label: 'Most recently changed first' },
]

const SECTORS: BusinessSector[] = [
  'AGRICULTURE_AND_ALLIED',
  'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  'FOOD_PROCESSING',
  'TOURISM_AND_HOSPITALITY',
  'INFORMATION_TECHNOLOGY',
  'MANUFACTURING_AND_SERVICES',
  'OTHER',
]

const CATEGORIES: ApplicationCategory[] = ['CATEGORY_A', 'CATEGORY_B']

const DISTRICTS: TripuraDistrict[] = [
  'DHALAI',
  'GOMATI',
  'KHOWAI',
  'NORTH_TRIPURA',
  'SEPAHIJALA',
  'SOUTH_TRIPURA',
  'UNAKOTI',
  'WEST_TRIPURA',
]

/**
 * The cycles the cycle filter offers.
 *
 * The first hundred covers years of a programme that opens a handful of
 * cycles annually; a cycle beyond it is still filterable by URL.
 */
const cycleOptionsQuery = queryOptions({
  queryKey: ['queue-cycle-options'],
  queryFn: async () => {
    const data = await gql(AdminCyclesDocument, {
      first: 100,
      after: null,
      includeDeleted: false,
      status: null,
      cycleYear: null,
      search: null,
    })
    return unwrap(data.admin.programmeCycle.list).nodes
  },
  staleTime: 60_000,
})

type Search = {
  after?: string
  categories?: ApplicationCategory[]
  sectors?: BusinessSector[]
  districts?: TripuraDistrict[]
  cycleId?: string
  /** Rupees as typed; converted to paise at the API boundary. */
  requestedMin?: string
  requestedMax?: string
  loanMin?: string
  loanMax?: string
  /** A pipeline's id; its stages and flags are offered once one is chosen. */
  pipelineId?: string
  stageKeys?: string[]
  /** Files holding every one of these flags. */
  flags?: string[]
  /** Calendar days; widened to whole-day instants at the API boundary. */
  submittedFrom?: string
  submittedTo?: string
  order?: AdminIntakeOrder
  search?: string
}

/** Configured keys from the URL: stage and flag keys share one shape. */
const keysOf = (value: unknown): string[] | undefined => {
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter(
    (each): each is string => typeof each === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(each),
  )
  return list.length > 0 ? list : undefined
}

/** A rupee amount as typed, kept only while it still parses to paise. */
/*
 * An amount from the address. The router reads a bare `?requestedMin=5000` as
 * a number, not a string, so a typed or shared address carrying one must be
 * accepted in either form, or the filter silently falls away.
 */
const rupeesOf = (value: unknown): string | undefined => {
  const text = typeof value === 'number' ? String(value) : value
  return typeof text === 'string' && typeof rupeesToPaise(text) === 'number' ? text : undefined
}

export const Route = createFileRoute('/_shell/admin/queue')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    // The old single-value keys are folded in so bookmarks keep filtering.
    categories: manyOf(CATEGORIES, search.categories) ?? manyOf(CATEGORIES, search.category),
    sectors: manyOf(SECTORS, search.sectors) ?? manyOf(SECTORS, search.sector),
    districts: manyOf(DISTRICTS, search.districts),
    cycleId: typeof search.cycleId === 'string' && search.cycleId ? search.cycleId : undefined,
    requestedMin: rupeesOf(search.requestedMin),
    requestedMax: rupeesOf(search.requestedMax),
    loanMin: rupeesOf(search.loanMin),
    loanMax: rupeesOf(search.loanMax),
    pipelineId:
      typeof search.pipelineId === 'string' && search.pipelineId ? search.pipelineId : undefined,
    // Stages and flags belong to a pipeline, so they are kept only with one.
    stageKeys: search.pipelineId ? keysOf(search.stageKeys) : undefined,
    flags: search.pipelineId ? keysOf(search.flags) : undefined,
    submittedFrom: dayOf(search.submittedFrom),
    submittedTo: dayOf(search.submittedTo),
    order: oneOf(
      ORDERS.map((order) => order.value),
      search.order,
    ),
    search:
      typeof search.search === 'string' && search.search ? search.search : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(queueQuery(inputFor(deps)))
  },
  component: QueuePage,
})

/** Rupees as typed, converted to the paise string the Money scalar takes. */
const paiseOf = (rupees: string | undefined): string | null => {
  if (!rupees) return null
  const paise = rupeesToPaise(rupees)
  return typeof paise === 'number' ? String(paise) : null
}

/** Turns the URL into the API's input. */
const inputFor = (search: Search) => ({
  first: QUEUE_PAGE_SIZE,
  after: search.after ?? null,
  categories: search.categories ?? null,
  sectors: search.sectors ?? null,
  districts: search.districts ?? null,
  cycleId: search.cycleId ?? null,
  requestedMinPaise: paiseOf(search.requestedMin),
  requestedMaxPaise: paiseOf(search.requestedMax),
  loanRequestedMinPaise: paiseOf(search.loanMin),
  loanRequestedMaxPaise: paiseOf(search.loanMax),
  pipelineId: search.pipelineId ?? null,
  stageKeys: search.stageKeys ?? null,
  flags: search.flags ?? null,
  submittedFrom: dayStart(search.submittedFrom),
  submittedTo: dayEnd(search.submittedTo),
  order: search.order ?? 'OLDEST_WAITING',
  search: search.search ?? null,
})

function QueuePage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data, isPlaceholderData } = useQuery(queueQuery(inputFor(search)))
  const { data: cycles } = useQuery(cycleOptionsQuery)
  const mark = useMarker()
  const rows = data?.nodes ?? []
  const pipelines = usePipelineFilter(search.pipelineId)

  /** Resets paging: a filter change makes the old cursor meaningless. */
  const filter = (change: Partial<Search>) =>
    navigate({
      search: (previous) => ({ ...previous, ...change, after: undefined }),
    })

  /* Whether an empty list means "nothing matched" or "nothing submitted". */
  const filtered = Boolean(
    search.search ||
    search.categories ||
    search.sectors ||
    search.districts ||
    search.cycleId ||
    search.requestedMin ||
    search.requestedMax ||
    search.loanMin ||
    search.loanMax ||
    search.pipelineId ||
    search.submittedFrom ||
    search.submittedTo,
  )

  return (
    <main className={styles.pageWrap}>
      <PageHeader
        title="All applications"
        description="Every submitted application, at whichever stage holds it."

        actions={
          <Link to="/admin" className={styles.backButton}>
            <ArrowLeft size={15} aria-hidden="true" />
            Back to dashboard
          </Link>
        }
      />

      {/* Filters Card */}
      <div className={styles.filtersCard} {...mark('queue-filters')}>
        <div className={styles.filtersGrid}>
          {/* SearchBox debounces and mirrors the URL; only its shell is styled. */}
          <div className={filterFieldClass}>
            <SearchBox
              id="queue-search"
              label="Reference or enterprise starts with"
              placeholder="SEP-2026 or Khumulwng"
              value={search.search}
              onChange={(value) => filter({ search: value })}
            />
          </div>

          {/* Order Dropdown */}
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="order">
              Order
            </label>
            <div className={styles.selectWrap}>
              <select
                id="order"
                className={styles.selectControl}
                value={search.order ?? 'OLDEST_WAITING'}
                onChange={(event) =>
                  filter({ order: event.target.value as AdminIntakeOrder })
                }
              >
                {ORDERS.map((order) => (
                  <option key={order.value} value={order.value}>
                    {order.label}
                  </option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>
          </div>

          {/* Type Dropdown */}
          {/* Cycle Dropdown */}
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="cycle">
              Cycle
            </label>
            <div className={styles.selectWrap}>
              <select
                id="cycle"
                className={styles.selectControl}
                value={search.cycleId ?? ''}
                onChange={(event) =>
                  filter({ cycleId: event.target.value || undefined })
                }
              >
                <option value="">Any cycle</option>
                {(cycles ?? []).map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.cycleCode}
                  </option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} aria-hidden="true" />
            </div>
          </div>

          {pipelines.options.length > 0 ? (
            <div className={filterFieldClass}>
              <label className={filterLabelClass} htmlFor="pipeline">
                Pipeline
              </label>
              <div className={styles.selectWrap}>
                <select
                  id="pipeline"
                  className={styles.selectControl}
                  value={search.pipelineId ?? ''}
                  onChange={(event) =>
                    filter({
                      pipelineId: event.target.value || undefined,
                      stageKeys: undefined,
                      flags: undefined,
                    })
                  }
                >
                  <option value="">Any pipeline</option>
                  {pipelines.options.map((pipeline) => (
                    <option key={pipeline.id} value={pipeline.id}>
                      {pipeline.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className={styles.selectChevron} aria-hidden="true" />
              </div>
            </div>
          ) : null}
        </div>

        {/* Multi-value dimensions. Several values OR together; dimensions AND. */}
        <div className={styles.sectorGrid}>
          {search.pipelineId && pipelines.stages.length > 0 ? (
            <MultiSelectFilter
              id="stages"
              label="At stage"
              options={pipelines.stages.map((stage) => stage.key)}
              labelOf={pipelines.stageName}
              selected={search.stageKeys}
              onChange={(stageKeys) => filter({ stageKeys })}
            />
          ) : null}
          {search.pipelineId && pipelines.flags.length > 0 ? (
            <MultiSelectFilter
              id="flags"
              label="Holding every flag"
              options={pipelines.flags.map((flag) => flag.key)}
              labelOf={pipelines.flagLabel}
              selected={search.flags}
              onChange={(flags) => filter({ flags })}
            />
          ) : null}
          <MultiSelectFilter
            id="categories"
            label="Categories"
            options={CATEGORIES}
            selected={search.categories}
            onChange={(categories) => filter({ categories })}
          />
          <MultiSelectFilter
            id="sectors"
            label="Sectors"
            options={SECTORS}
            selected={search.sectors}
            onChange={(sectors) => filter({ sectors })}
          />
          <MultiSelectFilter
            id="districts"
            label="Districts"
            options={DISTRICTS}
            selected={search.districts}
            onChange={(districts) => filter({ districts })}
          />

        </div>

        {/* Amounts are typed in rupees and land on blur, once they mean a number. */}
        <div className={styles.sectorGrid}>
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="requested-min">
              Grant asked at least (₹)
            </label>
            <input
              id="requested-min"
              className={styles.textControl}
              inputMode="decimal"
              placeholder="Any amount"
              key={`min-${search.requestedMin ?? ''}`}
              defaultValue={search.requestedMin ?? ''}
              onBlur={(event) =>
                filter({ requestedMin: rupeesOf(event.target.value.trim()) })
              }
            />
          </div>
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="requested-max">
              Grant asked at most (₹)
            </label>
            <input
              id="requested-max"
              className={styles.textControl}
              inputMode="decimal"
              placeholder="Any amount"
              key={`max-${search.requestedMax ?? ''}`}
              defaultValue={search.requestedMax ?? ''}
              onBlur={(event) =>
                filter({ requestedMax: rupeesOf(event.target.value.trim()) })
              }
            />
          </div>
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="loan-min">
              Loan asked at least (₹)
            </label>
            <input
              id="loan-min"
              className={styles.textControl}
              inputMode="decimal"
              placeholder="Any amount"
              key={`loan-min-${search.loanMin ?? ''}`}
              defaultValue={search.loanMin ?? ''}
              onBlur={(event) => filter({ loanMin: rupeesOf(event.target.value.trim()) })}
            />
          </div>
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="loan-max">
              Loan asked at most (₹)
            </label>
            <input
              id="loan-max"
              className={styles.textControl}
              inputMode="decimal"
              placeholder="Any amount"
              key={`loan-max-${search.loanMax ?? ''}`}
              defaultValue={search.loanMax ?? ''}
              onBlur={(event) => filter({ loanMax: rupeesOf(event.target.value.trim()) })}
            />
          </div>
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="submitted-from">
              Submitted from
            </label>
            <input
              id="submitted-from"
              type="date"
              className={styles.textControl}
              value={search.submittedFrom ?? ''}
              onChange={(event) =>
                filter({ submittedFrom: event.target.value || undefined })
              }
            />
          </div>
          <div className={filterFieldClass}>
            <label className={filterLabelClass} htmlFor="submitted-to">
              Submitted to
            </label>
            <input
              id="submitted-to"
              type="date"
              className={styles.textControl}
              value={search.submittedTo ?? ''}
              onChange={(event) =>
                filter({ submittedTo: event.target.value || undefined })
              }
            />
          </div>
        </div>

      </div>

      {/* Applications Table Card */}
      {rows.length === 0 ? (
        <ListEmpty
          // Three different facts, and the heading has to say which one.
          title={filtered ? 'Nothing matches' : 'No applications yet'}
          text={
            filtered
              ? 'No application matches these filters. Clearing one may bring some back.'
              : 'Nothing has been submitted to the programme office yet.'
          }
          onClear={
            filtered
              ? () =>
                  filter({
                    search: undefined,
                    categories: undefined,
                    sectors: undefined,
                    districts: undefined,
                    cycleId: undefined,
                    requestedMin: undefined,
                    requestedMax: undefined,
                    loanMin: undefined,
                    loanMax: undefined,
                    pipelineId: undefined,
                    stageKeys: undefined,
                    flags: undefined,
                    submittedFrom: undefined,
                    submittedTo: undefined,
                  })
              : undefined
          }
        />
      ) : (
        <div
          className={styles.tableCard}
          aria-busy={isPlaceholderData}
          {...mark('queue-rows')}
        >
          <h2 className={styles.tableTitle}>Applications</h2>
          <div className={styles.tableWrap}>
            <table className={styles.appsTable}>
              <caption className="visually-hidden">Submitted applications</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Enterprise</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Asked for</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Status flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={styles.appsTableRow}>
                    <td>
                      <Link
                        to="/admin/applications/$id"
                        params={{ id: row.id }}
                        className={styles.refLink}
                      >
                        {row.referenceNumber ?? '—'}
                      </Link>
                    </td>
                    <td>
                      <span className={styles.enterpriseText}>{row.enterpriseName}</span>
                    </td>
                    <td className="tabular">{row.cycleCode}</td>
                    <td>
                      {humanize(row.applicationKind)}
                      {row.phaseNumber > 1 ? ` · phase ${row.phaseNumber}` : null}
                      {/* A resubmission is a different job from a first look,
                          and the number says which this is. */}
                      {row.submissionNumber > 1 ? (
                        <span className="muted">
                          {' '}
                          · submission {row.submissionNumber}
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular">
                      {row.requestedGrantPaise == null && row.requestedLoanPaise == null ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className={styles.waitingCell}>
                          {row.requestedGrantPaise != null ? (
                            <span>Grant {formatMoney(row.requestedGrantPaise)}</span>
                          ) : null}
                          {row.requestedLoanPaise != null ? (
                            <span className={styles.waitingSub}>
                              Loan {formatMoney(row.requestedLoanPaise)}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td>
                      {/* Null once an action ended the journey; the flags say how. */}
                      <span
                        className={styles.statusBadge}
                        data-tone={statusTone(row.status)}
                      >
                        {row.currentStageKey
                          ? (row.stageName ?? pipelines.stageName(row.currentStageKey))
                          : 'Finished'}
                      </span>
                    </td>
                    <td>
                      <div className={styles.waitingCell}>
                        <span className={styles.waitingPrimary}>
                          {waitingFor(row.stageEnteredAt ?? row.statusChangedAt)}
                        </span>
                        <span className={styles.waitingSub}>
                          submitted {formatDate(row.submittedAt)}
                        </span>
                      </div>
                    </td>
                    <td>
                      {row.flags.length > 0
                        ? row.flags.map((flag) => flag.label).join(', ')
                        : <span className="muted">None</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.resultsFooter}>
            <span>{data?.pageInfo.totalCount ?? rows.length} results</span>
            <Pager
              shown={rows.length}
              totalCount={data?.pageInfo.totalCount ?? 0}
              hasNextPage={data?.pageInfo.hasNextPage ?? false}
              atStart={!search.after}
              pageSize={QUEUE_PAGE_SIZE}
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
          </div>
        </div>
      )}
    </main>
  )
}

/**
 * What the pipeline filter offers, and how a stage or flag key reads.
 *
 * The published pipelines and a chosen one's stages and flags come from the
 * pipeline reads, which need `pipeline`/`read`. Somebody without it who works
 * stages is offered the pipelines and stages they work instead; flags are then
 * shown by their keys. A key with no name known reads humanized.
 */
function usePipelineFilter(pipelineId: string | undefined) {
  const user = Route.useRouteContext().user
  const mayReadPipelines = can(user, 'pipeline', 'read')
  const { data: choices } = useQuery({ ...pipelineChoicesQuery, enabled: mayReadPipelines })
  const { data: worked } = useQuery({ ...myStagesQuery, enabled: can(user, 'stage', 'read') })

  const options = new Map<string, { id: string; key: string | null; name: string }>()
  for (const choice of choices ?? []) options.set(choice.id, { id: choice.id, key: choice.key, name: choice.name })
  for (const stage of worked ?? []) {
    if (!options.has(stage.pipelineId)) {
      options.set(stage.pipelineId, { id: stage.pipelineId, key: stage.pipelineKey, name: stage.pipelineName })
    }
  }
  const chosenKey = pipelineId ? (options.get(pipelineId)?.key ?? '') : ''
  const { data: shape } = useQuery({
    ...pipelineShapeQuery(chosenKey),
    enabled: mayReadPipelines && chosenKey.length > 0,
  })

  const stages =
    shape?.stages ??
    (worked ?? [])
      .filter((stage) => stage.pipelineId === pipelineId)
      .map((stage) => ({ key: stage.stageKey, name: stage.stageName }))
  const flags = shape?.flags ?? []
  const stageNames = new Map<string, string>([
    ...(worked ?? []).map((stage) => [stage.stageKey, stage.stageName] as const),
    ...stages.map((stage) => [stage.key, stage.name] as const),
  ])
  const flagLabels = new Map(flags.map((flag) => [flag.key, flag.label]))

  return {
    options: [...options.values()],
    stages,
    flags,
    stageName: (key: string) => stageNames.get(key) ?? humanize(key),
    flagLabel: (key: string) => flagLabels.get(key) ?? humanize(key),
  }
}
