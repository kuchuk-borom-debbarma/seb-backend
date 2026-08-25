/**
 * Which tour is running, and where in it.
 *
 * Kept in one place because three things need it at once: the rail that shows
 * the step, the mark that brackets the element the step is about, and the
 * navigation that moves between screens as the tour advances.
 *
 * Progress survives a reload. A demonstration gets interrupted — a question, a
 * phone call — and coming back to step one every time would make the guide
 * something to endure rather than use.
 */
import { useLocation, useNavigate } from '@tanstack/react-router'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Capability, UserRole } from '#/graphql/generated/schema'
import { NOTHING_HELD, heldFrom, resolve, type Held } from './heldFile'
import { canWalk, tourById, type Tour, type TourStep } from './tours'

const STORAGE_KEY = 'seb.guide'

/*
 * The file in hand is remembered across reloads for the same reason the
 * position is. Somebody opens an application, goes to the guide to start a
 * route, and expects it to follow the file they were just looking at — and a
 * full page load between the two would otherwise drop it.
 */
const HELD_KEY = 'seb.guide.held'

/**
 * Forgets everything the guide remembers about this person.
 *
 * Called on sign-out for the same reason the query cache is cleared there: the
 * next person at this browser should not inherit which application was open,
 * nor resume a route halfway through somebody else's work.
 */
export const forgetGuide = (): void => {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('seb.guide')) window.localStorage.removeItem(key)
    }
  } catch {
    // A browser refusing storage has nothing to forget.
  }
}

type Position = { tourId: string; step: number }

type Guide = {
  tour: Tour | null
  step: TourStep | null
  /** One-based, for the counter people read. */
  number: number
  total: number
  start: (tourId: string) => void
  next: () => void
  back: () => void
  stop: () => void
  /** True while a tour is talking about this element. */
  isMarked: (mark: string | undefined) => boolean
  /**
   * True when the current step names a screen and the reader is not on it —
   * they clicked away, or the step needed a file that has since been opened.
   */
  adrift: boolean
  /** Re-runs the current step, now that it can be followed. */
  again: () => void
}

const GuideChannel = createContext<Guide | null>(null)

/**
 * Reads the saved position, tolerating anything that is not one.
 *
 * A position is discarded when this account may no longer walk the route it
 * names. Storage outlives a role: a tour begun before a grant was revoked, or
 * left running by whoever used the browser last, would otherwise reappear as a
 * rail full of work this person cannot do.
 */
const readSaved = (walker: Walker): Position | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Position
    const saved = tourById(parsed.tourId)
    return saved && canWalk(saved, walker) ? parsed : null
  } catch {
    // A corrupt or unreadable entry is not worth failing the page for.
    return null
  }
}

/*
 * Roles and capabilities both: a tour is offered on the capability the office
 * itself is gated on, so a reviewer and an approver are offered the office
 * tours rather than only an administrator.
 */
type Walker =
  { roles: readonly UserRole[]; capabilities: readonly Capability[] } | undefined

export function GuideProvider({ children, user }: { children: ReactNode; user: Walker }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [position, setPosition] = useState<Position | null>(null)
  const [held, setHeld] = useState<Held>(NOTHING_HELD)

  /*
   * Remember whatever file the address names, whether or not a tour is running:
   * somebody usually opens an application first and starts the route afterwards,
   * and a guide that only began watching at step one would have missed it.
   */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HELD_KEY)
      if (raw) setHeld({ ...NOTHING_HELD, ...(JSON.parse(raw) as Partial<Held>) })
    } catch {
      // An unreadable entry only means the guide has nothing in hand.
    }
  }, [])

  useEffect(() => {
    setHeld((previous) => {
      const next = heldFrom(pathname, previous)
      if (
        next.application === previous.application &&
        next.meeting === previous.meeting &&
        next.cycle === previous.cycle
      ) {
        return previous
      }
      try {
        window.localStorage.setItem(HELD_KEY, JSON.stringify(next))
      } catch {
        // Remembering across a reload is a convenience, not a requirement.
      }
      return next
    })
  }, [pathname])

  /*
   * Read after mount rather than during render. The shell is server-rendered,
   * and the server has no localStorage — starting from the saved position on
   * the client only would make the first paint disagree with the markup.
   */
  useEffect(() => setPosition(readSaved(user)), [user])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (position) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position))
    else window.localStorage.removeItem(STORAGE_KEY)
  }, [position])

  const tour = position ? (tourById(position.tourId) ?? null) : null
  const step = tour?.steps[position?.step ?? 0] ?? null

  /*
   * Where the current step wants the reader to be, if it can be followed at
   * all. Resolved once and shared, so the offer to go there and the navigation
   * that goes there can never disagree about which file fills the address.
   */
  const here = step ? resolve(step.to, step.search, held) : null

  /** Moves to a step and, if it happens on a screen, goes there. */
  const goTo = useCallback(
    (tourId: string, index: number) => {
      const target = tourById(tourId)
      // Refused here as well as filtered on the page that offers routes: this
      // is the one door every entry goes through, so it is where the rule holds.
      if (!target || !canWalk(target, user)) return
      const bounded = Math.max(0, Math.min(index, target.steps.length - 1))
      setPosition({ tourId, step: bounded })
      /*
       * A step naming a screen that belongs to one file is followed only when
       * that file is in hand. Otherwise the tour advances and stays put, and the
       * rail says what to open — it does not guess at an id.
       */
      const moving = target.steps[bounded]
      const destination = resolve(moving?.to, moving?.search, held)
      if (destination) {
        // `pathname` is this module's own bookkeeping, not a router option —
        // handing it to navigate would be passing it something it never asked
        // for, next to a `to` it might contradict.
        const { pathname: _address, ...navigation } = destination
        void navigate(navigation)
      }
    },
    [navigate, user, held],
  )

  const value = useMemo<Guide>(
    () => ({
      tour,
      step,
      number: (position?.step ?? 0) + 1,
      total: tour?.steps.length ?? 0,
      start: (tourId) => goTo(tourId, 0),
      next: () => position && goTo(position.tourId, position.step + 1),
      back: () => position && goTo(position.tourId, position.step - 1),
      stop: () => setPosition(null),
      isMarked: (mark) => Boolean(mark) && step?.mark === mark,
      /*
       * Where the step wants to be, compared with where the reader is. Computed
       * rather than remembered, so opening the file the step was waiting for
       * turns the offer on by itself.
       */
      adrift: Boolean(here && pathname !== here.pathname),
      again: () => position && goTo(position.tourId, position.step),
    }),
    [goTo, position, step, tour, here, pathname],
  )

  return <GuideChannel.Provider value={value}>{children}</GuideChannel.Provider>
}

/**
 * The running tour.
 *
 * Returns a dormant guide outside the provider rather than throwing, so a
 * component that offers guidance can be rendered anywhere without the caller
 * having to know whether the shell is above it.
 */
export const useGuide = (): Guide =>
  useContext(GuideChannel) ?? {
    tour: null,
    step: null,
    number: 0,
    total: 0,
    start: () => {},
    next: () => {},
    back: () => {},
    stop: () => {},
    isMarked: () => false,
    adrift: false,
    again: () => {},
  }

/**
 * Marks elements as the subject of a tour step.
 *
 * Called once per component; the function it returns is spread onto as many
 * elements as the screen has marks. When the running step is about one, the
 * stylesheet draws a bracket in the margin beside it — the annotation an
 * officer makes against a passage in a file — rather than dimming everything
 * else. A demonstration that hides the product to explain the product has the
 * wrong end of it.
 */
export const useMarker = () => {
  const { isMarked } = useGuide()
  return useCallback(
    (mark: string) =>
      isMarked(mark)
        ? ({ 'data-guide': mark, 'data-marked': true } as const)
        : ({ 'data-guide': mark } as const),
    [isMarked],
  )
}
