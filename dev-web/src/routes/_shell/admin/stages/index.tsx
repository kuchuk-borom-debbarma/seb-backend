/**
 * The stages this person works, with how many files wait at each.
 *
 * A bank officer's day starts here: which of their stages have files, and how
 * many. A super administrator works every stage of every published pipeline,
 * so this is also where they reach any stage's queue.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { MyStageCards } from '#/features/stage/MyStageCards'
import { myStagesQuery } from '#/features/stage/stageQueries'
import { messageFor } from '#/lib/result'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/stages/')({
  loader: ({ context }) =>
    can(context.user, 'stage', 'read')
      ? context.queryClient.ensureQueryData(myStagesQuery)
      : null,
  component: MyStagesGate,
})

function MyStagesGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'stage', 'read')) {
    return (
      <PermissionRefusal
        title="My stages"
        needs="the officers who work a pipeline stage"
      />
    )
  }
  return <MyStagesPage />
}

function MyStagesPage() {
  const { data: stages, error } = useQuery(myStagesQuery)
  const mark = useMarker()

  return (
    <main className="page">
      <PageHeader
        title="My stages"
        description="The pipeline stages your roles work, and the files waiting at each. Open a stage to see its queue, oldest arrival first."
      />
      {error ? (
        <p className="notice" data-tone="error">
          {messageFor(error)}
        </p>
      ) : (
        <div {...mark('my-stages')}>
          <MyStageCards stages={stages ?? []} />
        </div>
      )}
    </main>
  )
}
