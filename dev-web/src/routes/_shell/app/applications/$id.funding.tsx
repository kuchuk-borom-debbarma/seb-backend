/**
 * What an applicant can see about their own award.
 *
 * The programme pays a sanctioned amount out in instalments, some of which may
 * later be corrected, and assesses how the money was used. This screen answers
 * the three questions an applicant actually has: how much was sanctioned, how
 * much has reached them, and what is still to come.
 *
 * Every figure here is the server's arithmetic, not the client's. The API folds
 * corrections into the release they correct and computes the net itself, so a
 * screen that added its own subtotals could disagree with the sanction letter.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { applicationQuery, fundingQuery } from '#/features/application/applicationQueries'
import { formatDate, formatDateTime, formatMoney, humanize } from '#/lib/format'

export const Route = createFileRoute('/_shell/app/applications/$id/funding')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(fundingQuery(params.id)),
    ])
  },
  component: FundingPage,
})

function FundingPage() {
  const { id } = Route.useParams()
  const { data: funding } = useQuery(fundingQuery(id))

  /*
   * No award yet is an ordinary state, not an error: most applications spend
   * most of their life without one. The API refuses with its own message, and
   * that message is the honest thing to show.
   */
  if (!funding?.response) {
    return (
      <main className="page">
        <PageHeader title="Funding" />
        <p className="notice">
          <span className="notice-title">Nothing has been sanctioned yet</span>
          {funding?.message ??
            'Once the committee approves this application and a sanction order is issued, the amount and every payment against it appear here.'}
        </p>
        <div className="row" style={{ marginTop: '1.5rem' }}>
          <Link to="/app/applications/$id" params={{ id }} className="button">
            Back to the application
          </Link>
        </div>
      </main>
    )
  }

  const { award, releases, assessments } = funding.response

  return (
    <main className="page">
      <PageHeader
        title="Funding"
        description={`Sanction order ${award.sanctionOrderNumber}, issued ${formatDate(award.sanctionDate)}`}
      />

      <div className="stack">
        <section className="card">
          <div className="card-header">
            <p className="eyebrow">The award</p>
            <span
              className="badge"
              data-tone={award.status === 'ACTIVE' ? 'ok' : undefined}
            >
              {humanize(award.status)}
            </span>
          </div>
          <div className="card-body">
            <div className="detail-grid">
              <Amount label="Sanctioned" value={award.sanctionedAmountPaise} />
              <Amount label="Paid to you" value={award.netReleasedPaise} />
              <Amount label="Still to come" value={award.remainingPlannedPaise} />
              {/* Shown only when there is something to explain. A zero here on
                  every award would train people to ignore the row. */}
              {award.reversedPaise !== '0' ? (
                <Amount label="Taken back by correction" value={award.reversedPaise} />
              ) : null}
              {award.closureDisposition ? (
                <div>
                  <span className="field-label">How it closed</span>
                  <span>{humanize(award.closureDisposition)}</span>
                </div>
              ) : null}
            </div>

            {award.applicantConditions ? (
              <p className="notice" data-tone="warn" style={{ marginTop: '1rem' }}>
                <span className="notice-title">Conditions of this award</span>
                {award.applicantConditions}
              </p>
            ) : null}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Payments</p>
          </div>
          {releases.length === 0 ? (
            <div className="card-body">
              <p className="muted">
                No payment has been made yet. Each instalment appears here once the
                programme office releases it.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Payments against this award</caption>
                <thead>
                  <tr>
                    <th scope="col">No.</th>
                    <th scope="col">Released</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Payment reference</th>
                  </tr>
                </thead>
                <tbody>
                  {releases.map((release) => (
                    <tr key={release.sequenceNumber}>
                      <td className="tabular">{release.sequenceNumber}</td>
                      <td>{formatDateTime(release.occurredAt)}</td>
                      <td className="tabular">
                        {formatMoney(release.amountPaise)}
                        {/* A correction belongs to the payment it corrects, so
                            it is stated here rather than as a separate row that
                            would look like a second payment. */}
                        {release.reversedAmountPaise !== '0' ? (
                          <span className="field-hint">
                            {formatMoney(release.reversedAmountPaise)} taken back
                          </span>
                        ) : null}
                      </td>
                      <td className="tabular">{release.paymentReference ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {assessments.length > 0 ? (
          <section className="card">
            <div className="card-header">
              <p className="eyebrow">Assessments</p>
            </div>
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Assessments of this award</caption>
                <thead>
                  <tr>
                    <th scope="col">Assessment</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Assessed</th>
                    <th scope="col">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {assessments.map((assessment) => (
                    <tr
                      key={`${assessment.assessmentType}-${assessment.assessmentNumber}`}
                      /* A superseded assessment is kept but set back, because
                         the record of what was found first is part of the
                         story and hiding it would look like a correction that
                         never happened. */
                      className={assessment.latest ? undefined : 'muted'}
                    >
                      <td>
                        {humanize(assessment.assessmentType)}{' '}
                        {assessment.assessmentNumber}
                        {assessment.latest ? null : (
                          <span className="field-hint">Superseded</span>
                        )}
                      </td>
                      <td>{humanize(assessment.outcome)}</td>
                      <td>{formatDateTime(assessment.assessedAt)}</td>
                      <td>{assessment.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>

      <div className="row" style={{ marginTop: '1.5rem' }}>
        <Link to="/app/applications/$id" params={{ id }} className="button">
          Back to the application
        </Link>
      </div>
    </main>
  )
}

/** One money figure, set in tabular figures so a column of them lines up. */
function Amount({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <span className="tabular">{formatMoney(value)}</span>
    </div>
  )
}
