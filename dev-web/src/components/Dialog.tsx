/**
 * The shell every modal dialog on this client sits in.
 *
 * Six dialogs were hand-rolled as a fixed-position overlay with
 * `role="dialog" aria-modal="true"` on it and nothing else. That covers the
 * screen for a mouse and does nothing for anybody else: the page behind stayed
 * focusable, so Tab walked straight out of the dialog into the form underneath,
 * and stayed in the accessibility tree, so a screen reader read a page the
 * person could not act on. `aria-modal` is a claim about behaviour, not a way
 * of getting it.
 *
 * ## What this adds, and why in this order
 *
 * **Portalled to `document.body`.** Not cosmetic — it is what makes the rest
 * inert possible at all. Every one of these dialogs is written inside the
 * screen it belongs to, so the subtree that would have to become inert
 * *contains the dialog*, and marking it would disable the dialog too.
 *
 * **Everything else made `inert`.** One attribute, and the browser does the
 * work: an inert subtree takes no focus, no clicks and no place in the
 * accessibility tree. This replaces the focus trap such a dialog would
 * otherwise need — Tab cannot enter what cannot be focused — which is worth
 * saying because a hand-written trap is a well-known source of the bug it is
 * meant to fix.
 *
 * **Focus moved to the dialog and put back afterwards.** The container takes
 * focus rather than the first control: a dialog that steals focus straight into
 * a text field skips whatever the heading was going to tell somebody.
 *
 * **Escape closes it**, where the caller offers a way to close.
 *
 * The caller keeps its own markup, including `role`, `aria-*` and its overlay
 * class. Six dialogs share this behaviour and no two share a layout, so what is
 * hoisted here is exactly the part that was identical and missing.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Dialog({
  open,
  onClose,
  children,
}: {
  open: boolean
  /**
   * Called on Escape. Omit for a dialog that must be dismissed deliberately —
   * nothing else here depends on it.
   */
  onClose?: () => void
  children: ReactNode
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)

  /*
   * The close handler through a ref, so the effect below does not re-run on
   * every render. Callers pass an inline arrow, and a dependency on it would
   * mean tearing the inert marks down and putting them back on each keystroke
   * the parent re-renders for.
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const element = document.createElement('div')
    /*
     * Focusable but out of the tab order, so focus can be moved *to* the
     * dialog on open without adding a stop nobody asked for. The element lays
     * nothing out: every overlay inside it positions itself.
     */
    element.tabIndex = -1
    document.body.append(element)
    setHost(element)
    return () => {
      element.remove()
      setHost(null)
    }
  }, [open])

  useEffect(() => {
    if (!host) return undefined

    const returnFocusTo = document.activeElement
    const madeInert: HTMLElement[] = []
    for (const sibling of Array.from(document.body.children)) {
      /*
       * Skipping what is already inert matters for a dialog opened from a
       * dialog: the outer one is another body child, marking it is correct,
       * and restoring it below would otherwise wake a page that should have
       * stayed asleep.
       */
      if (!(sibling instanceof HTMLElement) || sibling === host || sibling.inert) {
        continue
      }
      sibling.inert = true
      madeInert.push(sibling)
    }

    host.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const close = closeRef.current
      if (!close) return
      event.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      for (const element of madeInert) element.inert = false
      // Back where they were, so closing a dialog does not dump somebody at
      // the top of the page they opened it from.
      if (returnFocusTo instanceof HTMLElement) returnFocusTo.focus()
    }
  }, [host])

  if (!host) return null
  return createPortal(children, host)
}
