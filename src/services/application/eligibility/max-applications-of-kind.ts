/** Fewer than a number of applications of a kind, across every cycle. */
import { z } from 'zod'
import { defineEligibility, ELIGIBLE } from './define'

export const maxApplicationsOfKind = defineEligibility('MAX_APPLICATIONS_OF_KIND', {
  params: z.strictObject({ kind: z.string(), max: z.number().int().min(0) }),
  evaluate: (params, history) =>
    history.applications.filter((application) => application.kind === params.kind && !application.draft).length < params.max
      ? ELIGIBLE
      : { eligible: false, reason: 'Your enterprise has already made as many applications of this kind as the programme allows.' },
})
