/**
 * Display formatting for values the API returns.
 *
 * Every `Intl` instance is created once at module scope. Constructing a
 * formatter inside a render or a table row is the usual way a money column
 * becomes the slowest thing on a page.
 */

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

/*
 * Pinned to India Standard Time, not the machine's zone. The server renders
 * these strings in UTC and the browser re-renders them in the visitor's zone
 * — two different texts for one instant, which React reports as a hydration
 * mismatch (#418) and answers by throwing the server's DOM away. Every click
 * during that re-render died silently. The programme is Tripura's; IST is
 * the one honest zone to show it in, from every machine.
 */
const dayMonthYear = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
})

const dayMonthYearTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
})

const relative = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' })

/**
 * Renders a `Money` scalar.
 *
 * The Worker sends a decimal string of **paise**, never rupees and never a
 * number. Dividing here rather than at the call site keeps the conversion in
 * one place, and parsing from the string avoids the precision loss a JSON
 * number would already have introduced.
 */
export const formatMoney = (paise: string | null | undefined): string => {
  if (paise === null || paise === undefined) return '—'
  const value = Number(paise)
  if (!Number.isFinite(value)) return '—'
  return rupees.format(value / 100)
}

/** Formats a `Date` scalar (`YYYY-MM-DD`) or a `DateTime` scalar (ISO-8601). */
export const formatDate = (value: string | null | undefined): string =>
  value ? dayMonthYear.format(new Date(value)) : '—'

export const formatDateTime = (value: string | null | undefined): string =>
  value ? dayMonthYearTime.format(new Date(value)) : '—'

/**
 * An instant as a `datetime-local` input wants it: `YYYY-MM-DDTHH:mm`, **local**.
 *
 * Deliberately not `toISOString().slice(0, 16)`, which is the obvious thing and
 * is wrong. That yields UTC wall-clock, and the input reads whatever it is
 * given as local — so an instant went in, local time came out, and saving
 * converted that local reading back to UTC and subtracted the offset again.
 * It compounded: every edit moved the value one more time.
 *
 * The parse back needs no helper. `new Date('2026-08-25T14:00')` already reads
 * a zoneless string as local, which is exactly what the input produced.
 */
export const toLocalDateTimeInput = (value: string | null | undefined): string => {
  if (!value) return ''
  const at = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

/**
 * "in 3 days" / "2 hours ago", for cycle windows and session expiry.
 *
 * Chooses the largest unit that still reads naturally, so a closing date three
 * weeks out is not reported as 504 hours.
 */
export const formatRelative = (value: string | null | undefined): string => {
  if (!value) return '—'
  const deltaMs = new Date(value).getTime() - Date.now()
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ]
  for (const [unit, ms] of units) {
    if (Math.abs(deltaMs) >= ms) return relative.format(Math.trunc(deltaMs / ms), unit)
  }
  return relative.format(0, 'minute')
}

/**
 * Acronyms this programme uses, which must not be sentence-cased.
 *
 * Without this, `humanize` produces "St certificate", "Dpr feasibility" and
 * "Gstin" — which look like typos to the people who work with these documents
 * daily.
 */
const ACRONYMS = new Set([
  'ST',
  'DPR',
  'GST',
  'GSTIN',
  'NOC',
  'TTAADC',
  'SEP',
  'IT',
  'PIN',
  'ID',
  'A',
  'B',
])

/**
 * Turns a screaming-snake enum into a readable phrase.
 *
 * DESK_REVIEW becomes "Desk review", and ST_CERTIFICATE becomes
 * "ST certificate" rather than "St certificate".
 */
export const humanize = (value: string): string =>
  value
    // Field names arrive in camelCase and enums in SCREAMING_SNAKE, and both
    // reach the interface — a validation issue names its field. Splitting on
    // both keeps "receivedGovernmentFunding" from rendering as one word.
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .split('_')
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word
      const lower = word.toLowerCase()
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')

/**
 * Shows a string that is sometimes a constant and sometimes a sentence.
 *
 * A role grant's reason is written by whoever made the grant — except for the
 * grants the system makes itself, which carry a constant like
 * `VERIFIED_APPLICANT_SIGNUP`. Humanizing everything would mangle real
 * sentences; humanizing nothing leaves a constant on screen. So the shape
 * decides: all upper case with no spaces is a constant, anything else is prose
 * and is shown exactly as it was written.
 */
export const readableReason = (value: string): string =>
  /^[A-Z][A-Z0-9_]*$/u.test(value) ? humanize(value) : value
