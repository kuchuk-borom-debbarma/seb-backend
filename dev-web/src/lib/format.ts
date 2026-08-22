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

const dayMonthYear = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const dayMonthYearTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
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

/** Turns a screaming-snake enum into a readable phrase: DESK_REVIEW -> Desk review. */
export const humanize = (value: string): string => {
  const spaced = value.replace(/_/gu, ' ').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
