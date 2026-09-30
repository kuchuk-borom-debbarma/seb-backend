/** Tells the applicant, on their timeline and by email when configured. */
import { z } from 'zod'
import { defineEffect } from '../registry'

export const notifyApplicant = defineEffect('NOTIFY_APPLICANT', {
  params: z.strictObject({ message: z.string().trim().min(1).max(500), email: z.boolean().optional() }),
  // Telling somebody what happened adds no authority to the act that happened.
  permissions: () => [],
  plan: (params) => ({ notify: { message: params.message, email: params.email === true } }),
})
