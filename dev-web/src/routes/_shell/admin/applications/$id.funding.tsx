/**
 * The money side of one application.
 *
 * A sanction order is issued against the committee's approval; payments are
 * released against the sanction order; a payment that went wrong is reversed
 * rather than deleted; assessments record what the money was used for; and if
 * money has to come back, a recovery case pursues it.
 *
 * The ledger is append-only and the API refuses any write built on a stale
 * ledger version, so every mutation here returns the whole workspace and it is
 * written straight into the cache — the figures on screen are always the ones
 * the last write agreed with.
 *
 * Amounts are typed in rupees and sent in paise. Nothing on this screen adds up
 * its own subtotals: the API computes them, and a second opinion in the browser
 * could only ever disagree with the sanction letter.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { AwardActions } from '#/features/admin/AwardActions'
import { RecoveryCase } from '#/features/admin/RecoveryCase'
import { fundingWorkspaceQuery, putFunding } from '#/features/admin/fundingQueries'
import { cycleReasonsQuery, workspaceQuery } from '#/features/admin/workspaceQueries'
import { CreateAwardDocument } from '#/graphql/generated/operations'
import { formatDate, formatDateTime, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP, OFFICE_LEDES } from '#/features/admin/officeGuidance'
import { useMarker } from '#/features/guide/GuideContext'

export const Route = createFileRoute('/_shell/admin/applications/$id/funding')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(workspaceQuery(params.id)),
  component: FundingPage,
})

function FundingPage() {
  const mark = useMarker()
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: workspace } = useQuery(workspaceQuery(id))
  const { data: funding } = useQuery(fundingWorkspaceQuery(id))
  const { data: reasons } = useQuery(cycleReasonsQuery(workspace?.cycleCode))

  const apply = (updated: NonNullable<typeof funding>['response']) => {
    if (updated) putFunding(queryClient, id, updated)
  }

  if (!workspace?.application) return null
  const application = workspace.application
  const award = funding?.response?.award

  return (
    <main className="page">
      <PageHeader
        title="Funding"
        meta={
          award
            ? `Sanction order ${award.sanctionOrderNumber}, issued ${formatDate(award.sanctionDate)}`
            : undefined
        }
        /* The unsanctioned case is already said, once, by the "Not yet" notice
           further down beside the control that would change it. */
        description={OFFICE_LEDES.funding}
        actions={
          <Link to="/admin/applications/$id" params={{ id }} className="button">
            Back to the application
          </Link>
        }
      />

      <div className="stack">
        {!award ? (
          <CreateAward
            applicationId={id}
            statusVersion={application.statusVersion}
            latestDecisionId={workspace.decisions.at(-1)?.id}
            status={application.status}
            onApplied={apply}
          />
        ) : (
          <>
            <section className="card">
              <div className="card-header">
                <div>
                  <p className="eyebrow">The award</p>
                  <h3 className="tabular">{award.sanctionOrderNumber}</h3>
                </div>
                <span
                  className="badge"
                  data-tone={award.status === 'ACTIVE' ? 'ok' : undefined}
                >
                  {humanize(award.status)}
                </span>
              </div>
              <div className="card-body">
                <div className="detail-grid">
                  <div>
                    <span className="field-label">Sanctioned</span>
                    <span className="tabular">
                      {formatMoney(award.sanctionedAmountPaise)}
                    </span>
                  </div>
                  <div>
                    <span className="field-label">Sanctioned on</span>
                    <span>{formatDate(award.sanctionDate)}</span>
                  </div>
                  {award.closureDisposition ? (
                    <div>
                      <span className="field-label">How it closed</span>
                      <span>{humanize(award.closureDisposition)}</span>
                    </div>
                  ) : null}
                </div>
                {award.applicantConditions ? (
                  <p className="notice" style={{ marginTop: '1rem' }}>
                    <span className="notice-title">Conditions</span>
                    {award.applicantConditions}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="card" {...mark('ledger')}>
              <div className="card-header">
                <div className="label-row">
                  <p className="eyebrow">Ledger</p>
                  <Explain label="the ledger" opener="How the money record works">
                    {OFFICE_HELP.ledger}
                  </Explain>
                </div>
                <span className="muted">
                  {funding?.response?.ledger.length ?? 0} entries
                </span>
              </div>
              {funding?.response?.ledger.length === 0 ? (
                <div className="card-body">
                  <p className="muted">
                    No money has moved yet. Every release, and every correction to one,
                    appears here in the order it happened.
                  </p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <caption className="visually-hidden">
                      Every entry against this award
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col" data-numeric>
                          No.
                        </th>
                        <th scope="col">Entry</th>
                        <th scope="col" data-numeric>
                          Amount
                        </th>
                        <th scope="col">When</th>
                        <th scope="col">External reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funding?.response?.ledger.map((entry) => (
                        <tr key={entry.id}>
                          <td data-numeric>{entry.sequenceNumber}</td>
                          <td>
                            {humanize(entry.entryType)}
                            {/* A reversal names the payment it corrects, so the
                                two are read together rather than as separate
                                movements. */}
                            {entry.relatedDisbursementId ? (
                              <span className="field-hint">
                                corrects an earlier release
                              </span>
                            ) : null}
                          </td>
                          <td data-numeric>{formatMoney(entry.amountPaise)}</td>
                          <td>{formatDateTime(entry.occurredAt)}</td>
                          <td className="tabular">{entry.externalReference ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <AwardActions
              applicationId={id}
              statusVersion={application.statusVersion}
              award={award}
              ledger={funding?.response?.ledger ?? []}
              obligations={funding?.response?.obligations ?? []}
              assessments={funding?.response?.assessments ?? []}
              reasons={reasons}
              onApplied={apply}
            />

            <RecoveryCase
              awardId={award.id}
              existing={funding?.response?.recovery ?? []}
              reasons={reasons}
              onOpened={() =>
                queryClient.invalidateQueries({ queryKey: ['funding', id] })
              }
            />
          </>
        )}
      </div>
    </main>
  )
}

/**
 * Issuing the sanction order.
 *
 * Only possible once the committee has approved, because the award is issued
 * against that decision and the API will not accept it without one.
 */
function CreateAward({
  applicationId,
  statusVersion,
  latestDecisionId,
  status,
  onApplied,
}: {
  applicationId: string
  statusVersion: number
  latestDecisionId: string | undefined
  status: string
  onApplied: (workspace: never) => void
}) {
  const [sanctionOrderNumber, setNumber] = useState('')
  const [sanctionDate, setDate] = useState('')
  const [applicantConditions, setConditions] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: async () => {
      const data = await gql(CreateAwardDocument, {
        input: {
          applicationId,
          decisionId: latestDecisionId as string,
          expectedStatusVersion: statusVersion,
          sanctionOrderNumber: sanctionOrderNumber.trim(),
          sanctionDate,
          applicantConditions: applicantConditions.trim() || null,
        },
      })
      return unwrap(data.admin.funding.createAward)
    },
    onMutate: () => setError(null),
    onSuccess: (workspace) => onApplied(workspace as never),
    onError: (cause) => setError(messageFor(cause)),
  })

  if (!latestDecisionId || status !== 'APPROVED') {
    return (
      <p className="notice">
        <span className="notice-title">Not yet</span>A sanction order is issued against
        the committee's approval. This application is {humanize(status).toLowerCase()}.
      </p>
    )
  }

  return (
    <section className="card">
      <div className="card-header">
        <p className="eyebrow">Issue the sanction order</p>
      </div>
      <div className="card-body">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <div className="detail-grid">
            <div>
              <label className="field-label" htmlFor="sanction-number">
                Sanction order number
              </label>
              <input
                id="sanction-number"
                className="input tabular"
                value={sanctionOrderNumber}
                onChange={(event) => setNumber(event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="sanction-date">
                Issued on
              </label>
              <input
                id="sanction-date"
                className="input"
                type="date"
                value={sanctionDate}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="field-label" htmlFor="sanction-conditions">
                Conditions
              </label>
              <textarea
                id="sanction-conditions"
                className="textarea"
                rows={2}
                value={applicantConditions}
                onChange={(event) => setConditions(event.target.value)}
              />
              <span className="field-hint">
                Shown to the applicant on their funding screen. The amount comes from the
                committee's decision.
              </span>
            </div>
          </div>

          {error ? (
            <p
              className="notice"
              data-tone="error"
              role="alert"
              style={{ marginTop: '0.75rem' }}
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="button"
            data-variant="primary"
            style={{ marginTop: '0.75rem' }}
            disabled={!sanctionOrderNumber.trim() || !sanctionDate || create.isPending}
          >
            {create.isPending ? 'Issuing…' : 'Issue the sanction order'}
          </button>
        </form>
      </div>
    </section>
  )
}
