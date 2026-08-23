/**
 * The running tour, docked beside the product.
 *
 * Deliberately not an overlay. The usual guided tour dims the page and floats a
 * bubble over it, which for a demonstration is exactly backwards: the thing
 * being explained disappears behind the explanation. This takes a column of its
 * own that the layout makes room for, so the screen under discussion stays
 * whole and usable while the guide talks about it.
 *
 * It reads as the noting sheet clipped to a file: the desk that holds the work,
 * a numbered position in the route, one passage of prose, and the step list
 * underneath.
 */
import { useLocation } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useGuide } from './GuideContext'
import styles from './TourRail.module.css'

export function TourRail() {
  const { tour, step, number, total, next, back, stop, adrift, again } = useGuide()

  /*
   * Put the reader in front of the thing being discussed.
   *
   * A step that moves to another screen inherits the scroll position of the one
   * before it, which on a long page means arriving at blank space below the
   * content. So: scroll to whatever the step marks, or to the top when it marks
   * nothing. The marked element is polled for a few frames because the
   * destination route renders after the navigation resolves.
   */
  const { pathname } = useLocation()
  const here = `${tour?.id ?? ''}:${number}:${pathname}`
  useEffect(() => {
    if (!tour) return
    let frames = 0
    let raf = 0
    const stillness = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const behavior = stillness ? 'auto' : 'smooth'

    const look = () => {
      const marked = document.querySelector('[data-marked]')
      if (marked) {
        marked.scrollIntoView({ block: 'center', behavior })
        return
      }
      if (frames < 30) {
        frames += 1
        raf = requestAnimationFrame(look)
        return
      }
      window.scrollTo({ top: 0, behavior })
    }

    raf = requestAnimationFrame(look)
    return () => cancelAnimationFrame(raf)
  }, [here, tour])

  if (!tour || !step) return null

  const first = number === 1
  const last = number === total

  return (
    <aside className={styles.rail} aria-label={`Guided route: ${tour.title}`}>
      <div className={styles.head}>
        <p className={styles.tourTitle}>{tour.title}</p>
        <button
          type="button"
          className={styles.close}
          onClick={stop}
          aria-label="End the tour"
        >
          End
        </button>
      </div>

      <div className={styles.body}>
        {/* The desk, then the position. Whose turn it is comes first because
            that is the question this product exists to answer. */}
        <p className={styles.desk}>{step.desk}</p>
        <p className={styles.counter}>
          Step {number} of {total}
        </p>

        <h2 className={styles.stepTitle}>{step.title}</h2>
        <p className={styles.prose}>{step.body}</p>

        {step.needs ? (
          <p className={styles.needs}>
            <span className={styles.needsLabel}>To try this</span>
            {step.needs}
          </p>
        ) : null}
      </div>

      <ol className={styles.steps}>
        {tour.steps.map((entry, index) => (
          <li
            key={entry.title}
            className={styles.stepRow}
            data-state={
              index + 1 === number ? 'here' : index + 1 < number ? 'passed' : 'ahead'
            }
          >
            <span className={styles.stepNumber}>{index + 1}</span>
            <span className={styles.stepName}>{entry.title}</span>
          </li>
        ))}
      </ol>

      {/*
        A step that needed a file nobody had open did not navigate — it said so
        instead. Once one is open the step can be followed, so the offer appears
        by itself rather than leaving somebody holding an instruction with no way
        to act on it. It also covers the ordinary case of clicking away mid-route.
      */}
      {adrift ? (
        <button
          type="button"
          className={`button ${styles.again}`}
          data-variant="primary"
          onClick={again}
        >
          Take me to this step
        </button>
      ) : null}

      <div className={styles.foot}>
        <button type="button" className="button" disabled={first} onClick={back}>
          Back
        </button>
        {last ? (
          <button type="button" className="button" data-variant="primary" onClick={stop}>
            Finish
          </button>
        ) : (
          <button type="button" className="button" data-variant="primary" onClick={next}>
            Next
          </button>
        )}
      </div>
    </aside>
  )
}
