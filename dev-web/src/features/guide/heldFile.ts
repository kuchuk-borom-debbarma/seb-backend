/**
 * The file somebody has open.
 *
 * Most office screens exist only for one particular thing — an application, a
 * meeting, a cycle — so their address carries an id. A guided route cannot know
 * that id: it is written before anybody signs in, and the demonstration
 * database has no fixed contents.
 *
 * That is why every step describing the work itself used to stop at a list and
 * ask the reader to carry on alone. Instead the guide watches the address and
 * remembers the last application, meeting and cycle that were opened; a step
 * naming one of those screens then follows the file already in hand.
 *
 * **It never invents an id.** With nothing in hand the step does not navigate at
 * all — the rail shows what the step needs and the reader opens one themselves.
 * Sending somebody to a made-up address, or to a real record picked at random,
 * would both be the demonstration lying about what it knows.
 */

/** The individual files a guided route can follow. */
export type Held = {
  application: string | null
  meeting: string | null
  cycle: string | null
}

export const NOTHING_HELD: Held = { application: null, meeting: null, cycle: null }

/*
 * Ids are UUIDs everywhere in this product, so the patterns are exact rather
 * than a permissive `[^/]+` that would also match a nested literal segment.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const APPLICATION = new RegExp(`^/admin/applications/(${UUID})(?:/|$)`, 'u')
const MEETING = new RegExp(`^/admin/meetings/(${UUID})(?:/|$)`, 'u')
const CYCLE = new RegExp(`^/admin/cycles/(${UUID})(?:/|$)`, 'u')

/**
 * What the address says is open, folded into what was open before.
 *
 * Folded rather than replaced: opening a meeting does not put down the
 * application, because a route may move between the two and come back.
 */
export const heldFrom = (pathname: string, previous: Held): Held => ({
  application: APPLICATION.exec(pathname)?.[1] ?? previous.application,
  meeting: MEETING.exec(pathname)?.[1] ?? previous.meeting,
  cycle: CYCLE.exec(pathname)?.[1] ?? previous.cycle,
})

/** A navigation a step asked for, once it is known to be followable. */
export type Destination = {
  to: string
  params?: Record<string, string>
  search?: Record<string, string>
}

/**
 * Where a step goes, given what is in hand.
 *
 * `null` means "stay where you are": either the step names no screen, or it
 * names one that needs a file nobody has open.
 */
export const resolve = (
  to: string | undefined,
  search: Record<string, string> | undefined,
  held: Held,
): Destination | null => {
  if (!to) return null

  const needed = to.includes('$meetingId')
    ? held.meeting
    : to.startsWith('/admin/cycles/$id')
      ? held.cycle
      : to.includes('$id')
        ? held.application
        : null

  if (to.includes('$')) {
    if (!needed) return null
    const param = to.includes('$meetingId') ? 'meetingId' : 'id'
    return { to, params: { [param]: needed }, ...(search ? { search } : {}) }
  }
  return { to, ...(search ? { search } : {}) }
}
