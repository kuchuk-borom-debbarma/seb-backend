/**
 * Reading a list's filters out of the address.
 *
 * Every list keeps its filters in the URL, so a view can be bookmarked, sent to
 * a colleague, or reached again by the back button with the same rows in it.
 * That makes the URL untrusted input: anybody can type anything into it, and a
 * link written before a filter changed shape still arrives. Each reader here
 * therefore keeps a value only while it still means something the API would
 * accept, and drops it otherwise — a bad filter narrows nothing, which is better
 * than a screen that refuses to render.
 */

/** One of a fixed set, or nothing. */
export const oneOf = <TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): TValue | undefined =>
  allowed.includes(value as TValue) ? (value as TValue) : undefined

/**
 * A multi-value key, kept only where it names real values.
 *
 * A single string is accepted too, so a bookmark from the single-select era
 * (`?sector=OTHER`) still applies the filter it always did.
 */
export const manyOf = <TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): TValue[] | undefined => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kept = raw.filter((entry): entry is TValue => allowed.includes(entry as TValue))
  return kept.length > 0 ? kept : undefined
}

/** A calendar day, or nothing — never a partial date the API would refuse. */
export const dayOf = (value: unknown): string | undefined =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined

/*
 * A day from the picker widens to the whole day in UTC, both bounds
 * inclusive — asking for "to the 12th" must include the 12th's afternoon.
 */
export const dayStart = (day: string | undefined): string | null =>
  day ? `${day}T00:00:00.000Z` : null
export const dayEnd = (day: string | undefined): string | null =>
  day ? `${day}T23:59:59.999Z` : null

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * An identifier, or nothing. Checked here because the API refuses a malformed
 * one outright, and a bookmark with a truncated id should show the unfiltered
 * list rather than an error.
 */
export const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID.test(value) ? value : undefined

/** Several identifiers, keeping only the well-formed ones. */
export const idsOf = (value: unknown): string[] | undefined => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kept = raw.filter((entry): entry is string => idOf(entry) !== undefined)
  return kept.length > 0 ? kept : undefined
}

/** Free text, trimmed, kept only when there is some and it is not absurdly long. */
export const textOf = (value: unknown, max = 128): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}
