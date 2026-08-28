import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { CycleForm, emptyCycle } from '#/features/admin/CycleForm'
import { CreateCycleDocument } from '#/graphql/generated/operations'
import type { ProgrammeCycleInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import styles from '#/features/admin/CycleForm.module.css'

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
      await router.navigate({
        to: '/admin/cycles/$id',
        params: { id: cycle.id },
      })
    },
  })

  return (
    <main className={styles.formContainer}>
      <div className={styles.pageHeader}>
        <Link to="/admin/cycles" className={styles.backLink}>
          <ArrowLeft size={20} className={styles.backArrowIcon} aria-hidden="true" />
          Create a programme cycle
        </Link>
        <p className={`${styles.headerSubtitle} page-header-description`}>
          It is created as a draft. Nothing is visible to applicants until you open it.
        </p>
      </div>

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
