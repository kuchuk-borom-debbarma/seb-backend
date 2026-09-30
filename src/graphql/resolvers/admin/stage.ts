/** Thin GraphQL delegation for working applications at pipeline stages. */
import {
  myStages,
  stageApplication,
  stageQueue,
  takeStageAction,
  withdrawRevision,
  type TakeActionInput,
} from '../../../services/pipeline/controllers/stage'
import { STALE_MESSAGE } from '../../../services/pipeline/support'
import type { GraphQLContext } from '../../types'

type Args<T> = { input: T }

/*
 * Whether a refusal was "somebody else acted first". Read off the one message
 * the service uses for it, so a screen can offer to reload without matching
 * words in a sentence meant for a person.
 */
const stale = (result: { message: string | null }) => result.message === STALE_MESSAGE

export const stageResolvers = {
  AdminQuery: { stage: () => ({}) },
  AdminMutation: { stage: () => ({}) },
  AdminStageQuery: {
    myStages: (_parent: unknown, _args: unknown, context: GraphQLContext) => myStages(context),
    queue: (_parent: unknown, args: Args<Parameters<typeof stageQueue>[0]>, context: GraphQLContext) =>
      stageQueue(args.input, context),
    application: (_parent: unknown, args: { applicationId: string }, context: GraphQLContext) =>
      stageApplication(args.applicationId, context),
  },
  AdminStageMutation: {
    takeAction: (_parent: unknown, args: Args<TakeActionInput>, context: GraphQLContext) =>
      takeStageAction(args.input, context),
    withdrawRevision: (_parent: unknown, args: Args<Parameters<typeof withdrawRevision>[0]>, context: GraphQLContext) =>
      withdrawRevision(args.input, context),
  },
  TakeStageActionResult: { stale },
  WithdrawRevisionResult: { stale },
}
