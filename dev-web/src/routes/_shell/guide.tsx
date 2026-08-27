/**
 * Start here.
 *
 * The screen somebody is shown first. Its job is to answer one question before
 * any other: what is this, and how does work move through it? The route diagram
 * does that in a picture, built from the programme's own statuses — and the
 * guided routes below it take somebody through the real screens afterwards.
 */
import { createFileRoute } from '@tanstack/react-router'
import { FileText, ListOrdered, Users } from 'lucide-react'
import { statusGuideQuery } from '#/features/application/queries'
import { ROUTE_LENGTH, RouteDiagram } from '#/features/guide/RouteDiagram'
import styles from './guide.module.css'

export const Route = createFileRoute('/_shell/guide')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statusGuideQuery),
  component: GuidePage,
})

function GuidePage() {
  const { user } = Route.useRouteContext()

  return (
    <main className={styles.pageWrap}>
      <header className={styles.headerRow}>
        <div className={styles.headerLeft}>
          <h1 className={styles.pageTitle}>How Mission SEP works</h1>
          <p className={styles.pageSubtitle}>
            An application is a file that passes between four desks. This is the route it takes,
            and the screens each desk works from.
          </p>
        </div>

        <div className={styles.statPillsGroup} aria-label="Quick statistics">
          <div className={styles.statPill} data-type="states">
            <span className={styles.statPillIcon}>
              <ListOrdered size={16} aria-hidden="true" />
            </span>
            <span>{ROUTE_LENGTH} states</span>
          </div>
          <div className={styles.statPill} data-type="desks">
            <span className={styles.statPillIcon}>
              <Users size={16} aria-hidden="true" />
            </span>
            <span>4 desks</span>
          </div>
          <div className={styles.statPill} data-type="ref">
            <span className={styles.statPillIcon}>
              <FileText size={16} aria-hidden="true" />
            </span>
            <span>1 reference number</span>
          </div>
        </div>
      </header>

      <RouteDiagram user={user} />
    </main>
  )
}
