/**
 * The way in.
 *
 * Somebody opening this for the first time has no reason to know the guide is
 * there. One line, once, until they have been — then it stops asking. It is
 * dismissible because a demonstration is often given more than once from the
 * same browser and a permanent banner would become furniture.
 *
 * Deliberately not a modal. Nothing here is important enough to stop somebody
 * from using the product.
 */
import { Link, useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Portal } from '#/features/portal/PortalShell'
import { useGuide } from './GuideContext'
import styles from './FirstVisit.module.css'

/**
 * One key per portal.
 *
 * The two welcomes say different things about different work, so dismissing one
 * cannot stand for the other: an officer who met this as an applicant has been
 * told nothing about the office, and this strip is the only thing that would
 * tell them. Asking twice is right when there are two things to say.
 */
const seenKey = (portal: Portal) => `seb.guide.seen.${portal}`

/** What the single key meant before there were two portals. */
const LEGACY_KEY = 'seb.guide.seen'

export function FirstVisit({ portal }: { portal: Portal }) {
  const { pathname } = useLocation()
  const { tour } = useGuide()
  const [show, setShow] = useState(false)

  /*
   * After mount, not during render: the shell is server-rendered and the server
   * cannot know whether this browser has been here before. Deciding during
   * render would make the first paint disagree with the markup.
   */
  useEffect(() => {
    try {
      const seen =
        window.localStorage.getItem(seenKey(portal)) ??
        /*
         * Before there were two portals there was one key and one welcome — the
         * applicant's. Somebody who dismissed it has seen that one and has not
         * seen the office's, so the old key answers only for the applicant.
         */
        (portal === 'applicant' ? window.localStorage.getItem(LEGACY_KEY) : null)
      setShow(seen === null)
    } catch {
      // A browser refusing storage is not a reason to nag on every page.
      setShow(false)
    }
  }, [portal])

  const dismiss = () => {
    setShow(false)
    try {
      window.localStorage.setItem(seenKey(portal), 'yes')
    } catch {
      // Nothing to do: the banner is gone for this page either way.
    }
  }

  /*
   * Not on the guide itself — that would point at the screen somebody is
   * already on — and not while a tour is running, because somebody being led
   * through the product is not lost.
   */
  if (!show || tour || pathname.startsWith('/guide')) return null

  return (
    <div className={styles.strip}>
      <p className={styles.text}>
        {portal === 'office' ? (
          <>
            First time in the programme office? <strong>How this works</strong> shows the
            route a file takes between the four desks, and walks you through the screens
            you work it from.
          </>
        ) : (
          <>
            First time here? <strong>How this works</strong> explains the route an
            application takes and walks you through the screens.
          </>
        )}
      </p>
      <div className={styles.actions}>
        <Link to="/guide" className="button" data-variant="primary" onClick={dismiss}>
          Show me
        </Link>
        <button type="button" className={styles.dismiss} onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  )
}
