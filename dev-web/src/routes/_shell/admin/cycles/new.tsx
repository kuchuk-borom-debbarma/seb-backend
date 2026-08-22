import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { CycleForm, emptyCycle } from '#/features/admin/CycleForm'
import { CreateCycleDocument } from '#/graphql/generated/operations'
import type { ProgrammeCycleInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

export const Route = createFileRoute('/_shell/admin/cycles/new')({
  component: NewCyclePage,
})

function NewCyclePage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const create = useMutation({
    mutationFn: async (input: ProgrammeCycleInput) => {
      const data = await gql(CreateCycleDocument, { input })
      return unwrap(data.admin.programmeCycle.create).head
    },
    onSuccess: async (cycle) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-cycles'] })
      await router.navigate({ to: '/admin/cycles/$id', params: { id: cycle.id } })
    },
  })

  return (
    <main className="page">
      <PageHeader
        title="Create a programme cycle"
        description="It is created as a draft. Nothing is visible to applicants until you open it."
      />

      {create.isError ? (
        <p className="notice" data-tone="error" role="alert" style={{ marginBottom: '1rem' }}>
          {messageFor(create.error)}
        </p>
      ) : null}

      <CycleForm
        initial={emptyCycle(new Date().getFullYear())}
        submitLabel="Create draft cycle"
        busy={create.isPending}
        onSubmit={(values) => create.mutate(values)}
        onCancel={() => router.navigate({ to: '/admin/cycles' })}
      />
    </main>
  )
}
