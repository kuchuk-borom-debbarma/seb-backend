/**
 * Sends the file to the stage an input chooses — the bank, for instance.
 *
 * Every option must be routed, and nothing else may be: an option with no
 * route is a button that fails for one answer only, found by the first officer
 * to pick it.
 */
import { z } from 'zod'
import { defineEffect } from '../registry'

export const moveByChoice = defineEffect('MOVE_BY_CHOICE', {
  params: z.strictObject({ input: z.string(), routes: z.record(z.string(), z.string()) }),
  permissions: () => ['stage:advance'],
  validate: (params, { stage, action }) => {
    const input = action.inputs.find((candidate) => candidate.key === params.input)
    if (!input) return []
    if (input.type !== 'SINGLE_CHOICE') return [`${input.key} must be SINGLE_CHOICE to choose a stage.`]
    const options = new Set(input.options.map((option) => option.value))
    const routed = new Set(Object.keys(params.routes))
    return [
      ...[...options].filter((option) => !routed.has(option)).map((option) => `Option ${option} has no route.`),
      ...[...routed].filter((option) => !options.has(option)).map((option) => `A route is given for ${option}, which ${input.key} does not offer.`),
      ...Object.values(params.routes).filter((target) => target === stage.key).map(() => `An option routes ${stage.key} to itself.`),
    ]
  },
  plan: (params, context) => {
    const chosen = context.inputs[params.input]
    const to = typeof chosen === 'string' ? params.routes[chosen] : undefined
    return to ? { stage: { kind: 'MOVE', to } } : { refusal: 'Choose where to send it.', inputKey: params.input }
  },
})
