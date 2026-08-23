/**
 * Why a question is asked.
 *
 * Attached to the label of a field whose purpose is genuinely not obvious from
 * its name — the ones where somebody filling the form in for the first time
 * would otherwise guess. Used sparingly: an explanation beside every field
 * teaches nothing and doubles the reading.
 *
 * Opens on click and closes on Escape or on clicking away. Not on hover, which
 * cannot be reached by touch or by keyboard.
 */
import { useEffect, useId, useRef, useState } from 'react'

export function Explain({ children, label }: { children: string; label: string }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const id = useId()

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
    <span className="explain-anchor" ref={anchor}>
      <button
        type="button"
        className="explain"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Why ${label} is asked`}
        onClick={() => setOpen((was) => !was)}
      >
        ?
      </button>
      {open ? (
        <span className="explain-popover" id={id} role="note">
          {children}
        </span>
      ) : null}
    </span>
  )
}
