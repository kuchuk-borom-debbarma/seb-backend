/**
 * Step order and navigation shared by the application form, evidence, and
 * review routes.
 *
 * The steps are the pinned template's stages, in the template's own order,
 * followed by the evidence and review screens — nothing about the journey is
 * written into code, because which stages exist is the cycle's decision.
 *
 * The validation report remains the authority for progression. This module
 * only assigns each reported issue to the screen where it can be fixed, which
 * is also what keeps a review deep link and the progress rail in agreement.
 */
import { useRouter } from '@tanstack/react-router'
import { FormJourney, type JourneyStep } from '#/features/forms/FormJourney'
import { humanize } from '#/lib/format'
import type { ResolvedTemplate } from './formTemplate'

/** A stage key from the template, or one of the two fixed screens after it. */
export type ApplicationJourneyStep = string

export const ATTACH_EVIDENCE = 'ATTACH_EVIDENCE'
export const REVIEW = 'REVIEW'

type Issue = { stageKey: string; field: string }

/**
 * The question a reported issue path names.
 *
 * An issue about a member of a repeated group arrives as `GROUP[0].MEMBER`,
 * and one about the entry itself as `GROUP[0]` — both resolve to a key the
 * template knows.
 */
const baseFieldKey = (path: string): string => {
  const member = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path
  return member.replace(/\[\d+\]$/, '')
}

/**
 * Whether an issue is fixed on the evidence screen.
 *
 * Decided by the *kind of question*, not by the stage it sits in: a stage can
 * carry both a missing file and an ordinary question that decides whether the
 * file is wanted at all, and only the first belongs on the evidence screen.
 */
export const isDocumentIssue = (template: ResolvedTemplate, field: string): boolean =>
  template.byKey.get(baseFieldKey(field))?.type === 'FILE'

/** Which form stage a reported field belongs to. Null for a key the template does not know. */
export const stageForField = (template: ResolvedTemplate, field: string): string | null =>
  template.byKey.get(baseFieldKey(field))?.stageKey ?? null

export const journeySteps = (template: ResolvedTemplate): ApplicationJourneyStep[] => [
  ...template.stages.map((stage) => stage.key),
  ATTACH_EVIDENCE,
  REVIEW,
]

export function issuesForStep(
  template: ResolvedTemplate,
  issues: readonly Issue[],
  step: ApplicationJourneyStep,
): Issue[] {
  if (step === ATTACH_EVIDENCE) {
    return issues.filter((issue) => isDocumentIssue(template, issue.field))
  }
  if (step === REVIEW) return []
  return issues.filter(
    (issue) => issue.stageKey === step && !isDocumentIssue(template, issue.field),
  )
}

export function issueCountForStep(
  template: ResolvedTemplate,
  issues: readonly Issue[],
  step: ApplicationJourneyStep,
): number {
  return issuesForStep(template, issues, step).length
}

export function firstIncompleteStep(
  template: ResolvedTemplate,
  issues: readonly Issue[],
): ApplicationJourneyStep {
  return (
    journeySteps(template).find(
      (step) => step !== REVIEW && issueCountForStep(template, issues, step) > 0,
    ) ?? REVIEW
  )
}

export function ApplicationJourney({
  applicationId,
  template,
  activeStep,
  issues,
  editableStageKeys,
  children,
  footer,
  footerStatus,
  footerLeft,
  footerRight,
}: {
  applicationId: string
  template: ResolvedTemplate
  activeStep: ApplicationJourneyStep
  issues: readonly Issue[]
  editableStageKeys: readonly string[]
  children: React.ReactNode
  footer?: React.ReactNode
  footerStatus?: React.ReactNode
  footerLeft?: React.ReactNode
  footerRight?: React.ReactNode
}) {
  const router = useRouter()
  const readOnly = editableStageKeys.length === 0
  const steps = applicationSteps({
    template,
    activeStep,
    issues,
    editableStageKeys,
    readOnly,
  })

  return (
    <FormJourney
      steps={steps}
      activeStepId={activeStep}
      onStepSelect={(step) => {
        if (step === ATTACH_EVIDENCE) {
          void router.navigate({
            to: '/applications/$id/documents',
            params: { id: applicationId },
          })
        } else if (step === REVIEW) {
          void router.navigate({
            to: '/applications/$id/review',
            params: { id: applicationId },
          })
        } else {
          void router.navigate({
            to: '/applications/$id/form',
            params: { id: applicationId },
            search: { stage: step },
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

function applicationSteps({
  template,
  activeStep,
  issues,
  editableStageKeys,
  readOnly,
}: {
  template: ResolvedTemplate
  activeStep: ApplicationJourneyStep
  issues: readonly Issue[]
  editableStageKeys: readonly string[]
  readOnly: boolean
}): Array<JourneyStep<ApplicationJourneyStep>> {
  const order = journeySteps(template)
  const editable = new Set(editableStageKeys)
  const firstIncomplete = order.findIndex(
    (step) => step !== REVIEW && issueCountForStep(template, issues, step) > 0,
  )

  return order.map((step, index) => {
    const issueCount = issueCountForStep(template, issues, step)
    const stage = template.stages.find((each) => each.key === step)
    const locked = stage !== undefined && !editable.has(stage.key)

    let status: JourneyStep<ApplicationJourneyStep>['status']
    if (locked) status = 'locked'
    else if (readOnly) status = 'available'
    else if (firstIncomplete === -1) {
      status = step === REVIEW ? 'available' : 'complete'
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
      label: stepLabel(step, stage?.title),
      description: withMinutes(
        stepDescription(step, stage?.title, stage?.description),
        stage?.estimatedMinutes,
      ),
      status,
      issueCount: issueCount || undefined,
    }
  })
}

/* The cycle's own time expectation, where its author gave one. */
function withMinutes(description: string, minutes?: number | null): string {
  if (!minutes) return description
  return `${description} About ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
}

function stepLabel(step: ApplicationJourneyStep, stageTitle?: string): string {
  if (step === ATTACH_EVIDENCE) return 'Attach evidence'
  if (step === REVIEW) return 'Review and submit'
  return stageTitle ?? humanize(step)
}

function stepDescription(
  step: ApplicationJourneyStep,
  stageTitle?: string,
  stageDescription?: string | null,
): string {
  if (step === ATTACH_EVIDENCE) {
    return 'Attach each document required by this cycle and by the answers in the form.'
  }
  if (step === REVIEW) {
    return 'Check every answer and document before creating the formal submission.'
  }
  return (
    stageDescription ??
    `Answer the ${(stageTitle ?? humanize(step)).toLowerCase()} questions for this application.`
  )
}
