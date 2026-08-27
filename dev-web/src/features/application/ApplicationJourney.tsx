/**
 * Category order and navigation shared by the application form, evidence, and
 * review routes.
 *
 * The validation report remains the authority for progression. This module
 * only assigns each reported issue to the screen where it can be fixed, which
 * is also what keeps a review deep link and the progress rail in agreement.
 */
import { useRouter } from '@tanstack/react-router'
import { FormJourney, type JourneyStep } from '#/features/forms/FormJourney'
import type { ApplicationSection } from '#/graphql/generated/schema'
import { isDocumentIssue } from './documents'
import { FORM_SECTIONS, SECTION_TITLES } from './draft'

export type ApplicationJourneyStep = ApplicationSection | 'ATTACH_EVIDENCE' | 'REVIEW'

type Issue = { section: string; field: string }

const DESCRIPTIONS: Record<ApplicationJourneyStep, string> = {
  ENTERPRISE:
    'Confirm the enterprise profile copied into this application and choose its programme category.',
  APPLICANT_PROFILE:
    'Tell the programme office who is responsible for this application and how to reach them.',
  FINANCIAL: 'Record the project cost and each proposed source of finance in rupees.',
  PRIOR_FUNDING:
    'Describe earlier government support and any existing bank credit for the enterprise.',
  DOCUMENTS:
    'Answer the question that decides whether a no-objection certificate applies.',
  EXPANSION:
    'Review the earlier award facts supplied by programme records for this expansion.',
  ATTACH_EVIDENCE:
    'Attach each PDF, JPEG, or PNG required by this cycle and by the answers in the form.',
  REVIEW: 'Check every answer and document before creating the formal submission.',
}

export const APPLICATION_JOURNEY_STEPS: ApplicationJourneyStep[] = [
  ...FORM_SECTIONS,
  'ATTACH_EVIDENCE',
  'REVIEW',
]

const LABELS: Record<ApplicationJourneyStep, string> = {
  ...SECTION_TITLES,
  ENTERPRISE: 'Enterprise details',
  APPLICANT_PROFILE: 'Owners',
  DOCUMENTS: 'Evidence requirements',
  ATTACH_EVIDENCE: 'Attach evidence',
  REVIEW: 'Review',
}

export function ApplicationJourney({
  applicationId,
  activeStep,
  issues,
  editableSections,
  children,
  footer,
  footerStatus,
  footerLeft,
  footerRight,
}: {
  applicationId: string
  activeStep: ApplicationJourneyStep
  issues: Issue[]
  editableSections: ApplicationSection[]
  children: React.ReactNode
  footer?: React.ReactNode
  footerStatus?: React.ReactNode
  footerLeft?: React.ReactNode
  footerRight?: React.ReactNode
}) {
  const router = useRouter()
  const readOnly = editableSections.length === 0
  const steps = applicationSteps({
    activeStep,
    issues,
    editableSections,
    readOnly,
  })

  return (
    <FormJourney
      steps={steps}
      activeStepId={activeStep}
      onStepSelect={(step) => {
        if (FORM_SECTIONS.includes(step as ApplicationSection)) {
          void router.navigate({
            to: '/applications/$id/form',
            params: { id: applicationId },
            search: { section: step as ApplicationSection },
          })
        } else if (step === 'ATTACH_EVIDENCE') {
          void router.navigate({
            to: '/applications/$id/documents',
            params: { id: applicationId },
          })
        } else {
          void router.navigate({
            to: '/applications/$id/review',
            params: { id: applicationId },
          })
        }
      }}
      footerLeft={footerLeft}
      footerRight={footerRight}
      footer={footer}
      footerStatus={footerStatus}
    >
      {children}
    </FormJourney>
  )
}

export function issueCountForStep(issues: Issue[], step: ApplicationJourneyStep): number {
  if (step === 'ATTACH_EVIDENCE') {
    return issues.filter((issue) => isDocumentIssue(issue.field)).length
  }
  if (step === 'REVIEW' || step === 'EXPANSION') return 0
  if (step === 'DOCUMENTS') {
    return issues.filter(
      (issue) => issue.section === 'DOCUMENTS' && !isDocumentIssue(issue.field),
    ).length
  }
  return issues.filter((issue) => issue.section === step).length
}

export function issuesForStep(issues: Issue[], step: ApplicationJourneyStep): Issue[] {
  if (step === 'ATTACH_EVIDENCE') {
    return issues.filter((issue) => isDocumentIssue(issue.field))
  }
  if (step === 'REVIEW' || step === 'EXPANSION') return []
  if (step === 'DOCUMENTS') {
    return issues.filter(
      (issue) => issue.section === 'DOCUMENTS' && !isDocumentIssue(issue.field),
    )
  }
  return issues.filter((issue) => issue.section === step)
}

export function firstIncompleteStep(issues: Issue[]): ApplicationJourneyStep {
  return (
    APPLICATION_JOURNEY_STEPS.find(
      (step) => step !== 'REVIEW' && issueCountForStep(issues, step) > 0,
    ) ?? 'REVIEW'
  )
}

export function sectionForField(field: string): ApplicationSection | null {
  for (const [section, fields] of Object.entries(FIELDS_BY_SECTION)) {
    if (fields.includes(field)) return section as ApplicationSection
  }
  return null
}

function applicationSteps({
  activeStep,
  issues,
  editableSections,
  readOnly,
}: {
  activeStep: ApplicationJourneyStep
  issues: Issue[]
  editableSections: ApplicationSection[]
  readOnly: boolean
}): Array<JourneyStep<ApplicationJourneyStep>> {
  const firstIncomplete = APPLICATION_JOURNEY_STEPS.findIndex(
    (step) => step !== 'REVIEW' && issueCountForStep(issues, step) > 0,
  )

  return APPLICATION_JOURNEY_STEPS.map((step, index) => {
    const issueCount = issueCountForStep(issues, step)
    const formSection = FORM_SECTIONS.includes(step as ApplicationSection)
      ? (step as ApplicationSection)
      : null
    const locked = formSection !== null && !editableSections.includes(formSection)

    let status: JourneyStep<ApplicationJourneyStep>['status']
    if (locked) status = 'locked'
    else if (readOnly) status = 'available'
    else if (firstIncomplete === -1) {
      status = step === 'REVIEW' ? 'available' : 'complete'
    } else if (index < firstIncomplete) status = 'complete'
    else if (index === firstIncomplete) status = issueCount ? 'error' : 'available'
    else status = 'blocked'

    // A validation deep link may deliberately open a later category. It must
    // remain the current, usable step even when normal forward navigation would
    // still be blocked by an earlier answer.
    if (step === activeStep && status === 'blocked') {
      status = issueCount ? 'error' : 'available'
    }

    return {
      id: step,
      label: LABELS[step],
      description: DESCRIPTIONS[step],
      status,
      issueCount: issueCount || undefined,
    }
  })
}

const FIELDS_BY_SECTION: Record<ApplicationSection, string[]> = {
  ENTERPRISE: [
    'businessName',
    'establishmentDate',
    'registrationType',
    'registrationNumber',
    'gstin',
    'businessSector',
    'otherBusinessSector',
    'applicationCategory',
    'majorityOwnershipConfirmed',
  ],
  APPLICANT_PROFILE: [
    'primaryApplicantName',
    'designation',
    'dateOfBirth',
    'gender',
    'businessBlockOrVillage',
    'businessDistrict',
    'businessPinCode',
    'contactNumber',
    'contactEmail',
  ],
  FINANCIAL: [
    'totalProjectCostPaise',
    'seedFundRequestedPaise',
    'bankLoanProposedPaise',
    'promoterContributionPaise',
  ],
  PRIOR_FUNDING: [
    'receivedGovernmentFunding',
    'governmentSchemeName',
    'governmentFundingAmountPaise',
    'governmentFundingSanctionYear',
    'hasExistingBankCredit',
    'existingBankName',
    'existingCreditAmountPaise',
    'existingCreditStatus',
  ],
  DOCUMENTS: ['nocRequired'],
  EXPANSION: [],
}
