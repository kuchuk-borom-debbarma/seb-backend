/** Keeps what the officer wrote as a staff-only note on the file. */
import { z } from 'zod'
import { defineEffect } from '../registry'

export const addInternalNote = defineEffect('ADD_INTERNAL_NOTE', {
  params: z.strictObject({ input: z.string() }),
  permissions: () => ['application:note'],
  validate: (params, { action }) => {
    const input = action.inputs.find((candidate) => candidate.key === params.input)
    return input && input.type !== 'LONG_TEXT' ? [`${input.key} must be LONG_TEXT to be kept as a note.`] : []
  },
  plan: (params, context) => {
    const note = context.inputs[params.input]
    return typeof note === 'string' && note.trim() ? { internalNote: note.trim() } : {}
  },
})
