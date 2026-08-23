/**
 * Start here.
 *
 * The screen somebody is shown first. Its job is to answer one question before
 * any other: what is this, and how does work move through it? The route diagram
 * does that in a picture, built from the programme's own statuses — and the
 * guided routes below it take somebody through the real screens afterwards.
 *
 * Everything on this page leads somewhere real. There is no video, no mock-up
 * and no screenshot of the product inside the product.
 */
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { statusGuideQuery } from '#/features/application/queries'
import { useGuide } from '#/features/guide/GuideContext'
import { ROUTE_LENGTH, RouteDiagram } from '#/features/guide/RouteDiagram'
import { TOURS, canWalk } from '#/features/guide/tours'
import styles from './guide.module.css'

export const Route = createFileRoute('/_shell/guide')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statusGuideQuery),
  component: GuidePage,
})

function GuidePage() {
  const { user } = Route.useRouteContext()
  const { start, tour: running } = useGuide()

  // Only what this account can actually walk. The count of the rest is stated
  // below rather than silently omitted, so nobody is left wondering whether a
  // route exists.
  const allowed = TOURS.filter((tour) => canWalk(tour, user))

  return (
    <main className="page">
      <PageHeader
        title="How Mission SEP works"
        description="An application is a file that passes between four desks. This is the route it takes, and the screens each desk works from."
      />

      <section className={styles.thesis}>
        <p className={styles.lede}>
          TTAADC Mission SEP gives seed funding to first-generation Scheduled Tribe
          entrepreneurs in Tripura&rsquo;s autonomous district areas. Every application
          carries one reference number from the moment it is submitted until the last
          rupee is accounted for — and at any point, <em>somebody</em> is holding it.
        </p>
        {/* Counted from what this screen actually draws, not from a query that
            an administrator is not allowed to read. */}
        <p className={styles.count}>
          {ROUTE_LENGTH} states · 4 desks · 1 reference number
        </p>
      </section>

      <section className={styles.band}>
        <h2 className="section-title">The route a file takes</h2>
        <p className={styles.bandNote}>
          Each stop sits under the desk holding the file, numbered in the order they
          happen. Where you can see it, the applicant&rsquo;s own wording is quoted
          beneath — that surface is theirs, so an administrator is shown the
          office&rsquo;s description only.
        </p>
        <RouteDiagram />
      </section>

      <section className={styles.band}>
        <h2 className="section-title">Guided routes</h2>
        <p className={styles.bandNote}>
          Each one walks the real screens with a note beside whatever is being discussed.
          You can leave at any point and carry on where you stopped.
        </p>

        <div className={styles.tours}>
          {allowed.map((tour) => (
            <article className={styles.tour} key={tour.id}>
              <p className={styles.audience}>{tour.audience}</p>
              <h3 className={styles.tourTitle}>{tour.title}</h3>
              <p className={styles.promise}>{tour.promise}</p>
              <p className={styles.length}>
                {tour.steps.length} steps ·{' '}
                {[...new Set(tour.steps.map((step) => step.desk))].join(', ')}
              </p>
              <button
                type="button"
                className="button"
                data-variant={running?.id === tour.id ? undefined : 'primary'}
                onClick={() => start(tour.id)}
              >
                {running?.id === tour.id ? 'Start again' : 'Walk this route'}
              </button>
            </article>
          ))}
        </div>

        {allowed.length < TOURS.length ? (
          <p className={styles.withheld}>
            {TOURS.length - allowed.length === 1
              ? '1 more route covers work this account cannot do. It appears'
              : `${TOURS.length - allowed.length} more routes cover work this account cannot do. They appear`}{' '}
            once it holds the role.
          </p>
        ) : null}
      </section>
    </main>
  )
}
