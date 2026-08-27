/**
 * Rupees on the screen, paise in the answer.
 *
 * Kept out of the renderer and free of runtime imports so the service suite can
 * import it directly, for the reason `formTemplate.ts` gives: a rule the
 * applicant's money passes through is worth testing against the real function
 * rather than against a copy of it.
 *
 * **Nothing here multiplies or divides by 100.** The pair used to, and the
 * float that came out is not the number that went in: `Number('0.07') * 100` is
 * `7.000000000000001`, and near the top of the permitted range — the schema
 * allows up to 9007199254740991 paise — dividing and multiplying back lands a
 * paise away from where it started. An amount is the worst place in this
 * product to be approximately right, and the repository already records that a
 * total has no way to look truncated.
 *
 * So the conversion is textual: paise are split into whole rupees and a
 * two-digit remainder, and a typed amount is read as a decimal string. Every
 * value is an integer at every step.
 */

/** The paise an answer holds, as the rupees a person types. */
export const paiseToRupees = (paise: unknown): string => {
  if (typeof paise === 'string') return paise
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise)) return ''
  const negative = paise < 0
  const absolute = Math.abs(paise)
  const whole = Math.floor(absolute / 100)
  const remainder = absolute % 100
  const rupees = remainder === 0
    ? String(whole)
    : `${whole}.${String(remainder).padStart(2, '0')}`
  return negative ? `-${rupees}` : rupees
}

/**
 * What somebody typed, as paise — or `null` for nothing, and `undefined` for
 * something that is not an amount.
 *
 * The two are told apart deliberately. An empty box is a cleared answer and
 * must reach the server as `null`; text that is not a number is neither, and
 * returning `null` for it would silently discard what they were part-way
 * through typing. **`Math.round(Number('abc') * 100)` is `NaN`**, which JSON
 * encodes as `null` — so that is exactly what used to happen.
 */
export const rupeesToPaise = (rupees: string): number | null | undefined => {
  const trimmed = rupees.trim()
  if (trimmed === '') return null
  const match = /^(-?)(\d*)(?:\.(\d{0,2}))?$/u.exec(trimmed)
  if (!match || (match[2] === '' && match[3] === undefined)) return undefined
  const [, sign, whole, fraction] = match
  const paise = Number(`${whole || '0'}${(fraction ?? '').padEnd(2, '0')}`)
  if (!Number.isSafeInteger(paise)) return undefined
  return sign === '-' ? -paise : paise
}
