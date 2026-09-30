/**
 * The first answer is no more than the second. Dates compare as calendar
 * dates; either answer missing means there is nothing to compare yet.
 */
import { answered, defineFormRule } from './define'

const ordinal = (type: string, value: unknown): number =>
  type === 'DATE' ? Date.parse(`${String(value)}T00:00:00Z`) : Number(value)

export const atMostField = defineFormRule('AT_MOST_FIELD', {
  holds: ([first, second]) => {
    if (!first || !second || !answered(first.value) || !answered(second.value)) return true
    return ordinal(first.type, first.value) <= ordinal(second.type, second.value)
  },
})
