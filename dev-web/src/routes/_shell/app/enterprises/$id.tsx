import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import {
  EnterpriseForm,
  type EnterpriseFormValues,
} from '#/features/enterprise/EnterpriseForm'
import {
  EnterpriseByIdDocument,
  RestoreEnterpriseDocument,
  SoftDeleteEnterpriseDocument,
  UpdateEnterpriseDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

const enterpriseQuery = (id: string) =>
  queryOptions({
    queryKey: ['enterprise', id],
    queryFn: async () => {
      const data = await gql(EnterpriseByIdDocument, { id })
      return unwrap(data.seb.enterprise.byId)
    },
  })

export const Route = createFileRoute('/_shell/app/enterprises/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(enterpriseQuery(params.id)),
  component: EnterprisePage,
})

type Blocker = {
  applicationId: string
  referenceNumber: string | null
  status: string
  hasAward: boolean
}

function EnterprisePage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: enterprise } = useQuery(enterpriseQuery(id))
  const [editing, setEditing] = useState(false)
  const [blockers, setBlockers] = useState<Blocker[]>([])

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['enterprise', id] })
    await queryClient.invalidateQueries({ queryKey: ['enterprises'] })
  }

  const update = useMutation({
    mutationFn: async (values: EnterpriseFormValues) => {
      const data = await gql(UpdateEnterpriseDocument, {
        // The expected version is what makes this first-writer-wins: an edit
        // based on a stale copy is refused rather than overwriting a newer one.
        input: { id, expectedVersion: enterprise?.currentVersion ?? 0, profile: values },
      })
      return unwrap(data.seb.enterprise.update)
    },
    onSuccess: async () => {
      setEditing(false)
      await refresh()
    },
  })

  const remove = useMutation({
    mutationFn: async () => {
      const data = await gql(SoftDeleteEnterpriseDocument, {
        input: { id, expectedVersion: enterprise?.currentVersion ?? 0, reason: null },
      })
      const result = data.seb.enterprise.softDelete
      // A refusal carries the exact applications standing in the way, which is
      // the whole point of showing it rather than a general message.
      setBlockers(result.blockers)
      return unwrap(result)
    },
    onSuccess: refresh,
  })

  const restore = useMutation({
    mutationFn: async () => {
      const data = await gql(RestoreEnterpriseDocument, {
        id,
        expectedVersion: enterprise?.currentVersion ?? 0,
      })
      return unwrap(data.seb.enterprise.restore)
    },
    onSuccess: refresh,
  })

  if (!enterprise) return null

  const removed = enterprise.deletedAt !== null

  return (
    <main className="page">
      <PageHeader
        title={enterprise.name}
        description={
          removed
            ? 'This enterprise has been removed. Its history is kept and it can be restored.'
            : undefined
        }
        actions={
          editing ? null : (
            <>
              {removed ? (
                <button
                  type="button"
                  className="button"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate()}
                >
                  Restore
                </button>
              ) : (
                <>
                  <button type="button" className="button" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-variant="danger"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Remove
                  </button>
                </>
              )}
            </>
          )
        }
      />

      {remove.isError ? (
        <div className="notice" data-tone="action" role="alert" style={{ marginBottom: '1rem' }}>
          <span className="notice-title">{messageFor(remove.error)}</span>
          {blockers.length > 0 ? (
            <>
              <p style={{ marginTop: '0.5rem' }}>
                These applications keep this enterprise in place:
              </p>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                {blockers.map((blocker) => (
                  <li key={blocker.applicationId}>
                    <span className="tabular">
                      {blocker.referenceNumber ?? 'Unsubmitted draft'}
                    </span>{' '}
                    — {humanize(blocker.status)}
                    {blocker.hasAward ? ', holds a funding award' : ''}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {restore.isError ? (
        <p className="notice" data-tone="error" role="alert" style={{ marginBottom: '1rem' }}>
          {messageFor(restore.error)}
        </p>
      ) : null}

      {editing ? (
        <>
          {update.isError ? (
            <p className="notice" data-tone="error" role="alert" style={{ marginBottom: '1rem' }}>
              {messageFor(update.error)}
            </p>
          ) : null}
          <EnterpriseForm
            initial={{
              name: enterprise.name,
              establishmentDate: enterprise.establishmentDate,
              registrationType: enterprise.registrationType,
              registrationNumber: enterprise.registrationNumber,
              gstin: enterprise.gstin,
              businessSector: enterprise.businessSector,
              otherBusinessSector: enterprise.otherBusinessSector,
              businessBlockOrVillage: enterprise.businessBlockOrVillage,
              businessDistrict: enterprise.businessDistrict,
              businessPinCode: enterprise.businessPinCode,
              contactNumber: enterprise.contactNumber,
              contactEmail: enterprise.contactEmail,
            }}
            submitLabel="Save changes"
            busy={update.isPending}
            onSubmit={(values) => update.mutate(values)}
            onCancel={() => setEditing(false)}
          />
        </>
      ) : (
        <div className="card">
          {/* The page header already carries the name; repeating it here would
              be decoration. The card states what kind of record this is. */}
          <div className="card-header">
            <p className="eyebrow">Enterprise profile</p>
            <span className="badge" data-tone={removed ? 'error' : undefined}>
              {removed ? 'Removed' : humanize(enterprise.status)}
            </span>
          </div>
          <div className="card-body">
            <div className="detail-grid">
              <Detail label="Registration">
                {enterprise.registrationType === 'NONE'
                  ? 'Not registered'
                  : `${enterprise.registrationType} · ${enterprise.registrationNumber ?? '—'}`}
              </Detail>
              <Detail label="GSTIN">{enterprise.gstin ?? '—'}</Detail>
              <Detail label="Sector">
                {enterprise.businessSector
                  ? enterprise.businessSector === 'OTHER'
                    ? (enterprise.otherBusinessSector ?? 'Other')
                    : humanize(enterprise.businessSector)
                  : '—'}
              </Detail>
              <Detail label="Established">{formatDate(enterprise.establishmentDate)}</Detail>
              <Detail label="Block or village">
                {enterprise.businessBlockOrVillage ?? '—'}
              </Detail>
              <Detail label="District">{enterprise.businessDistrict ?? '—'}</Detail>
              <Detail label="PIN code">{enterprise.businessPinCode ?? '—'}</Detail>
              <Detail label="Contact number">{enterprise.contactNumber ?? '—'}</Detail>
              <Detail label="Contact email">{enterprise.contactEmail ?? '—'}</Detail>
              <Detail label="Last changed">{formatDateTime(enterprise.updatedAt)}</Detail>
            </div>
          </div>
        </div>
      )}

      <p style={{ marginTop: '1.5rem' }}>
        <Link to="/app/enterprises">Back to enterprises</Link>
      </p>
    </main>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <span>{children}</span>
    </div>
  )
}
