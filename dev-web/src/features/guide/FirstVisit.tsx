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
import { useGuide } from './GuideContext'
import styles from './FirstVisit.module.css'

const STORAGE_KEY = 'seb.guide.seen'

export function FirstVisit() {
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
      setShow(window.localStorage.getItem(STORAGE_KEY) === null)
    } catch {
      // A browser refusing storage is not a reason to nag on every page.
      setShow(false)
    }
  }, [])

  const dismiss = () => {
    setShow(false)
    try {
      window.localStorage.setItem(STORAGE_KEY, 'yes')
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
        First time here? <strong>How this works</strong> explains the route an application
        takes and walks you through the screens.
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
