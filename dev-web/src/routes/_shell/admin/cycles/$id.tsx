import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import {
  AdminCycleByIdDocument,
  ArchiveCycleDocument,
  ChangeCycleClosingDocument,
  CloseCycleDocument,
  OpenCycleDocument,
  UpdateCycleGuidanceDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

const cycleQuery = (id: string) =>
  queryOptions({
    queryKey: ['admin-cycle', id],
    queryFn: async () => {
      const data = await gql(AdminCycleByIdDocument, { id })
      return {
        cycle: unwrap(data.admin.programmeCycle.byId),
        counts: data.admin.programmeCycle.counts.response?.counts ?? [],
        events: data.admin.programmeCycle.events.response?.events ?? [],
      }
    },
    // Lifecycle transitions are version-guarded, so the version on screen must
    // be the current one or every action would be refused as stale.
    staleTime: 0,
  })

export const Route = createFileRoute('/_shell/admin/cycles/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(cycleQuery(params.id)),
  component: AdminCyclePage,
})

function AdminCyclePage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const { data } = useQuery(cycleQuery(id))
  const [reason, setReason] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const [guidance, setGuidance] = useState<string | null>(null)

  const head = data?.cycle.head

  const refresh = async () => {
    setReason('')
    await queryClient.invalidateQueries({ queryKey: ['admin-cycle', id] })
    await queryClient.invalidateQueries({ queryKey: ['admin-cycles'] })
    // The applicant-facing cycle lists change the moment a cycle opens or
    // closes, so they are refreshed here rather than left stale.
    await queryClient.invalidateQueries({ queryKey: ['cycles'] })
  }

  /**
   * Every lifecycle transition takes the same shape: the expected version and a
   * retained reason. One mutation covers them so a new transition cannot
   * accidentally skip either.
   */
  const transition = useMutation({
    mutationFn: async (action: 'open' | 'close' | 'archive') => {
      const input = { id, expectedVersion: head?.currentVersion ?? 0, reason }
      if (action === 'open') {
        const result = await gql(OpenCycleDocument, { input })
        return unwrap(result.admin.programmeCycle.open)
      }
      if (action === 'close') {
        const result = await gql(CloseCycleDocument, { input })
        return unwrap(result.admin.programmeCycle.close)
      }
      const result = await gql(ArchiveCycleDocument, { input })
      return unwrap(result.admin.programmeCycle.archive)
    },
    onSuccess: refresh,
  })

  const changeClosing = useMutation({
    mutationFn: async () => {
      const result = await gql(ChangeCycleClosingDocument, {
        input: {
          id,
          expectedVersion: head?.currentVersion ?? 0,
          closesAt: new Date(closesAt).toISOString(),
          reason,
        },
      })
      return unwrap(result.admin.programmeCycle.changeClosingTime)
    },
    onSuccess: async () => {
      setClosesAt('')
      await refresh()
    },
  })

  const changeGuidance = useMutation({
    mutationFn: async () => {
      const result = await gql(UpdateCycleGuidanceDocument, {
        input: {
          id,
          expectedVersion: head?.currentVersion ?? 0,
          applicantGuidance: guidance ?? '',
          partnerBankGuidance: head?.partnerBankGuidance ?? '',
          reason,
        },
      })
      return unwrap(result.admin.programmeCycle.updateOpenGuidance)
    },
    onSuccess: async () => {
      setGuidance(null)
      await refresh()
    },
  })

  if (!data || !head) return null

  const busy = transition.isPending || changeClosing.isPending || changeGuidance.isPending
  const error = transition.error ?? changeClosing.error ?? changeGuidance.error
  // Every transition needs a retained reason, so the buttons stay disabled
  // until one is written rather than failing after the click.
  const canAct = reason.trim().length > 0 && !busy

  return (
    <main className="page">
      <PageHeader
        title={head.displayName}
        description={`${head.cycleCode} · programme year ${head.cycleYear}`}
        actions={
          <span
            className="badge"
            data-tone={
              head.status === 'OPEN'
                ? 'ok'
                : head.status === 'DRAFT'
                  ? 'action'
                  : undefined
            }
          >
            {humanize(head.status)}
          </span>
        }
      />

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginBottom: '1rem' }}
        >
          {messageFor(error)}
        </p>
      ) : null}

      <div className="stack">
        <div className="card">
          <div className="card-header">
            <p className="eyebrow">Lifecycle</p>
          </div>
          <div className="card-body stack">
            <div>
              <label className="field-label" htmlFor="reason">
                Reason for this change
              </label>
              <input
                id="reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Retained in the cycle's history"
              />
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              {/*
                Only the transitions the current state actually permits are
                offered. A draft opens; an open cycle closes; a closed cycle is
                archived.
              */}
              {head.status === 'DRAFT' ? (
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  disabled={!canAct}
                  onClick={() => transition.mutate('open')}
                >
                  Open for applications
                </button>
              ) : null}
              {head.status === 'OPEN' ? (
                <button
                  type="button"
                  className="button"
                  disabled={!canAct}
                  onClick={() => transition.mutate('close')}
                >
                  Close to new applications
                </button>
              ) : null}
              {head.status === 'CLOSED' ? (
                <button
                  type="button"
                  className="button"
                  disabled={!canAct}
                  onClick={() => transition.mutate('archive')}
                >
                  Archive
                </button>
              ) : null}
              {head.status === 'ARCHIVED' ? (
                <p className="muted">
                  An archived cycle is final. Its applications keep their history.
                </p>
              ) : null}
            </div>

            {head.status === 'OPEN' ? (
              <>
                <hr style={{ border: 0, borderTop: '1px solid var(--hairline)' }} />
                <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div>
                    <label className="field-label" htmlFor="closesAt">
                      Move the closing time
                    </label>
                    <input
                      id="closesAt"
                      className="input"
                      type="datetime-local"
                      value={closesAt}
                      onChange={(event) => setClosesAt(event.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="button"
                    disabled={!canAct || !closesAt}
                    onClick={() => changeClosing.mutate()}
                  >
                    Change closing time
                  </button>
                </div>

                <div>
                  <label className="field-label" htmlFor="guidance">
                    Guidance shown to applicants
                  </label>
                  <textarea
                    id="guidance"
                    className="textarea"
                    value={guidance ?? head.applicantGuidance ?? ''}
                    onChange={(event) => setGuidance(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button"
                    style={{ marginTop: '0.5rem' }}
                    disabled={!canAct || guidance === null}
                    onClick={() => changeGuidance.mutate()}
                  >
                    Update guidance
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <p className="eyebrow">Policy frozen into this cycle</p>
          </div>
          <div className="card-body">
            <div className="detail-grid">
              <Detail label="Applications open">{formatDate(head.opensAt)}</Detail>
              <Detail label="Applications close">{formatDate(head.closesAt)}</Detail>
              <Detail label="Policy reference">{head.policyReference ?? '—'}</Detail>
              <Detail label="Version">
                <span className="tabular">{head.currentVersion}</span>
              </Detail>
              <Detail label="Required evidence">
                {data.cycle.documentRules.length === 0
                  ? 'None'
                  : data.cycle.documentRules
                      .map(
                        (rule) =>
                          `${humanize(rule.documentType)} (${humanize(rule.condition)})`,
                      )
                      .join(', ')}
              </Detail>
              <Detail label="Assessments an expansion must pass">
                {data.cycle.assessmentRules.length === 0
                  ? 'None'
                  : data.cycle.assessmentRules
                      .map((rule) => humanize(rule.assessmentType))
                      .join(', ')}
              </Detail>
              <Detail label="Approved reasons">
                <span className="tabular">{data.cycle.reasons.length}</span>
              </Detail>
            </div>
          </div>
        </div>

        {data.counts.length > 0 ? (
          <div className="card">
            <div className="card-header">
              <p className="eyebrow">Applications in this cycle</p>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col" className="numeric">
                      Applications
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.counts.map((count) => (
                    <tr key={count.status}>
                      <td>{humanize(count.status)}</td>
                      <td className="numeric">{count.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {data.events.length > 0 ? (
          <div className="card">
            <div className="card-header">
              <p className="eyebrow">History</p>
            </div>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {data.events.map((event) => (
                    <tr key={event.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(event.createdAt)}
                      </td>
                      <td>
                        <span style={{ fontWeight: 500 }}>
                          {humanize(event.eventType)}
                        </span>
                        {event.message ? (
                          <p className="muted" style={{ marginTop: '0.25rem' }}>
                            {event.message}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      <p style={{ marginTop: '1.5rem' }}>
        <Link to="/admin/cycles">Back to cycles</Link>
      </p>
    </main>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <span>{children}</span>
    </div>
  )
}
