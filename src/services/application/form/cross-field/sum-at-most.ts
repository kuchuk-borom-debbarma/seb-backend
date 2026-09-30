/** The amounts given add up to no more than the rule's limit. */
import { defineFormRule } from './define'

export const sumAtMost = defineFormRule('SUM_AT_MOST', {
  holds: (operands, limit) =>
    limit === null ||
    operands.reduce((sum, operand) => sum + (typeof operand.value === 'number' ? operand.value : 0), 0) <= limit,
})
