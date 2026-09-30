/**
 * Queries behind the stage screens: the stages a person works, one stage's
 * queue, one file as its stage shows it, and the pipeline shapes a list
 * filters by.
 *
 * The file's stage view is never served stale, for the reason the workspace
 * gives: another officer may have acted a moment ago, and every action quotes
 * a `statusVersion` read from this data.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  MyStagesDocument,
  StageApplicationDocument,
  StagePipelineChoicesDocument,
  StagePipelineShapeDocument,
  StageQueueDocument,
} from '#/graphql/generated/operations'
import type { AdminStageQueueInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export const STAGE_QUEUE_PAGE_SIZE = 25

export const myStagesQuery = queryOptions({
  queryKey: ['my-stages'],
  queryFn: async () => {
    const data = await gql(MyStagesDocument)
    return unwrap(data.admin.stage.myStages)
  },
  staleTime: 10_000,
})

/**
 * One page of one stage's queue. Paged by the screen as an infinite query —
 * "Load more" appends the next page after the last row shown — under keys
 * starting `stage-queue`, which is what a write invalidates.
 */
export const fetchStageQueue = async (input: AdminStageQueueInput) => {
  const data = await gql(StageQueueDocument, { input })
  return unwrap(data.admin.stage.queue)
}

export const stageApplicationQuery = (applicationId: string) =>
  queryOptions({
    queryKey: ['stage-application', applicationId],
    queryFn: async () => {
      const data = await gql(StageApplicationDocument, { applicationId })
      return unwrap(data.admin.stage.application)
    },
    staleTime: 0,
  })

export type StageFile = Awaited<
  ReturnType<NonNullable<ReturnType<typeof stageApplicationQuery>['queryFn']>>
>
export type StageAction = StageFile['actions'][number]
export type StageValue = StageFile['recordedValues'][number]

/** Published pipelines, for a filter. Needs `pipeline`/`read`. */
export const pipelineChoicesQuery = queryOptions({
  queryKey: ['stage-pipeline-choices'],
  queryFn: async () => {
    const data = await gql(StagePipelineChoicesDocument)
    return unwrap(data.admin.pipeline.publishedChoices)
  },
  staleTime: 60_000,
})

/** What a list needs from a published pipeline: its stages and its flags. */
export type PipelineShape = {
  readonly stages: readonly { key: string; name: string }[]
  readonly flags: readonly { key: string; label: string }[]
}

/**
 * Reads the stage and flag names out of a published definition.
 *
 * Defensive on purpose: the document is JSON text, and a list filter is not
 * the place to fail over a shape it only reads two lists from.
 */
const shapeOf = (definitionJson: string): PipelineShape => {
  try {
    const parsed = JSON.parse(definitionJson) as {
      stages?: { key?: unknown; name?: unknown }[]
      statusFlags?: { key?: unknown; label?: unknown }[]
    }
    const named = (
      entries: { key?: unknown; name?: unknown; label?: unknown }[] | undefined,
      field: 'name' | 'label',
    ) =>
      (entries ?? [])
        .filter((entry) => typeof entry.key === 'string')
        .map((entry) => ({
          key: entry.key as string,
          [field]:
            typeof entry[field] === 'string'
              ? (entry[field] as string)
              : (entry.key as string),
        }))
    return {
      stages: named(parsed.stages, 'name') as { key: string; name: string }[],
      flags: named(parsed.statusFlags, 'label') as { key: string; label: string }[],
    }
  } catch {
    return { stages: [], flags: [] }
  }
}

export const pipelineShapeQuery = (key: string) =>
  queryOptions({
    queryKey: ['stage-pipeline-shape', key],
    queryFn: async () => {
      const data = await gql(StagePipelineShapeDocument, { key })
      const published = unwrap(data.admin.pipeline.byKey).published
      return published ? shapeOf(published.definitionJson) : { stages: [], flags: [] }
    },
    enabled: key.length > 0,
    staleTime: 60_000,
  })
