/**
 * Whether the page has hydrated — whether React now owns what is on screen.
 *
 * A server-rendered form is visible, and typeable, before React attaches to
 * it. Its inputs are controlled, so hydration sets each back to the empty
 * value in state: whatever was typed in that window vanished, and a quick
 * "Sign in" then sent an empty form and read as a wrong password. A form that
 * waits on this says so by being disabled until the moment typing would stick.
 *
 * `useSyncExternalStore` gives the server snapshot while hydrating and the
 * client snapshot straight after, with no effect or extra render.
 */
import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}

export const useHydrated = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
