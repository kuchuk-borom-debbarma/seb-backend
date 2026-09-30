/**
 * Start here.
 *
 * The screen somebody is shown first. Its job is to answer one question before
 * any other: what is this, and how does work move through it? The part every
 * application shares — drafted, then submitted — is the same for everybody; what
 * happens after submission is the route its programme cycle's pipeline
 * configures, so it is described here in general and shown in full where a
 * pipeline is drawn. The guided routes below take somebody through the real
 * screens.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { FileText, ListOrdered } from 'lucide-react'
import { statusGuideQuery } from '#/features/application/queries'
import { GuidedRoutes } from '#/features/guide/GuidedRoutes'
import styles from './guide.module.css'

export const Route = createFileRoute('/_shell/guide')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statusGuideQuery),
  component: GuidePage,
})

function GuidePage() {
  const { user } = Route.useRouteContext()
  const { data: statuses } = useQuery(statusGuideQuery)

  return (
    <main className={styles.pageWrap}>
      <header className={styles.headerRow}>
        <div className={styles.headerLeft}>
          <h1 className={styles.pageTitle}>How Mission SEP works</h1>
          <p className={styles.pageSubtitle}>
            An application is drafted by its applicant and then submitted into the
            pipeline its programme cycle names: a configured route of stages, each
            worked by the office roles that own it, until an action ends its journey.
          </p>
        </div>

        <div className={styles.statPillsGroup} aria-label="Quick statistics">
          <div className={styles.statPill} data-type="states">
            <span className={styles.statPillIcon}>
              <ListOrdered size={16} aria-hidden="true" />
            </span>
            <span>{statuses?.length ?? 0} statuses</span>
          </div>
          <div className={styles.statPill} data-type="ref">
            <span className={styles.statPillIcon}>
              <FileText size={16} aria-hidden="true" />
            </span>
            <span>1 reference number</span>
          </div>
        </div>
      </header>

      <section className="card card-body" aria-label="How a file moves">
        <h2 style={{ marginTop: 0 }}>How a file moves</h2>
        <ol className="stack" style={{ paddingLeft: '1.2rem', margin: 0 }}>
          {(statuses ?? []).map((entry) => (
            <li key={entry.status}>
              <strong>{entry.label}.</strong> {entry.explanation}
              {entry.nextAction ? <span className="muted"> {entry.nextAction}</span> : null}
            </li>
          ))}
          <li>
            <strong>Each stage.</strong> The file waits at one stage at a time. The roles
            that own that stage may move it on, send it back to where it came from, ask
            the applicant to correct named sections, record a decision such as the grant
            approved, or end its journey. The applicant is told where it is in the
            pipeline’s own words.
          </li>
          <li>
            <strong>The end.</strong> An action that completes or closes the file ends
            its journey; no stage holds it after that.
          </li>
        </ol>
      </section>

      <GuidedRoutes user={user} />
    </main>
  )
}
