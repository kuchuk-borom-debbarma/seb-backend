import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { CycleForm, emptyCycle } from '#/features/admin/CycleForm'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { CreateCycleDocument } from '#/graphql/generated/operations'
import type { ProgrammeCycleInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { can } from '#/lib/session'
import styles from '#/features/admin/CycleForm.module.css'

export const Route = createFileRoute('/_shell/admin/cycles/new')({
  component: NewCycleGate,
})

/*
 * The screen is a multi-step form for one mutation, and that mutation is
 * guarded on `programme_cycle`/`create`. Ungated, anybody who could read the
 * cycle list could fill the whole thing in — every policy figure, the closing
 * time, the form template — and learn it was never theirs to submit at the
 * last step. The refusal belongs before the work, not after it.
 */
function NewCycleGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'programme_cycle', 'create')) {
    return (
      <PermissionRefusal
        title="Create a programme cycle"
        needs="anybody whose role may create a programme cycle"
      />
    )
  }
  return <NewCyclePage />
}

function NewCyclePage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const create = useMutation({
    mutationFn: async (input: ProgrammeCycleInput) => {
      const data = await gql(CreateCycleDocument, { input })
      return unwrap(data.admin.programmeCycle.create).head
    },
    onSuccess: async (cycle) => {
      // Stale, not waited on: the page this goes to loads what it shows.
      void queryClient.invalidateQueries({ queryKey: ['admin-cycles'] })
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
