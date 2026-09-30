/** The answers given all differ; unanswered ones are not compared. */
import { answered, defineFormRule } from './define'

export const differentValues = defineFormRule('DIFFERENT_VALUES', {
  holds: (operands) => {
    const given = operands.map((operand) => operand.value).filter(answered).map(String)
    return new Set(given).size === given.length
  },
})
