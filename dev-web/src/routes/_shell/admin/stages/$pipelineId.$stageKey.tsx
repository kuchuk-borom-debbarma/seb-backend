/**
 * One stage's queue: the files waiting there, oldest arrival first.
 *
 * Oldest first because that is the order a stage is worked in, and it is the
 * order the queue's index already holds, so the page is a seek rather than a
 * sort. "Load more" continues from the last row shown; a flag filter narrows
 * the list to files holding every flag chosen, and lives in the URL so a
 * narrowed queue can be bookmarked or sent to a colleague.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { ListEmpty } from '#/components/ListControls'
import { waitingFor } from '#/features/admin/queues'
import styles from '#/features/admin/Queue.module.css'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { FlagChips, valueText } from '#/features/stage/StageBits'
import stage from '#/features/stage/Stage.module.css'
import {
  STAGE_QUEUE_PAGE_SIZE,
  fetchStageQueue,
  myStagesQuery,
  pipelineShapeQuery,
} from '#/features/stage/stageQueries'
import { formatDateTime, humanize } from '#/lib/format'
import { messageFor } from '#/lib/result'
import { can } from '#/lib/session'

type Search = { flags?: string[] }

export const Route = createFileRoute('/_shell/admin/stages/$pipelineId/$stageKey')({
  validateSearch: (search: Record<string, unknown>): Search => {
    const raw = search.flags
    const flags = (
      Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
    ).filter(
      (flag): flag is string =>
        typeof flag === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(flag),
    )
    return { flags: flags.length > 0 ? flags : undefined }
  },
  component: StageQueueGate,
})

function StageQueueGate() {
  const { user } = Route.useRouteContext()
  // Owners read with `stage`/`read`; the office-wide reader with `application`/`read`.
  if (!can(user, 'stage', 'read') && !can(user, 'application', 'read')) {
    return (
      <PermissionRefusal title="Stage queue" needs="the officers who work this stage" />
    )
  }
  return <StageQueuePage />
}

function StageQueuePage() {
  const { pipelineId, stageKey } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { user } = Route.useRouteContext()
  const flags = search.flags ?? []

  // The stage's name and its pipeline's key come from the stages this person works.
  const { data: worked } = useQuery({
    ...myStagesQuery,
    enabled: can(user, 'stage', 'read'),
  })
  const here = worked?.find(
    (each) => each.pipelineId === pipelineId && each.stageKey === stageKey,
  )
  const { data: shape } = useQuery({
    ...pipelineShapeQuery(here?.pipelineKey ?? ''),
    enabled: Boolean(here) && can(user, 'pipeline', 'read'),
  })
  const stageName =
    here?.stageName ??
    shape?.stages.find((each) => each.key === stageKey)?.name ??
    humanize(stageKey)

  const pages = useInfiniteQuery({
    queryKey: ['stage-queue', { pipelineId, stageKey, flags }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchStageQueue({
        pipelineId,
        stageKey,
        flags: flags.length > 0 ? flags : null,
        first: STAGE_QUEUE_PAGE_SIZE,
        after: pageParam,
      }),
    getNextPageParam: (last) =>
      last.pageInfo.hasNextPage ? last.pageInfo.endCursor : null,
  })

  const rows = pages.data?.pages.flatMap((page) => page.nodes) ?? []
  const total = pages.data?.pages[0]?.pageInfo.totalCount ?? rows.length

  // The flags a filter can offer: the pipeline's, when readable, else those seen here.
  const flagOptions = new Map<string, string>()
  for (const flag of shape?.flags ?? []) flagOptions.set(flag.key, flag.label)
  for (const row of rows)
    for (const flag of row.flags) flagOptions.set(flag.key, flag.label)
  for (const flag of flags)
    if (!flagOptions.has(flag)) flagOptions.set(flag, humanize(flag))

  const toggle = (flag: string) =>
    navigate({
      search: {
        flags: flags.includes(flag)
          ? flags.filter((each) => each !== flag)
          : [...flags, flag],
      },
      replace: true,
    })

  return (
    <main className={styles.pageWrap}>
      <PageHeader
        title={stageName}
        meta={here?.pipelineName}
        description="Files waiting at this stage, oldest arrival first. Open one to see its stage and the actions it offers."
        actions={
          <Link to="/admin/stages" className={styles.backButton}>
            <ArrowLeft size={15} aria-hidden="true" />
            My stages
          </Link>
        }
      />

      {flagOptions.size > 0 ? (
        <div className={stage.flagFilter} role="group" aria-label="Only files holding">
          <span className="field-label" style={{ margin: 0 }}>
            Only files holding
          </span>
          {[...flagOptions.entries()].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={stage.flagToggle}
              aria-pressed={flags.includes(key)}
              onClick={() => toggle(key)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {pages.error ? (
        <p className="notice" data-tone="error">
          {messageFor(pages.error)}
        </p>
      ) : rows.length === 0 && !pages.isPending ? (
        <ListEmpty
          title={flags.length > 0 ? 'Nothing matches' : 'Nothing waiting'}
          text={
            flags.length > 0
              ? 'No file at this stage holds every flag chosen.'
              : 'No file is waiting at this stage right now.'
          }
          onClear={
            flags.length > 0 ? () => navigate({ search: {}, replace: true }) : undefined
          }
        />
      ) : (
        <div className={styles.tableCard} aria-busy={pages.isFetching}>
          <h2 className={styles.tableTitle}>Waiting here</h2>
          <div className={styles.tableWrap}>
            <table className={styles.appsTable}>
              <caption className="visually-hidden">Files waiting at {stageName}</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Enterprise</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Status</th>
                  <th scope="col">Recorded</th>
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
                    <td>{humanize(row.applicationKind)}</td>
                    <td>
                      <div className={styles.waitingCell}>
                        <span className={styles.waitingPrimary}>
                          {waitingFor(row.stageEnteredAt)}
                        </span>
                        <span className={styles.waitingSub}>
                          arrived {formatDateTime(row.stageEnteredAt)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <FlagChips flags={row.flags} empty="None" />
                    </td>
                    <td>
                      {row.recordedValues.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        row.recordedValues.map((value) => (
                          <div key={value.key} style={{ fontSize: '12.5px' }}>
                            <span className="muted">{value.label}:</span>{' '}
                            {valueText(value)}
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.resultsFooter}>
            <span>
              Showing {rows.length} of {total}
            </span>
            {pages.hasNextPage ? (
              <div className={stage.loadMore}>
                <button
                  type="button"
                  className="button"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => void pages.fetchNextPage()}
                >
                  {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </main>
  )
}
