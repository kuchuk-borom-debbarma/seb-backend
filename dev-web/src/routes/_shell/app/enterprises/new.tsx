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

export const Route = createFileRoute('/_shell/app/enterprises/new')({
  component: NewEnterprisePage,
})

function NewEnterprisePage() {
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
      await router.navigate({
        to: '/app/enterprises/$id',
        params: { id: enterprise.id },
      })
    },
  })

  return (
    <main className="page">
      <PageHeader
        title="Register an enterprise"
        description="Only the name and whether it is registered are required now. Everything else can be completed before you submit an application."
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
        onCancel={() => router.navigate({ to: '/app/enterprises' })}
      />
    </main>
  )
}
