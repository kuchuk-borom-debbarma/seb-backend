/**
 * The activity history.
 *
 * Every other office screen answers "what is the state of this application".
 * This one answers "who changed it, and when" — which is the question asked
 * after something has gone wrong, and the one the portal could not answer at
 * all until the history was readable.
 *
 * It is the most personal read in the product: who did what, from which
 * address. Only a role that may read the history may open it, and the route
 * says so before it renders anything rather than letting the API refuse and
 * showing an empty table. Every filter lives in the URL, and so does the entry
 * open in the dialog, so a view — or one entry — can be sent to a colleague.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { ListEmpty, Pager } from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { OFFICE_LEDES } from '#/features/admin/officeGuidance'
import { AuditEntryDialog } from '#/features/audit/AuditEntryDialog'
import { AuditFilters } from '#/features/audit/AuditFilters'
import { AuditTable } from '#/features/audit/AuditTable'
import {
  AUDIT_PAGE_SIZE,
  filterFor,
  isFiltered,
  pageQueryFor,
  validateAuditSearch,
  type AuditSearch,
} from '#/features/audit/auditQueries'
import { ExportDialog } from '#/features/audit/ExportDialog'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { messageFor } from '#/lib/result'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/audit')({
  validateSearch: validateAuditSearch,
  // The open entry is not part of the page: opening one must not refetch it.
  loaderDeps: ({ search: { event: _open, ...page } }) => page,
  loader: async ({ context, deps }) => {
    // Nothing is read for somebody who may not read it; the component says so.
    if (!can(context.user, 'audit', 'read')) return
    await context.queryClient.ensureQueryData(pageQueryFor(deps))
  },
  component: AuditPage,
})

function AuditPage() {
  const { user } = Route.useRouteContext()
  /*
   * Checked here as well as by the API. A screen nobody may use should not
   * render and then fill with a refusal.
   *
   * A permission refusal rather than a portal one: somebody holding another
   * office permission is in the right place and simply does not hold this one,
   * which is a different sentence from "this part is for the programme office".
   */
  if (!can(user, 'audit', 'read')) {
    return (
      <PermissionRefusal
        title="Activity history"
        needs="anybody whose role may read the activity history"
      />
    )
  }
  return <AuditHistory mayExport={can(user, 'audit', 'export')} />
}

/** Every filter off; paging and the open entry go with them. */
const CLEARED: Partial<AuditSearch> = {
  actorRole: undefined,
  actor: undefined,
  subject: undefined,
  involving: undefined,
  kinds: undefined,
  actions: undefined,
  types: undefined,
  entity: undefined,
  application: undefined,
  reference: undefined,
  outcome: undefined,
  since: undefined,
  until: undefined,
  request: undefined,
}

function AuditHistory({ mayExport }: { mayExport: boolean }) {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data, error, isPending, isPlaceholderData } = useQuery(pageQueryFor(search))
  const [exporting, setExporting] = useState(false)

  const events = data?.nodes ?? []
  const filtered = isFiltered(search)

  /*
   * Any filter change drops the cursor. A cursor is a position in one ordered
   * set; carried into a different set it seeks to a row that is no longer
   * there, and the API refuses it rather than guessing.
   */
  const filter = (change: Partial<AuditSearch>) =>
    navigate({ search: (previous) => ({ ...previous, ...change, after: undefined }) })
  // The open entry is a history entry of its own, so back closes it.
  const openEntry = (event: string | undefined) =>
    navigate({ search: (previous) => ({ ...previous, event }) })

  return (
    <main className="page">
      <PageHeader
        title="Activity history"
        description={OFFICE_LEDES.audit}
        actions={
          mayExport ? (
            <button type="button" className="button" onClick={() => setExporting(true)}>
              <Download size={16} aria-hidden="true" /> Export
            </button>
          ) : undefined
        }
      />

      <AuditFilters
        search={search}
        filter={filter}
        onClear={filtered ? () => filter(CLEARED) : undefined}
      />

      {error ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(error)}
        </p>
      ) : isPending ? (
        <p className="muted">Reading the history…</p>
      ) : events.length === 0 ? (
        <ListEmpty
          title={filtered ? 'Nothing matches' : 'Nothing recorded yet'}
          text={
            filtered
              ? 'No entry matches these filters. Clearing one may bring some back.'
              : 'Nothing has been recorded in the activity history yet.'
          }
          onClear={filtered ? () => filter(CLEARED) : undefined}
        />
      ) : (
        <AuditTable events={events} busy={isPlaceholderData} onOpen={openEntry} />
      )}

      <Pager
        shown={events.length}
        totalCount={data?.pageInfo.totalCount ?? 0}
        hasNextPage={Boolean(data?.pageInfo.hasNextPage)}
        atStart={!search.after}
        pageSize={AUDIT_PAGE_SIZE}
        onFirst={() =>
          navigate({ search: (previous) => ({ ...previous, after: undefined }) })
        }
        onNext={() =>
          navigate({
            search: (previous) => ({
              ...previous,
              after: data?.pageInfo.endCursor ?? undefined,
            }),
          })
        }
      />

      {search.event ? (
        <AuditEntryDialog
          id={search.event}
          onClose={() => openEntry(undefined)}
          onOpen={openEntry}
          onShowRequest={(request) =>
            navigate({
              search: {
                ...CLEARED,
                request,
                oldest: true,
                event: undefined,
                after: undefined,
              },
            })
          }
        />
      ) : null}

      {exporting ? (
        <ExportDialog filter={filterFor(search)} onClose={() => setExporting(false)} />
      ) : null}
    </main>
  )
}
