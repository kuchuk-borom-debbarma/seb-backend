/** Thin GraphQL delegation for authoring pipelines. */
import {
  createPipeline,
  discardPipelineDraft,
  pipelineByKey,
  pipelineCatalogue,
  pipelines,
  publishedPipelineChoices,
  publishPipelineDraft,
  retirePipeline,
  savePipelineDraft,
  setPipelineStageOwners,
  validatePipelineDraft,
} from '../../../services/pipeline/controllers/authoring'
import type { GraphQLContext } from '../../types'

type Input<F extends (input: never, context: GraphQLContext) => unknown> = { input: Parameters<F>[0] }

export const pipelineResolvers = {
  AdminQuery: { pipeline: () => ({}) },
  AdminMutation: { pipeline: () => ({}) },
  AdminPipelineQuery: {
    list: (_parent: unknown, _args: unknown, context: GraphQLContext) => pipelines(context),
    byKey: (_parent: unknown, args: { key: string }, context: GraphQLContext) => pipelineByKey(args.key, context),
    validateDraft: (_parent: unknown, args: { definition: string }, context: GraphQLContext) =>
      validatePipelineDraft(args.definition, context),
    catalogue: (_parent: unknown, _args: unknown, context: GraphQLContext) => pipelineCatalogue(context),
    publishedChoices: (_parent: unknown, _args: unknown, context: GraphQLContext) => publishedPipelineChoices(context),
  },
  AdminPipelineMutation: {
    create: (_parent: unknown, args: Input<typeof createPipeline>, context: GraphQLContext) => createPipeline(args.input, context),
    saveDraft: (_parent: unknown, args: Input<typeof savePipelineDraft>, context: GraphQLContext) => savePipelineDraft(args.input, context),
    publish: (_parent: unknown, args: Input<typeof publishPipelineDraft>, context: GraphQLContext) => publishPipelineDraft(args.input, context),
    discardDraft: (_parent: unknown, args: Input<typeof discardPipelineDraft>, context: GraphQLContext) => discardPipelineDraft(args.input, context),
    retire: (_parent: unknown, args: Input<typeof retirePipeline>, context: GraphQLContext) => retirePipeline(args.input, context),
    setStageOwners: (_parent: unknown, args: Input<typeof setPipelineStageOwners>, context: GraphQLContext) =>
      setPipelineStageOwners(args.input, context),
  },
}
