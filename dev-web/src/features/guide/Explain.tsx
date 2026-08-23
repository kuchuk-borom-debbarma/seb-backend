/**
 * A short answer to a word whose name does not give one.
 *
 * Attached to a label, or to the eyebrow of a card, where the meaning is
 * genuinely not guessable — the places somebody meeting the product for the
 * first time would otherwise guess wrong. Used sparingly, at most one per card:
 * an explanation beside every field teaches nothing and doubles the reading.
 *
 * Opens on click and closes on Escape or on clicking away. Not on hover, which
 * cannot be reached by touch or by keyboard.
 *
 * Two things to know before adding the next one:
 *
 * - **Put it beside the `<label>`, never inside it.** Inside, the `?` joins the
 *   field's accessible name and the control announces as "Category ?", which
 *   breaks both screen readers and `getByLabel`. `.label-row` exists for this.
 * - **Anchor it to something left-aligned.** The popover is absolutely
 *   positioned from the left edge of its anchor and does not flip, so one
 *   hung off a right-aligned header action would run off the screen.
 */
import { useEffect, useId, useRef, useState } from 'react'

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
        aria-label={opener ?? `Why ${label} is asked`}
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
