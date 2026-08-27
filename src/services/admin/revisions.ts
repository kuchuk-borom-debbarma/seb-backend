/**
 * The revision rules every outcome that carries revisions applies.
 *
 * Recording and correcting a bank outcome, recording and correcting a decision,
 * and completing a desk review all apply the same four: a revision-bearing
 * outcome needs at least one request, each request must name a distinct stage,
 * each stage must be one the cycle's own form declares, and each needs an
 * approved reason plus a safe instruction. Only the wording and the upper bound
 * differ, so only those are passed in.
 *
 * **The desk review was a fifth copy and it was missing the membership check.**
 * An officer could complete a review requesting a revision on a stage the
 * cycle's form does not have: the application moved to `REVISION_REQUIRED` with
 * a scope nothing intersects, so the applicant could neither save nor resubmit
 * and was told the application had changed, on every attempt, for ever. The
 * decision and bank paths refused it all along.
 *
 * Membership used to be the GraphQL enum's job and is checked here now, because
 * the stages belong to the pinned template. The revision row's foreign key onto
 * that template is what makes it correct; this is what makes it explicable, and
 * it names the stage rather than saying the request was malformed.
 *
 * Its own module rather than `support.ts`: it needs `approvedReason` from
 * `queries/intake.ts`, and that file imports the shared preamble — so putting it
 * there made the two import each other, which is a cycle that fails at
 * initialisation rather than at build.
 */
import { approvedReason } from './queries/intake'
import { findPinnedCycleRules } from '../application/queries/form-template'
import { normalizeRequiredText } from './support'
import type { AdminOperationContext, RevisionRequestInput } from './types'

export const revisionRequestProblem = async (
  context: AdminOperationContext,
  input: {
    carriesRevisions: boolean
    revisions: RevisionRequestInput[]
    cycleId: string
    cycleVersion: number
    stagesMessage: string
    instructionMessage: string
    unexpectedMessage: string
    /** The most requests one outcome may carry, where the caller bounds it. */
    maximum?: number
  },
): Promise<string | null> => {
  if (!input.carriesRevisions) {
    return input.revisions.length > 0 ? input.unexpectedMessage : null
  }
  const stages = new Set(input.revisions.map((revision) => revision.stageKey))
  if (
    input.revisions.length === 0
    || (input.maximum !== undefined && input.revisions.length > input.maximum)
    || stages.size !== input.revisions.length
  ) {
    return input.stagesMessage
  }

  const rules = await findPinnedCycleRules(context.db, input.cycleId, input.cycleVersion)
  if (!rules) return input.stagesMessage
  const declared = new Set(rules.template.stages.map((stage) => stage.key))
  for (const stageKey of stages) {
    if (!declared.has(stageKey)) {
      return `This application's form has no ${stageKey} stage to revise.`
    }
  }

  for (const revision of input.revisions) {
    const approved = await approvedReason(context.db, {
      id: revision.reasonCategoryId,
      cycleId: input.cycleId,
      version: input.cycleVersion,
      context: 'REVISION',
    })
    if (!approved || !normalizeRequiredText(revision.note, 1_000)) {
      return input.instructionMessage
    }
  }
  return null
}
