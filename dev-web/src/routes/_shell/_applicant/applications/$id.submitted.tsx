/**
 * The submission acknowledgement.
 *
 * Submitting is the moment the whole application has been building towards, and
 * until now it ended with a redirect back to a screen that looked much like the
 * one before. This says what happened, gives the reference number the applicant
 * will quote for the next year, and shows exactly what was frozen — because a
 * submission is a copy taken at a moment, and "exactly what I sent" is the one
 * question an acknowledgement has to answer.
 *
 * It is printable. An applicant who may be doing this once in their life should
 * be able to keep a copy on paper, and the print rules hide the navigation and
 * the actions so the page prints as a document rather than a screenshot.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import {
  applicationQuery,
  draftChangesQuery,
} from '#/features/application/applicationQueries'
import { DOCUMENT_TITLES, formatBytes } from '#/features/application/documents'
import { SECTION_TITLES } from '#/features/application/draft'
import { formatDate, formatDateTime, formatMoney, humanize } from '#/lib/format'

export const Route = createFileRoute('/_shell/_applicant/applications/$id/submitted')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(draftChangesQuery(params.id)),
    ])
  },
  component: SubmittedPage,
})

function SubmittedPage() {
  const { id } = Route.useParams()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: changes } = useQuery(draftChangesQuery(id))

  if (!application) return null

  /*
   * The applicant API does not report a submission number of its own. What it
   * does report is the submission a draft is measured against, which — with
   * nothing changed since — is the submission just made. Anything else here
   * would be a number invented in the browser.
   */
  const submissionNumber = changes?.response?.comparedToSubmissionNumber ?? null
  const snapshot = application.snapshot
  const documents = application.documents.filter((document) => !document.deletedAt)

  return (
    <main className="page">
      <PageHeader
        title="Your application has been submitted"
        description="The programme office can now see it. Keep the reference number — you will be asked for it."
        actions={
          <>
            <button
              type="button"
              className="button"
              data-variant="primary"
              onClick={() => window.print()}
            >
              Print this
            </button>
            <Link to="/applications/$id" params={{ id }} className="button">
              Go to the application
            </Link>
          </>
        }
      />

      <div className="stack">
        <section className="card">
          <div className="card-body">
            <div className="detail-grid">
              <div>
                <span className="field-label">Reference number</span>
                <span className="tabular" style={{ fontSize: '1.25rem' }}>
                  {application.referenceNumber}
                </span>
              </div>
              <div>
                <span className="field-label">Submitted</span>
                <span>{formatDateTime(application.updatedAt)}</span>
              </div>
              {submissionNumber ? (
                <div>
                  <span className="field-label">Submission</span>
                  <span className="tabular">{submissionNumber}</span>
                </div>
              ) : null}
              <div>
                <span className="field-label">Status</span>
                <span>{humanize(application.status)}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">What was submitted</p>
            <span className="muted">A copy, frozen at the moment above</span>
          </div>
          <div className="card-body">
            <Group title={SECTION_TITLES.ENTERPRISE}>
              <Fact label="Business name" value={snapshot.enterprise.businessName} />
              <Fact
                label="Established"
                value={formatDate(snapshot.enterprise.establishmentDate)}
              />
              <Fact
                label="Registration"
                value={
                  snapshot.enterprise.registrationType
                    ? humanize(snapshot.enterprise.registrationType)
                    : null
                }
              />
              <Fact
                label="Registration number"
                value={snapshot.enterprise.registrationNumber}
              />
              <Fact label="GSTIN" value={snapshot.enterprise.gstin} />
              <Fact
                label="Sector"
                value={
                  snapshot.enterprise.businessSector
                    ? humanize(snapshot.enterprise.businessSector)
                    : null
                }
              />
              <Fact
                label="Category"
                value={
                  snapshot.enterprise.applicationCategory
                    ? humanize(snapshot.enterprise.applicationCategory)
                    : null
                }
              />
            </Group>

            <Group title={SECTION_TITLES.APPLICANT_PROFILE}>
              <Fact label="Name" value={snapshot.applicantProfile.primaryApplicantName} />
              <Fact
                label="Role"
                value={
                  snapshot.applicantProfile.designation
                    ? humanize(snapshot.applicantProfile.designation)
                    : null
                }
              />
              <Fact
                label="Date of birth"
                value={formatDate(snapshot.applicantProfile.dateOfBirth)}
              />
              <Fact
                label="Block or village"
                value={snapshot.applicantProfile.businessBlockOrVillage}
              />
              <Fact label="District" value={snapshot.applicantProfile.businessDistrict} />
              <Fact label="PIN code" value={snapshot.applicantProfile.businessPinCode} />
              <Fact
                label="Contact number"
                value={snapshot.applicantProfile.contactNumber}
              />
              <Fact
                label="Contact email"
                value={snapshot.applicantProfile.contactEmail}
              />
            </Group>

            <Group title={SECTION_TITLES.FINANCIAL}>
              <Fact
                label="Total project cost"
                value={formatMoney(snapshot.financial.totalProjectCostPaise)}
              />
              <Fact
                label="Seed fund requested"
                value={formatMoney(snapshot.financial.seedFundRequestedPaise)}
              />
              <Fact
                label="Bank loan proposed"
                value={formatMoney(snapshot.financial.bankLoanProposedPaise)}
              />
              <Fact
                label="Your own contribution"
                value={formatMoney(snapshot.financial.promoterContributionPaise)}
              />
            </Group>

            <Group title={SECTION_TITLES.PRIOR_FUNDING}>
              <Fact
                label="Government funding before"
                value={snapshot.priorFunding.receivedGovernmentFunding ? 'Yes' : 'No'}
              />
              {snapshot.priorFunding.receivedGovernmentFunding ? (
                <>
                  <Fact
                    label="Scheme"
                    value={snapshot.priorFunding.governmentSchemeName}
                  />
                  <Fact
                    label="Amount"
                    value={formatMoney(
                      snapshot.priorFunding.governmentFundingAmountPaise,
                    )}
                  />
                </>
              ) : null}
              <Fact
                label="Existing bank credit"
                value={snapshot.priorFunding.hasExistingBankCredit ? 'Yes' : 'No'}
              />
              {snapshot.priorFunding.hasExistingBankCredit ? (
                <>
                  <Fact label="Bank" value={snapshot.priorFunding.existingBankName} />
                  <Fact
                    label="Amount"
                    value={formatMoney(snapshot.priorFunding.existingCreditAmountPaise)}
                  />
                </>
              ) : null}
            </Group>

            <Group title={SECTION_TITLES.DECLARATION}>
              <Fact
                label="Relationship"
                value={
                  snapshot.declaration.relationshipType
                    ? humanize(snapshot.declaration.relationshipType)
                    : null
                }
              />
              <Fact label="Of" value={snapshot.declaration.relatedPersonName} />
              <Fact label="Place" value={snapshot.declaration.declarationPlace} />
              <Fact
                label="Declared"
                value={formatDateTime(snapshot.declarationAcceptedAt)}
              />
            </Group>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Documents attached</p>
            <span className="muted">
              {documents.length} {documents.length === 1 ? 'document' : 'documents'}
            </span>
          </div>
          {documents.length === 0 ? (
            <div className="card-body">
              <p className="muted">No documents were attached.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">
                  Documents attached to this submission
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Document</th>
                    <th scope="col">File</th>
                    <th scope="col">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((document) => (
                    <tr key={document.id}>
                      <td>{DOCUMENT_TITLES[document.documentType]}</td>
                      <td className="tabular">{document.originalFilename}</td>
                      <td className="tabular">{formatBytes(document.sizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="notice">
          <span className="notice-title">What happens next</span>
          The programme office checks your application. If anything needs correcting you
          will be told exactly which sections to change, and only those will open again.
        </p>
      </div>
    </main>
  )
}

/** One band of the frozen copy. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>
        {title}
      </p>
      <div className="detail-grid">{children}</div>
    </div>
  )
}

/**
 * One answer.
 *
 * An unanswered optional question prints as an em dash rather than being
 * omitted, so the acknowledgement shows what was asked as well as what was
 * given.
 */
function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <span>{value === null || value === undefined || value === '' ? '—' : value}</span>
    </div>
  )
}
