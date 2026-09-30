/**
 * Reading a pipeline's own flag declarations, shared by the effects that name
 * a flag.
 */
import type { PipelineDefinition, PipelineStatusFlag } from '../definition'
import type { PermissionPair } from '../registry'

export const flagOf = (definition: PipelineDefinition, key: string): PipelineStatusFlag | undefined =>
  definition.statusFlags.find((flag) => flag.key === key)

/**
 * The permission a flag change needs, by what the flag means: recording an
 * outcome — an approval, a rejection — is a decision, while noting progress is
 * part of moving a file along. An author cannot make an approval cheaper by
 * calling it progress, because the kind is fixed by the flag's declaration and
 * the pair by this function.
 */
export const flagPermission = (definition: PipelineDefinition, key: string): PermissionPair =>
  flagOf(definition, key)?.kind === 'OUTCOME' ? 'stage:decide' : 'stage:advance'
