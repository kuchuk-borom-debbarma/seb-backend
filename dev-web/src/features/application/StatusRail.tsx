/**
 * The status rail — the one thing this portal is remembered by.
 *
 * The question an applicant actually has is "where is my application, and who
 * must act next?" This answers both in one glance: the pipeline in workflow
 * order, where this application sits on it, and whether the work is currently
 * theirs or the programme office's.
 *
 * Every value comes from the API. The stages are the schema's own status list,
 * and the labels, explanations and next actor come from `statusGuide`, so the
 * rail cannot describe a workflow the server does not have.
 */
import type { ApplicationStatus } from '#/graphql/generated/schema'
import styles from './StatusRail.module.css'

export type StatusGuideEntry = {
  status: ApplicationStatus
  label: string
  explanation: string
  nextActor: string
  nextAction: string | null
}

/**
 * The stages an application passes through on its way to funding.
 *
 * `REVISION_REQUIRED` and `CANCELLED` are deliberately absent from the rail:
 * the first is a loop back to the applicant rather than a step forward, and the
 * second is a terminal state off the path entirely. Both are still described,
 * below the rail, when the application is actually in them.
 */
const PIPELINE: ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'DESK_REVIEW',
  'PARTNER_BANK_EVALUATION',
  'AWAITING_DECISION',
  'APPROVED',
  'SANCTIONED',
  'DISBURSED',
]

/** Compact stage names. The full label is carried by the guide entry below. */
const SHORT_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  DESK_REVIEW: 'Desk review',
  PARTNER_BANK_EVALUATION: 'Bank',
  AWAITING_DECISION: 'Decision',
  APPROVED: 'Approved',
  SANCTIONED: 'Sanctioned',
  DISBURSED: 'Funds released',
}

export function StatusRail({
  status,
  guide,
}: {
  status: ApplicationStatus
  guide: StatusGuideEntry[]
}) {
  const entry = guide.find((candidate) => candidate.status === status)

  /*
   * While revision is required the application has gone back to the applicant
   * from desk review, so the rail marks desk review as the live stage and the
   * notice below says what is actually being waited on.
   */
  const railStatus = status === 'REVISION_REQUIRED' ? 'DESK_REVIEW' : status
  const reachedIndex = PIPELINE.indexOf(railStatus)
  const offPipeline = reachedIndex < 0

  return (
    <section className={styles.rail} aria-label="Application progress">
      {offPipeline ? null : (
        <ol className={styles.track}>
          {PIPELINE.map((stage, index) => {
            const state =
              index < reachedIndex ? 'done' : index === reachedIndex ? 'current' : 'ahead'
            return (
              <li key={stage} className={styles.stage} data-state={state}>
                <span className={styles.marker} aria-hidden="true" />
                <span className={styles.stageLabel}>{SHORT_LABEL[stage]}</span>
              </li>
            )
          })}
        </ol>
      )}

      {entry ? (
        <div
          className={styles.summary}
          data-actor={entry.nextActor === 'APPLICANT' ? 'applicant' : 'other'}
        >
          <p className={styles.summaryTitle}>
            {entry.label}
            <span
              className="badge"
              data-tone={entry.nextActor === 'APPLICANT' ? 'action' : undefined}
            >
              {entry.nextActor === 'APPLICANT'
                ? 'Your turn'
                : entry.nextActor === 'PROGRAMME_OFFICE'
                  ? 'With the programme office'
                  : 'No further action'}
            </span>
          </p>
          <p className={styles.summaryText}>{entry.explanation}</p>
          {entry.nextAction ? (
            <p className={styles.summaryAction}>{entry.nextAction}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
