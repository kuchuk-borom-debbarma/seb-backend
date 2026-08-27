import { Link } from '@tanstack/react-router'
import type { ApplicationByIdQuery } from '#/graphql/generated/operations'
import type { ApplicationSection } from '#/graphql/generated/schema'
import { formatDate, formatMoney, humanize } from '#/lib/format'
import { DOCUMENT_TITLES, formatBytes } from './documents'
import { FIELD_LABELS, SECTION_TITLES } from './draft'

type Application = NonNullable<
  ApplicationByIdQuery['seb']['application']['byId']['response']
>

export function ApplicationSummary({
  application,
  showEditLinks = false,
}: {
  application: Application
  showEditLinks?: boolean
}) {
  const snapshot = application.snapshot
  const documents = application.documents.filter((document) => !document.deletedAt)
  const canEdit = (section: ApplicationSection) =>
    showEditLinks && application.editableSections.includes(section)

  return (
    <div className="stack" aria-label="Application answers and documents">
      <SummarySection
        title={SECTION_TITLES.ENTERPRISE}
        edit={
          canEdit('ENTERPRISE') ? { id: application.id, section: 'ENTERPRISE' } : null
        }
      >
        <Fact
          label={FIELD_LABELS.businessName}
          value={snapshot.enterprise.businessName}
        />
        <Fact
          label={FIELD_LABELS.establishmentDate}
          value={formatDate(snapshot.enterprise.establishmentDate)}
        />
        <Fact
          label={FIELD_LABELS.registrationType}
          value={displayEnum(snapshot.enterprise.registrationType)}
        />
        <Fact
          label={FIELD_LABELS.registrationNumber}
          value={snapshot.enterprise.registrationNumber}
        />
        <Fact label={FIELD_LABELS.gstin} value={snapshot.enterprise.gstin} />
        <Fact
          label={FIELD_LABELS.businessSector}
          value={displayEnum(snapshot.enterprise.businessSector)}
        />
        <Fact
          label={FIELD_LABELS.otherBusinessSector}
          value={snapshot.enterprise.otherBusinessSector}
        />
        <Fact
          label={FIELD_LABELS.applicationCategory}
          value={displayEnum(snapshot.enterprise.applicationCategory)}
        />
        <Fact
          label={FIELD_LABELS.majorityOwnershipConfirmed}
          value={yesNo(snapshot.enterprise.majorityOwnershipConfirmed)}
        />
      </SummarySection>

      <SummarySection
        title={SECTION_TITLES.APPLICANT_PROFILE}
        edit={
          canEdit('APPLICANT_PROFILE')
            ? { id: application.id, section: 'APPLICANT_PROFILE' }
            : null
        }
      >
        <Fact
          label={FIELD_LABELS.primaryApplicantName}
          value={snapshot.applicantProfile.primaryApplicantName}
        />
        <Fact
          label={FIELD_LABELS.designation}
          value={displayEnum(snapshot.applicantProfile.designation)}
        />
        <Fact
          label={FIELD_LABELS.dateOfBirth}
          value={formatDate(snapshot.applicantProfile.dateOfBirth)}
        />
        <Fact
          label={FIELD_LABELS.gender}
          value={displayEnum(snapshot.applicantProfile.gender)}
        />
        <Fact
          label={FIELD_LABELS.businessBlockOrVillage}
          value={snapshot.applicantProfile.businessBlockOrVillage}
        />
        <Fact
          label={FIELD_LABELS.businessDistrict}
          value={snapshot.applicantProfile.businessDistrict}
        />
        <Fact
          label={FIELD_LABELS.businessPinCode}
          value={snapshot.applicantProfile.businessPinCode}
        />
        <Fact
          label={FIELD_LABELS.contactNumber}
          value={snapshot.applicantProfile.contactNumber}
        />
        <Fact
          label={FIELD_LABELS.contactEmail}
          value={snapshot.applicantProfile.contactEmail}
        />
      </SummarySection>

      <SummarySection
        title={SECTION_TITLES.FINANCIAL}
        edit={canEdit('FINANCIAL') ? { id: application.id, section: 'FINANCIAL' } : null}
      >
        <Fact
          label={FIELD_LABELS.totalProjectCostPaise}
          value={formatMoney(snapshot.financial.totalProjectCostPaise)}
        />
        <Fact
          label={FIELD_LABELS.seedFundRequestedPaise}
          value={formatMoney(snapshot.financial.seedFundRequestedPaise)}
        />
        <Fact
          label={FIELD_LABELS.bankLoanProposedPaise}
          value={formatMoney(snapshot.financial.bankLoanProposedPaise)}
        />
        <Fact
          label={FIELD_LABELS.promoterContributionPaise}
          value={formatMoney(snapshot.financial.promoterContributionPaise)}
        />
      </SummarySection>

      <SummarySection
        title={SECTION_TITLES.PRIOR_FUNDING}
        edit={
          canEdit('PRIOR_FUNDING')
            ? { id: application.id, section: 'PRIOR_FUNDING' }
            : null
        }
      >
        <Fact
          label={FIELD_LABELS.receivedGovernmentFunding}
          value={yesNo(snapshot.priorFunding.receivedGovernmentFunding)}
        />
        <Fact
          label={FIELD_LABELS.governmentSchemeName}
          value={snapshot.priorFunding.governmentSchemeName}
        />
        <Fact
          label={FIELD_LABELS.governmentFundingAmountPaise}
          value={formatMoney(snapshot.priorFunding.governmentFundingAmountPaise)}
        />
        <Fact
          label={FIELD_LABELS.governmentFundingSanctionYear}
          value={snapshot.priorFunding.governmentFundingSanctionYear?.toString()}
        />
        <Fact
          label={FIELD_LABELS.hasExistingBankCredit}
          value={yesNo(snapshot.priorFunding.hasExistingBankCredit)}
        />
        <Fact
          label={FIELD_LABELS.existingBankName}
          value={snapshot.priorFunding.existingBankName}
        />
        <Fact
          label={FIELD_LABELS.existingCreditAmountPaise}
          value={formatMoney(snapshot.priorFunding.existingCreditAmountPaise)}
        />
        <Fact
          label={FIELD_LABELS.existingCreditStatus}
          value={displayEnum(snapshot.priorFunding.existingCreditStatus)}
        />
      </SummarySection>

      <SummarySection
        title={SECTION_TITLES.DOCUMENTS}
        edit={canEdit('DOCUMENTS') ? { id: application.id, section: 'DOCUMENTS' } : null}
      >
        <Fact
          label={FIELD_LABELS.nocRequired}
          value={yesNo(snapshot.documents.nocRequired)}
        />
      </SummarySection>

      {application.applicationType === 'EXPANSION' ? (
        <SummarySection title={SECTION_TITLES.EXPANSION} edit={null}>
          <Fact
            label="Prior sanction order number"
            value={snapshot.priorSanctionOrderNumber}
          />
          <Fact
            label="Prior sanction date"
            value={formatDate(snapshot.priorSanctionDate)}
          />
          <Fact
            label="Prior net amount disbursed"
            value={formatMoney(snapshot.priorNetDisbursedAmountPaise)}
          />
          <Fact
            label="Continuous operation"
            value={
              snapshot.continuousOperationMonths === null
                ? null
                : `${snapshot.continuousOperationMonths} months`
            }
          />
        </SummarySection>
      ) : null}

      <section className="card">
        <div className="card-header">
          <div>
            <p className="eyebrow">Attach evidence</p>
            <h2>Documents</h2>
          </div>
          {canEdit('DOCUMENTS') ? (
            <Link to="/applications/$id/documents" params={{ id: application.id }}>
              Edit
            </Link>
          ) : null}
        </div>
        {documents.length === 0 ? (
          <div className="card-body">
            <p className="muted">No documents attached.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Attached documents</caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">File</th>
                  <th scope="col">Type</th>
                  <th scope="col">Size</th>
                  <th scope="col">Version</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>{DOCUMENT_TITLES[document.documentType]}</td>
                    <td className="tabular">{document.originalFilename}</td>
                    <td>{document.contentType}</td>
                    <td className="tabular">{formatBytes(document.sizeBytes)}</td>
                    <td className="tabular">{document.currentVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function SummarySection({
  title,
  edit,
  children,
}: {
  title: string
  edit: { id: string; section: ApplicationSection } | null
  children: React.ReactNode
}) {
  return (
    <section className="card">
      <div className="card-header">
        <h2>{title}</h2>
        {edit ? (
          <Link
            to="/applications/$id/form"
            params={{ id: edit.id }}
            search={{ section: edit.section }}
          >
            Edit
          </Link>
        ) : null}
      </div>
      <div className="card-body">
        <div className="detail-grid">{children}</div>
      </div>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <span>{value === null || value === undefined || value === '' ? '—' : value}</span>
    </div>
  )
}

const displayEnum = (value: string | null | undefined) =>
  value === null || value === undefined ? null : humanize(value)

const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? null : value ? 'Yes' : 'No'
