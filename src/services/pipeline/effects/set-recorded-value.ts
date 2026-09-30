/**
 * Keeps an input as a named value on the application — the approved grant, the
 * loan the bank fulfilled.
 *
 * The bounds are the one place a money rule survives the workflow becoming
 * configuration: an author can say *which* answer an amount may not exceed,
 * but the comparison itself is code, and runs whatever the author wrote.
 */
import { z } from 'zod'
import { defineEffect } from '../registry'

const numericTypes = new Set(['MONEY_PAISE', 'INTEGER'])

/** An input type and a recorded value type that may hold the same value. */
const compatible = (inputType: string, valueType: string): boolean =>
  inputType === valueType || (valueType === 'TEXT' && (inputType === 'TEXT' || inputType === 'LONG_TEXT'))

export const setRecordedValue = defineEffect('SET_RECORDED_VALUE', {
  params: z.strictObject({
    input: z.string(),
    target: z.string(),
    atMostAnswer: z.string().optional(),
    atMostCycleCeiling: z.boolean().optional(),
  }),
  permissions: () => ['stage:decide'],
  validate: (params, { definition, action }) => {
    const input = action.inputs.find((candidate) => candidate.key === params.input)
    const target = definition.recordedValues.find((candidate) => candidate.key === params.target)
    if (!input || !target) return []
    const problems: string[] = []
    if (!compatible(input.type, target.type)) {
      problems.push(`${input.key} is ${input.type}, which ${target.key} (${target.type}) cannot hold.`)
    }
    if ((params.atMostAnswer || params.atMostCycleCeiling) && !numericTypes.has(target.type)) {
      problems.push(`${target.key} is not an amount, so it cannot be bounded.`)
    }
    return problems
  },
  plan: (params, context) => {
    const value = context.inputs[params.input]
    // An optional input left empty records nothing rather than recording blank.
    if (value === undefined || value === null || value === '') return {}
    if (typeof value === 'number') {
      if (params.atMostAnswer) {
        const answer = context.answers[params.atMostAnswer]
        if (typeof answer !== 'number') {
          return { refusal: 'The applicant did not give the amount this is bounded by.', inputKey: params.input }
        }
        if (value > answer) {
          return {
            refusal: `This is more than the ${rupees(answer)} the applicant asked for.`,
            inputKey: params.input,
          }
        }
      }
      if (params.atMostCycleCeiling && context.cycleCeilingPaise !== null && value > context.cycleCeilingPaise) {
        return {
          refusal: `This is more than the ${rupees(context.cycleCeilingPaise)} the cycle allows for one application.`,
          inputKey: params.input,
        }
      }
    }
    return { recorded: { [params.target]: value } }
  },
})

/** An amount in paise as the officer reads it: "₹1,50,000". The bound, named, is what to type instead. */
const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN')}`
