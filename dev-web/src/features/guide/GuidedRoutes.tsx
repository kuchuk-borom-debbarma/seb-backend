/**
 * The guided routes this account may walk, each a sequence of real screens.
 *
 * Only the routes `canWalk` allows are offered; the rest are counted, so
 * somebody can tell a route exists for work their account does not do rather
 * than wonder whether the guide is incomplete.
 */
import { ArrowRight, Compass, Info, ListOrdered, User } from 'lucide-react'
import { useGuide } from './GuideContext'
import { TOURS, canWalk } from './tours'
import styles from './GuidedRoutes.module.css'

export function GuidedRoutes({ user }: { user: Parameters<typeof canWalk>[1] }) {
  const { start, tour: running } = useGuide()
  const allowed = TOURS.filter((tour) => canWalk(tour, user))
  const withheld = TOURS.length - allowed.length

  return (
    <section className={styles.card} aria-label="Guided routes">
      <div className={styles.header}>
        <h2 className={styles.title}>
          <Compass size={17} aria-hidden="true" />
          <span>Guided routes</span>
        </h2>
        <p className={styles.description}>
          Each one walks the real screens with a note beside whatever is being discussed.
          You can leave at any point and carry on where you stopped.
        </p>
      </div>

      {allowed.map((tour) => (
        <article key={tour.id} className={styles.route}>
          <div className={styles.routeText}>
            <h3 className={styles.routeTitle}>{tour.title}</h3>
            <p className={styles.routePromise}>{tour.promise}</p>
            <p className={styles.routeMeta}>
              <ListOrdered size={14} aria-hidden="true" /> {tour.steps.length} steps
              <span aria-hidden="true">·</span>
              <User size={14} aria-hidden="true" /> {tour.audience}
            </p>
          </div>
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => start(tour.id)}
          >
            {running?.id === tour.id ? 'Start again' : 'Walk this route'}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </article>
      ))}

      {withheld > 0 ? (
        <p className={styles.withheld}>
          <Info size={14} aria-hidden="true" />
          {withheld === 1
            ? '1 more route covers work this account cannot do. It appears once it holds the role.'
            : `${withheld} more routes cover work this account cannot do. They appear once it holds the role.`}
        </p>
      ) : null}
    </section>
  )
}
