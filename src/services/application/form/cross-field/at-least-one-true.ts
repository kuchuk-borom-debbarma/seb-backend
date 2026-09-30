/**
 * At least one of these yes-or-no questions is answered yes.
 *
 * Holds vacuously when none of them is asked — a rule cannot demand an answer
 * to a question that is not on the screen.
 */
import { defineFormRule } from './define'

export const atLeastOneTrue = defineFormRule('AT_LEAST_ONE_TRUE', {
  holds: (operands) => operands.every((operand) => operand.value === undefined) || operands.some((operand) => operand.value === true),
})
