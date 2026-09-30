/**
 * An application's standing, as its applicant is told it.
 *
 * Everything after submission is the pipeline's to describe: the stage's
 * applicant label and explanation, how the journey ended, and the flags and
 * recorded values the pipeline marks applicant-visible — never a stage's
 * internal name. The API has already filtered out what the applicant may not
 * see, so this decides only how it reads.
 */
import type { ApplicationJourneyFieldsFragment } from '#/graphql/generated/operations'
import { formatDate, formatMoney } from '#/lib/format'

export type Journey = ApplicationJourneyFieldsFragment

type Standing = {
  status: string
  /** The sections the applicant may edit now: what the detail view carries. */
  editableStageKeys?: readonly string[]
  /** Whether a correction is open: what a list row carries instead. */
  awaitingCorrection?: boolean
  journey?: Journey | null
}

const correcting = (application: Standing): boolean =>
  application.status !== 'DRAFT' &&
  ((application.editableStageKeys?.length ?? 0) > 0 || application.awaitingCorrection === true)

/** Whose move it is, in the applicant's terms. */
export type NextActor = 'APPLICANT' | 'PROGRAMME_OFFICE' | 'NOBODY'

export const nextActorOf = (application: Standing): NextActor => {
  if (application.status === 'DRAFT' || correcting(application)) return 'APPLICANT'
  if (application.journey?.ended) return 'NOBODY'
  return 'PROGRAMME_OFFICE'
}

/** One short phrase for a list row or a badge. */
export const standingLabel = (application: Standing): string => {
  if (application.status === 'DRAFT') return 'Draft'
  if (correcting(application)) return 'Changes requested'
  if (application.journey?.ended) return application.journey.ended
  return application.journey?.stageLabel ?? 'Submitted'
}

/** The sentence under the badge on the application's own page. */
export const standingExplanation = (application: Standing): string | null => {
  if (application.status === 'DRAFT') return null
  if (correcting(application)) {
    return 'The programme office has asked you to correct parts of your application. Make the changes below and submit again; it goes back to the same reviewers.'
  }
  if (application.journey?.ended) {
    return `Your application’s journey has finished: ${application.journey.ended}.`
  }
  return application.journey?.stageExplanation ?? null
}

/** A recorded value as the applicant reads it. */
export const journeyValueText = (value: Journey['recordedValues'][number]): string => {
  if (value.type === 'MONEY_PAISE') return formatMoney(value.value)
  if (value.type === 'DATE') return formatDate(value.value)
  return value.value
}

/** Flags as quiet chips; nothing is drawn for none. */
export function JourneyFlags({ journey }: { journey: Journey | null | undefined }) {
  if (!journey || journey.flags.length === 0) return null
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
      {journey.flags.map((flag) => (
        <span key={flag.key} className="badge" title={flag.explanation ?? undefined}>
          {flag.label}
        </span>
      ))}
    </span>
  )
}
