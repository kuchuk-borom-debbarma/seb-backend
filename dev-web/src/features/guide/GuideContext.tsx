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
import { useNavigate } from '@tanstack/react-router'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { tourById, type Tour, type TourStep } from './tours'

const STORAGE_KEY = 'seb.guide'

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
}

const GuideChannel = createContext<Guide | null>(null)

/** Reads the saved position, tolerating anything that is not one. */
const readSaved = (): Position | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Position
    return tourById(parsed.tourId) ? parsed : null
  } catch {
    // A corrupt or unreadable entry is not worth failing the page for.
    return null
  }
}

export function GuideProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const [position, setPosition] = useState<Position | null>(null)

  /*
   * Read after mount rather than during render. The shell is server-rendered,
   * and the server has no localStorage — starting from the saved position on
   * the client only would make the first paint disagree with the markup.
   */
  useEffect(() => setPosition(readSaved()), [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (position) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position))
    else window.localStorage.removeItem(STORAGE_KEY)
  }, [position])

  const tour = position ? (tourById(position.tourId) ?? null) : null
  const step = tour?.steps[position?.step ?? 0] ?? null

  /** Moves to a step and, if it happens on a screen, goes there. */
  const goTo = useCallback(
    (tourId: string, index: number) => {
      const target = tourById(tourId)
      if (!target) return
      const bounded = Math.max(0, Math.min(index, target.steps.length - 1))
      setPosition({ tourId, step: bounded })
      const destination = target.steps[bounded]?.to
      if (destination) void navigate({ to: destination })
    },
    [navigate],
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
    }),
    [goTo, position, step, tour],
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
