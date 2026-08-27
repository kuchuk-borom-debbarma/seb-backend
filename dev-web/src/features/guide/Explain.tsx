/**
 * A short answer to a word whose name does not give one.
 *
 * Attached to a label, or to the eyebrow of a card, where the meaning is
 * genuinely not guessable — the places somebody meeting the product for the
 * first time would otherwise guess wrong. Used sparingly, at most one per card:
 * an explanation beside every field teaches nothing and doubles the reading.
 *
 * Opens on hover, click, or keyboard focus, and closes on mouse leave, Escape,
 * or on clicking away.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export function Explain({
  children,
  label,
  opener,
}: {
  children: string
  /** What is being explained, for the opener's accessible name. */
  label: string
  /**
   * The whole accessible name, when the default phrasing would not be English.
   * "Why Category is asked" is right for a question on a form; "Why Ledger is
   * asked" is not, because a ledger is not a question.
   */
  opener?: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLSpanElement>(null)
  const [shiftX, setShiftX] = useState<number>(0)
  const [flipTop, setFlipTop] = useState(false)
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const handleMouseEnter = () => {
    if (closeTimeout.current) {
      clearTimeout(closeTimeout.current)
      closeTimeout.current = null
    }
    setOpen(true)
  }

  const handleMouseLeave = () => {
    closeTimeout.current = setTimeout(() => {
      setOpen(false)
    }, 150)
  }

  useEffect(() => {
    return () => {
      if (closeTimeout.current) clearTimeout(closeTimeout.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (!open || !popoverRef.current || !anchor.current) return

    const updatePosition = () => {
      if (!popoverRef.current || !anchor.current) return
      const popoverRect = popoverRef.current.getBoundingClientRect()
      const anchorRect = anchor.current.getBoundingClientRect()
      const padding = 16

      let calculatedShift = 0
      // Check if popover overflows past right viewport edge
      if (anchorRect.left + popoverRect.width > window.innerWidth - padding) {
        calculatedShift =
          window.innerWidth - padding - (anchorRect.left + popoverRect.width)
      }
      // Ensure it doesn't overflow past left viewport edge
      if (anchorRect.left + calculatedShift < padding) {
        calculatedShift = padding - anchorRect.left
      }

      // Check vertical flip
      const spaceBelow = window.innerHeight - anchorRect.bottom
      const shouldFlipTop =
        spaceBelow < popoverRect.height + 20 && anchorRect.top > popoverRect.height + 20

      setShiftX(calculatedShift)
      setFlipTop(shouldFlipTop)
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false)
        return
      }
      if (!anchor.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', dismiss)
    }
  }, [open])

  return (
    <span
      className="explain-anchor"
      ref={anchor}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className="explain"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={opener ?? `Why ${label} is asked`}
        // Open, never toggle: on a mouse the hover (and on keyboard the
        // focus) has already opened it, so a toggle would close on the very
        // click that asks for it. Escape and leaving are what close.
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open ? (
        <span
          ref={popoverRef}
          className="explain-popover"
          id={id}
          role="note"
          style={{
            left: `${shiftX}px`,
            top: flipTop ? 'auto' : 'calc(100% + 6px)',
            bottom: flipTop ? 'calc(100% + 6px)' : 'auto',
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {children}
        </span>
      ) : null}
    </span>
  )
}
