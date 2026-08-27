import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import {
  EnterpriseForm,
  emptyEnterprise,
  type EnterpriseFormValues,
} from '#/features/enterprise/EnterpriseForm'
import { CreateEnterpriseDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

export const Route = createFileRoute('/_shell/_applicant/enterprises/new')({
  // A registration begun from the application flow returns there, with the new
  // enterprise pre-selected, instead of stranding the person on this record.
  validateSearch: (
    search: Record<string, unknown>,
  ): { returnTo?: 'application'; cycleId?: string } => ({
    returnTo: search.returnTo === 'application' ? 'application' : undefined,
    cycleId:
      search.returnTo === 'application' && typeof search.cycleId === 'string'
        ? search.cycleId
        : undefined,
  }),
  component: NewEnterprisePage,
})

function NewEnterprisePage() {
  const search = Route.useSearch()
  const router = useRouter()
  const queryClient = useQueryClient()

  const create = useMutation({
    mutationFn: async (values: EnterpriseFormValues) => {
      const data = await gql(CreateEnterpriseDocument, { input: values })
      return unwrap(data.seb.enterprise.create)
    },
    onSuccess: async (enterprise) => {
      // The list is now wrong on every page and with every filter, so the whole
      // key prefix goes rather than the one page we happen to have cached.
      await queryClient.invalidateQueries({ queryKey: ['enterprises'] })
      if (search.returnTo === 'application') {
        await router.navigate({
          to: '/applications/new',
          search: { enterpriseId: enterprise.id, cycleId: search.cycleId },
        })
      } else {
        await router.navigate({
          to: '/enterprises/$id',
          params: { id: enterprise.id },
        })
      }
    },
  })

  return (
    <main className="page">
      <PageHeader
        title="Register an enterprise"
        description="Complete the enterprise profile one category at a time. Only the registered or trading name is required to register it."
      />

      {create.isError ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginBottom: '1rem' }}
        >
          {messageFor(create.error)}
        </p>
      ) : null}

      <EnterpriseForm
        initial={emptyEnterprise}
        submitLabel="Register enterprise"
        busy={create.isPending}
        onSubmit={(values) => create.mutate(values)}
        onCancel={() => router.navigate({ to: '/enterprises' })}
      />
    </main>
  )
}
