/**
 * No unfinished application of a kind — a draft, or one still being worked.
 * Two open applications of one kind would be two files asking for the same
 * money, and the office would have to decide which to believe.
 */
import { z } from 'zod'
import { defineEligibility, ELIGIBLE } from './define'

export const noOpenApplicationOfKind = defineEligibility('NO_OPEN_APPLICATION_OF_KIND', {
  params: z.strictObject({ kind: z.string() }),
  evaluate: (params, history) =>
    history.applications.some((application) => application.kind === params.kind && !application.finished)
      ? { eligible: false, reason: 'You already have an application of this kind in progress.' }
      : ELIGIBLE,
})
