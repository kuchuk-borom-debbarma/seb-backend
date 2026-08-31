/**
 * Text normalization shared across services.
 *
 * Both helpers trim before they measure, so a value of spaces is a blank and a
 * cap counts the characters the row will actually hold. They lived in the
 * admin service's support module until the announcement service needed them
 * too; two copies of a cap-and-trim decision would drift the first time one
 * of them changed.
 */

/** The trimmed value, or null where blank or over the cap — one refusal path. */
export const normalizeRequiredText = (
  value: string,
  maximumLength: number,
): string | null => {
  const normalized = value.trim()
  return normalized && normalized.length <= maximumLength ? normalized : null
}

/**
 * Three-way on purpose: an omitted or blank optional field is an ordinary
 * `null`, while a value over the cap is `'INVALID'` — collapsing the two would
 * store nothing where the caller wrote too much, and silently.
 */
export const normalizeOptionalText = (
  value: string | null | undefined,
  maximumLength: number,
): string | null | 'INVALID' => {
  if (value === null || value === undefined) return null
  const normalized = value.trim()
  if (!normalized) return null
  return normalized.length <= maximumLength ? normalized : 'INVALID'
}
