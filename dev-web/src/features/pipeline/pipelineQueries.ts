/**
 * The pipeline screens' reads.
 *
 * Every read is `staleTime: 0` except the catalogue: a pipeline is edited by
 * whole-draft saves guarded by a revision, so a stale copy is a save the API
 * will refuse, and the owner list takes effect the moment it changes. The
 * catalogue is the server's own vocabulary, fixed for a deployment.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  AdminPipelineByKeyDocument,
  AdminPipelineCatalogueDocument,
  AdminPipelineChoicesDocument,
  AdminPipelinesDocument,
  type AdminPipelineCatalogueQuery,
  type AdminPipelineDetailFieldsFragment,
  type AdminPipelineFieldsFragment,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'

export type PipelineSummary = AdminPipelineFieldsFragment
export type PipelineDetail = AdminPipelineDetailFieldsFragment
export type PipelineCatalogue = NonNullable<
  AdminPipelineCatalogueQuery['admin']['pipeline']['catalogue']['response']
>
export type CatalogueEffect = PipelineCatalogue['effects'][number]
export type CatalogueParam = CatalogueEffect['params'][number]

export const pipelinesQuery = queryOptions({
  queryKey: ['pipelines'],
  queryFn: async () => (await gql(AdminPipelinesDocument)).admin.pipeline.list,
  staleTime: 0,
})

export const pipelineChoicesQuery = queryOptions({
  queryKey: ['pipelines', 'choices'],
  queryFn: async () => (await gql(AdminPipelineChoicesDocument)).admin.pipeline.publishedChoices,
  staleTime: 0,
})

export const pipelineQuery = (key: string) =>
  queryOptions({
    queryKey: ['pipelines', 'detail', key],
    queryFn: async () => (await gql(AdminPipelineByKeyDocument, { key })).admin.pipeline.byKey,
    staleTime: 0,
  })

export const pipelineCatalogueQuery = queryOptions({
  queryKey: ['pipeline-catalogue'],
  queryFn: async () => (await gql(AdminPipelineCatalogueDocument)).admin.pipeline.catalogue,
  staleTime: Number.POSITIVE_INFINITY,
})
