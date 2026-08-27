/**
 * How long is left to submit.
 *
 * A closing date on the cycles screen is not much help to somebody halfway
 * through the form three weeks later, so the same fact is repeated where the
 * work happens. It states the date *and* the time remaining: a countdown alone
 * is hard to plan around, and a date alone is easy to misjudge.
 *
 * Urgency is never carried by colour alone — roadmap §3 and §19 both require
 * that — so the wording changes as well as the tone.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Clock, Hourglass } from 'lucide-react'
import { cyclesQuery } from '#/features/application/queries'
import { formatDateTime, formatRelative } from '#/lib/format'
import styles from './ClosingNotice.module.css'

/** Inside this many days, closing is worth saying loudly. */
const SOON_DAYS = 7

export function ClosingNotice({ programmeCycleId }: { programmeCycleId: string }) {
  const { data: cycles } = useQuery(cyclesQuery)

  // Both lists are searched: an applicant with work in a cycle sees it under
  // "mine", and one who has just started sees it under "available".
  const cycle =
    cycles?.mine.find((entry) => entry.id === programmeCycleId) ??
    cycles?.available.find((entry) => entry.id === programmeCycleId)

  if (!cycle?.closesAt) return null

  const msLeft = new Date(cycle.closesAt).getTime() - Date.now()
  if (msLeft <= 0) {
    return (
      <div className={styles.noticeCard} data-tone="error" role="alert">
        <div className={styles.iconBadge}>
          <AlertTriangle aria-hidden="true" />
        </div>
        <div className={styles.noticeContent}>
          <h3 className={styles.noticeTitle}>This cycle has closed</h3>
          <p className={styles.noticeText}>
            Applications closed on{' '}
            <span className={styles.noticeHighlight}>
              {formatDateTime(cycle.closesAt)}
            </span>
            .
          </p>
          <p className={styles.noticeSubtext}>
            Anything not submitted by then cannot be submitted now.
          </p>
        </div>
      </div>
    )
  }

  const soon = msLeft < SOON_DAYS * 24 * 60 * 60 * 1000

  return (
    <div
      className={styles.noticeCard}
      data-tone={soon ? 'action' : 'normal'}
      role="region"
      aria-label="Cycle closing notice"
    >
      <div className={styles.iconBadge}>
        {soon ? <Hourglass aria-hidden="true" /> : <Clock aria-hidden="true" />}
      </div>
      <div className={styles.noticeContent}>
        <h3 className={styles.noticeTitle}>
          {soon ? 'Closing soon' : 'When applications close'}
        </h3>
        <p className={styles.noticeText}>
          {cycle.displayName} closes{' '}
          <span className={styles.noticeHighlight}>
            {formatRelative(cycle.closesAt)}, on {formatDateTime(cycle.closesAt)}
          </span>
          .
        </p>
        <p className={styles.noticeSubtext}>
          An application that has not been submitted by then cannot be submitted at all.
        </p>
      </div>
    </div>
  )
}
