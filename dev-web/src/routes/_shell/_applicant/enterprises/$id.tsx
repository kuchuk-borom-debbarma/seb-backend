import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ArrowLeft,
  Building2,
  Calendar,
  Clock,
  FileText,
  IdCard,
  Mail,
  Map,
  MapPin,
  Pencil,
  Phone,
  RotateCcw,
  Sprout,
  Trash2,
} from 'lucide-react'
import { districtName } from '#/features/enterprise/districts'
import {
  EnterpriseForm,
  REGISTRATION_TYPE_LABELS,
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
import styles from '#/features/enterprise/EnterpriseDetails.module.css'

const enterpriseQuery = (id: string) =>
  queryOptions({
    queryKey: ['enterprise', id],
    queryFn: async () => {
      const data = await gql(EnterpriseByIdDocument, { id })
      return unwrap(data.seb.enterprise.byId)
    },
  })

export const Route = createFileRoute('/_shell/_applicant/enterprises/$id')({
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

function EnterpriseHeroArtwork() {
  return (
    <div className={styles.cardHeroArtwork} aria-hidden="true">
      <svg
        viewBox="0 0 200 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: '100%', height: '100%' }}
      >
        {/* Soft background hills */}
        <path
          d="M0 90 Q60 65 130 85 T200 70 L200 120 L0 120 Z"
          fill="#dbeafe"
          fillOpacity="0.4"
        />
        <path
          d="M30 95 Q100 80 160 90 T200 85 L200 120 L30 120 Z"
          fill="#bfdbfe"
          fillOpacity="0.3"
        />
        {/* Plant stems and leaves */}
        <g transform="translate(130, 20)">
          {/* Main stem */}
          <path
            d="M35 90 Q30 50 15 15"
            stroke="#16a34a"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Leaf 1 (top) */}
          <path d="M15 15 Q24 8 28 20 C22 24 16 18 15 15 Z" fill="#86efac" />
          {/* Leaf 2 (right) */}
          <path d="M24 35 Q40 28 42 42 C34 46 25 38 24 35 Z" fill="#4ade80" />
          {/* Leaf 3 (left) */}
          <path d="M22 55 Q4 48 3 62 C12 66 21 58 22 55 Z" fill="#86efac" />
          {/* Leaf 4 (right lower) */}
          <path d="M28 70 Q46 62 48 76 C40 80 29 72 28 70 Z" fill="#22c55e" />
        </g>
      </svg>
    </div>
  )
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
      <div className={styles.pageContainer}>
        {/* Header bar with back button and actions */}
        <div className={styles.headerBar}>
          <div className={styles.titleArea}>
            <Link
              to="/enterprises"
              className={styles.backSquareBtn}
              aria-label="Back to enterprises"
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </Link>
            <h1 className={styles.enterpriseName}>{enterprise.name}</h1>
          </div>

          {!editing && (
            <div className={styles.headerActions}>
              {removed ? (
                <button
                  type="button"
                  className={styles.restoreBtn}
                  disabled={restore.isPending}
                  onClick={() => restore.mutate()}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  Restore
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.editBtn}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.removeBtn}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Remove
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {removed ? (
          <p className="notice" role="status">
            This enterprise has been removed. Its history is kept and it can be
            restored.
          </p>
        ) : null}

        {/* Error alerts */}
        {remove.isError ? (
          <div
            className="notice"
            data-tone="action"
            role="alert"
            style={{ marginBottom: '1rem' }}
          >
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
          <p
            className="notice"
            data-tone="error"
            role="alert"
            style={{ marginBottom: '1rem' }}
          >
            {messageFor(restore.error)}
          </p>
        ) : null}

        {editing ? (
          <>
            {update.isError ? (
              <p
                className="notice"
                data-tone="error"
                role="alert"
                style={{ marginBottom: '1rem' }}
              >
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
          <div className={styles.profileCard}>
            {/* Top hero banner */}
            <div className={styles.cardHero}>
              <div className={styles.cardHeroLeft}>
                <div className={styles.heroIconBadge}>
                  <Building2 size={26} aria-hidden="true" />
                </div>
                <div className={styles.heroContent}>
                  <h2 className={styles.heroTitle}>Enterprise profile</h2>
                  <span
                    className={
                      removed ? styles.statusPillRemoved : styles.statusPillActive
                    }
                  >
                    <span className={styles.statusDot} aria-hidden="true" />
                    {removed ? 'Removed' : humanize(enterprise.status)}
                  </span>
                </div>
              </div>
              <EnterpriseHeroArtwork />
            </div>

            {/* Profile grid rows */}
            <div className={styles.cardBody}>
              {/* Row 1: Registration, GSTIN, Sector */}
              <div className={styles.detailsRow}>
                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <IdCard size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>Registration</span>
                    <span className={styles.itemValue}>
                      {/* A sole proprietorship may hold no number; the label
                          alone is the whole answer then. */}
                      {enterprise.registrationNumber
                        ? `${REGISTRATION_TYPE_LABELS[enterprise.registrationType]} · ${enterprise.registrationNumber}`
                        : REGISTRATION_TYPE_LABELS[enterprise.registrationType]}
                    </span>
                  </div>
                </div>

                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <FileText size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>GSTIN</span>
                    <span className={styles.itemValue}>{enterprise.gstin ?? '—'}</span>
                  </div>
                </div>

                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <Sprout size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>Sector</span>
                    <span className={styles.itemValue}>
                      {enterprise.businessSector
                        ? enterprise.businessSector === 'OTHER'
                          ? (enterprise.otherBusinessSector ?? 'Other')
                          : humanize(enterprise.businessSector)
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Row 2: Established, Office address, District */}
              <div className={styles.detailsRow}>
                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <Calendar size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>Established</span>
                    <span className={styles.itemValue}>
                      {formatDate(enterprise.establishmentDate)}
                    </span>
                  </div>
                </div>

                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <MapPin size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>Office address</span>
                    <span className={styles.itemValue}>
                      {enterprise.businessBlockOrVillage ?? '—'}
                    </span>
                  </div>
                </div>

                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <Map size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>District</span>
                    <span className={styles.itemValue}>
                      {/* The read view shows the bare district name mapped
                          from the stored code. */}
                      {enterprise.businessDistrict
                        ? districtName(enterprise.businessDistrict)
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Row 3: PIN code, Contact number, Contact email */}
              <div className={styles.detailsRow}>
                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <Mail size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>PIN code</span>
                    <span className={styles.itemValue}>
                      {enterprise.businessPinCode ?? '—'}
                    </span>
                  </div>
                </div>

                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <Phone size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>Contact number</span>
                    <span className={styles.itemValue}>
                      {enterprise.contactNumber ?? '—'}
                    </span>
                  </div>
                </div>

                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <Mail size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>Contact email</span>
                    <span className={styles.itemValue}>
                      {enterprise.contactEmail ?? '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Row 4: Last changed */}
              <div className={styles.detailsRowLast}>
                <div className={styles.itemCol}>
                  <div className={styles.itemIconBadge}>
                    <Clock size={18} aria-hidden="true" />
                  </div>
                  <div className={styles.itemContent}>
                    <span className={styles.itemLabel}>Last changed</span>
                    <span className={styles.itemValue}>
                      {formatDateTime(enterprise.updatedAt)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom back button */}
        <div className={styles.bottomNav}>
          <Link to="/enterprises" className={styles.bottomBackBtn}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to enterprises
          </Link>
        </div>
      </div>
    </main>
  )
}
