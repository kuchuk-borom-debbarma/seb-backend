import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  Archive,
  ArrowLeft,
  BadgeCheck,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  FileText,
  Folder,
  Lock,
  Search,
  ShieldCheck,
  Tag,
  X,
} from 'lucide-react'
import {
  AdminCycleByIdDocument,
  ArchiveCycleDocument,
  ChangeCycleClosingDocument,
  CloseCycleDocument,
  OpenCycleDocument,
  UpdateCycleGuidanceDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { useMarker } from '#/features/guide/GuideContext'
import styles from '#/features/admin/CycleDetails.module.css'

const cycleQuery = (id: string) =>
  queryOptions({
    queryKey: ['admin-cycle', id],
    queryFn: async () => {
      const data = await gql(AdminCycleByIdDocument, { id })
      return {
        cycle: unwrap(data.admin.programmeCycle.byId),
        counts: data.admin.programmeCycle.counts.response?.counts ?? [],
        events: data.admin.programmeCycle.events.response?.events ?? [],
      }
    },
    // Lifecycle transitions are version-guarded, so the version on screen must
    // be the current one or every action would be refused as stale.
    staleTime: 0,
  })

export const Route = createFileRoute('/_shell/admin/cycles/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(cycleQuery(params.id)),
  component: AdminCyclePage,
})

function GuidanceIllustration() {
  return (
    <svg
      className={styles.guidanceIllustration}
      viewBox="0 0 160 130"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Plant on Left */}
      <g transform="translate(18, 55)">
        <path d="M12 40 C7 28 4 18 2 6 C8 10 12 18 14 40" fill="#16a34a" />
        <path d="M14 40 C17 22 22 10 30 0 C28 14 24 28 16 40" fill="#22c55e" />
        <path d="M14 40 C12 28 10 18 14 8 C18 18 17 30 14 40" fill="#4ade80" />
        <polygon points="6,40 22,40 18,58 10,58" fill="#3b82f6" />
      </g>

      {/* Person Sitting at Desk */}
      <g transform="translate(50, 15)">
        {/* Hair */}
        <path
          d="M28 12 C28 5 35 0 42 0 C49 0 56 5 56 12 C56 20 54 26 50 30 C45 32 35 32 30 30 C26 26 28 18 28 12 Z"
          fill="#0f172a"
        />
        {/* Face */}
        <circle cx="42" cy="18" r="10" fill="#fbcfe8" />
        {/* Neck */}
        <rect x="39" y="27" width="6" height="6" fill="#fbcfe8" />
        {/* Torso/Shirt */}
        <path d="M24 33 C32 31 52 31 60 33 L64 70 L20 70 Z" fill="#2563eb" />
        {/* Arm */}
        <path
          d="M30 42 L48 55 L65 52"
          stroke="#fbcfe8"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {/* Laptop */}
        <polygon points="50,56 75,56 72,50 56,50" fill="#94a3b8" />
        <path d="M72 35 L75 56 L55 56 Z" fill="#3b82f6" opacity="0.9" />
        <rect x="46" y="56" width="34" height="4" rx="2" fill="#64748b" />
        {/* Chair back */}
        <rect x="16" y="32" width="6" height="45" rx="3" fill="#0f172a" />
      </g>
    </svg>
  )
}

function AdminCyclePage() {
  const mark = useMarker()
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const { data } = useQuery(cycleQuery(id))

  const [reason, setReason] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const [guidance, setGuidance] = useState<string | null>(null)

  // Modal Dialog States
  const [showClosingModal, setShowClosingModal] = useState(false)
  const [showGuidanceModal, setShowGuidanceModal] = useState(false)
  const [showEvidenceModal, setShowEvidenceModal] = useState(false)
  const [transitionAction, setTransitionAction] = useState<
    'open' | 'close' | 'archive' | null
  >(null)

  const head = data?.cycle.head

  const refresh = async () => {
    setReason('')
    setShowClosingModal(false)
    setShowGuidanceModal(false)
    setShowEvidenceModal(false)
    setTransitionAction(null)
    await queryClient.invalidateQueries({ queryKey: ['admin-cycle', id] })
    await queryClient.invalidateQueries({ queryKey: ['admin-cycles'] })
    await queryClient.invalidateQueries({ queryKey: ['cycles'] })
  }

  const transition = useMutation({
    mutationFn: async (action: 'open' | 'close' | 'archive') => {
      const input = { id, expectedVersion: head?.currentVersion ?? 0, reason }
      if (action === 'open') {
        const result = await gql(OpenCycleDocument, { input })
        return unwrap(result.admin.programmeCycle.open)
      }
      if (action === 'close') {
        const result = await gql(CloseCycleDocument, { input })
        return unwrap(result.admin.programmeCycle.close)
      }
      const result = await gql(ArchiveCycleDocument, { input })
      return unwrap(result.admin.programmeCycle.archive)
    },
    onSuccess: refresh,
  })

  const changeClosing = useMutation({
    mutationFn: async () => {
      const result = await gql(ChangeCycleClosingDocument, {
        input: {
          id,
          expectedVersion: head?.currentVersion ?? 0,
          closesAt: new Date(closesAt).toISOString(),
          reason,
        },
      })
      return unwrap(result.admin.programmeCycle.changeClosingTime)
    },
    onSuccess: async () => {
      setClosesAt('')
      await refresh()
    },
  })

  const changeGuidance = useMutation({
    mutationFn: async () => {
      const result = await gql(UpdateCycleGuidanceDocument, {
        input: {
          id,
          expectedVersion: head?.currentVersion ?? 0,
          applicantGuidance: guidance ?? '',
          partnerBankGuidance: head?.partnerBankGuidance ?? '',
          reason,
        },
      })
      return unwrap(result.admin.programmeCycle.updateOpenGuidance)
    },
    onSuccess: async () => {
      setGuidance(null)
      await refresh()
    },
  })

  if (!data || !head) return null

  const busy = transition.isPending || changeClosing.isPending || changeGuidance.isPending
  const error = transition.error ?? changeClosing.error ?? changeGuidance.error
  const canAct = reason.trim().length > 0 && !busy

  // Lifecycle stage helpers
  const isOpen = head.status === 'OPEN'
  const isClosed = head.status === 'CLOSED'
  const isArchived = head.status === 'ARCHIVED'
  const isDraft = head.status === 'DRAFT'

  return (
    <main className={styles.pageWrap}>
      {/* Top Header */}
      <div className={styles.headerRow}>
        <div className={styles.headerLeft}>
          <div className={styles.cycleIconBadge}>
            <Calendar size={24} aria-hidden="true" />
          </div>
          <div className={styles.headerTextGroup}>
            <div className={styles.titleRow}>
              <h1 className={styles.cycleTitle}>{head.displayName}</h1>
              <span
                className={styles.statusBadge}
                data-tone={head.status.toLowerCase()}
              >
                <span className={styles.statusDot} />
                {humanize(head.status)}
              </span>
            </div>
            <p className={styles.cycleMeta}>
              {head.cycleCode} · programme year {head.cycleYear}
            </p>
            <p className={styles.cycleDescription}>
              The policy applications in this programme year are judged by. Opening it
              publishes the cycle and freezes these rules into every application started
              while it is open.
            </p>
          </div>
        </div>

        <Link to="/admin/cycles" className={styles.backButton}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back to cycles
        </Link>
      </div>

      {error ? (
        <p className="notice" data-tone="error" role="alert" style={{ margin: 0 }}>
          {messageFor(error)}
        </p>
      ) : null}

      {/* Main Two-Column Layout */}
      <div className={styles.detailsGrid}>
        {/* Left Column */}
        <div className={styles.leftColumn}>
          {/* 1. Guidance shown to applicants Card */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Guidance shown to applicants</h2>
              <button
                type="button"
                className={styles.outlineActionButton}
                onClick={() => {
                  setGuidance(head.applicantGuidance ?? '')
                  setReason('')
                  setShowGuidanceModal(true)
                }}
              >
                Update guidance
              </button>
            </div>
            <div className={styles.guidanceBody}>
              <GuidanceIllustration />
              <div className={styles.guidanceTextWrap}>
                {head.applicantGuidance ? (
                  <p className={styles.guidanceText}>{head.applicantGuidance}</p>
                ) : (
                  <>
                    <div className={styles.guidancePlaceholderLine} style={{ width: '85%' }} />
                    <div className={styles.guidancePlaceholderLine} style={{ width: '95%' }} />
                    <div className={styles.guidancePlaceholderLine} style={{ width: '70%' }} />
                    <div className={styles.guidancePlaceholderLine} style={{ width: '40%' }} />
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 2. Applications in this cycle Card */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Applications in this cycle</h2>
            </div>
            {data.counts.length > 0 ? (
              <div className={styles.countsList}>
                {data.counts.map((count) => {
                  const isReview = count.status.includes('REVIEW')
                  const isBank = count.status.includes('BANK')
                  const type = isReview ? 'review' : isBank ? 'bank' : 'submitted'
                  const Icon = isReview ? Search : FileText

                  return (
                    <div key={count.status} className={styles.countRow}>
                      <div className={styles.countLeft}>
                        <div className={styles.countIconBadge} data-type={type}>
                          <Icon size={16} aria-hidden="true" />
                        </div>
                        <span className={styles.countLabel}>{humanize(count.status)}</span>
                      </div>
                      <span className={styles.countValue}>{count.count}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: '13px' }}>
                No applications have been started in this cycle yet.
              </p>
            )}
          </div>

          {/* 3. History Card */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>History</h2>
            </div>
            {data.events.length > 0 ? (
              <div className={styles.timeline}>
                {data.events.map((event, idx) => (
                  <div key={event.id} className={styles.timelineItem}>
                    <div className={styles.timelineDot} />
                    {idx < data.events.length - 1 ? (
                      <div className={styles.timelineLine} />
                    ) : null}
                    <div className={styles.timelineHeader}>
                      <span className={styles.timelineDate}>
                        {formatDateTime(event.createdAt)}
                      </span>
                      <span className={styles.timelineBadge}>
                        {humanize(event.eventType)}
                      </span>
                    </div>
                    {event.message ? (
                      <p className={styles.timelineDesc}>{event.message}</p>
                    ) : (
                      <p className={styles.timelineDesc}>
                        This programme cycle event was recorded.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: '13px' }}>
                No history has been recorded yet.
              </p>
            )}
          </div>
        </div>

        {/* Right Column */}
        <div className={styles.rightColumn}>
          {/* 1. Lifecycle Card */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Lifecycle</h2>
            </div>

            {/* Stepper */}
            <div className={styles.lifecycleStepper}>
              <div className={styles.stepperTrack}>
                <div
                  className={styles.stepConnector}
                  style={{
                    background: isArchived
                      ? '#16a34a'
                      : isClosed
                        ? 'linear-gradient(to right, #16a34a 66%, #e2e8f0 66%)'
                        : isOpen
                          ? 'linear-gradient(to right, #16a34a 33%, #e2e8f0 33%)'
                          : '#e2e8f0',
                  }}
                />

                {/* Step 1: Open */}
                <div
                  className={styles.lifecycleStep}
                  data-state={isOpen || isClosed || isArchived ? 'done' : isDraft ? 'current' : 'future'}
                >
                  <div className={styles.stepCircle}>
                    {isOpen || isClosed || isArchived ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <span>1</span>
                    )}
                  </div>
                  <span className={styles.stepLabel}>Open</span>
                  <span className={styles.stepDate}>{formatDate(head.opensAt)}</span>
                </div>

                {/* Step 2: Close to new applications */}
                <div
                  className={styles.lifecycleStep}
                  data-state={isClosed || isArchived ? 'done' : isOpen ? 'current' : 'future'}
                >
                  <div className={styles.stepCircle}>
                    {isClosed || isArchived ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <Clock size={14} aria-hidden="true" />
                    )}
                  </div>
                  <span className={styles.stepLabel}>Close to new applications</span>
                  <span className={styles.stepDate}>{formatDate(head.closesAt)}</span>
                </div>

                {/* Step 3: Closed */}
                <div
                  className={styles.lifecycleStep}
                  data-state={isArchived ? 'done' : isClosed ? 'current' : 'future'}
                >
                  <div className={styles.stepCircle}>
                    <Lock size={13} aria-hidden="true" />
                  </div>
                  <span className={styles.stepLabel}>Closed</span>
                </div>

                {/* Step 4: Archived */}
                <div
                  className={styles.lifecycleStep}
                  data-state={isArchived ? 'done' : 'future'}
                >
                  <div className={styles.stepCircle}>
                    <Archive size={13} aria-hidden="true" />
                  </div>
                  <span className={styles.stepLabel}>Archived</span>
                </div>
              </div>
            </div>

            {/* Lifecycle Action Bar */}
            {isOpen ? (
              <div className={styles.actionBanner}>
                <div className={styles.actionBannerLeft}>
                  <Clock size={16} aria-hidden="true" />
                  <span>Move the closing time</span>
                </div>
                <button
                  type="button"
                  className={styles.outlineActionButton}
                  onClick={() => {
                    setClosesAt(head.closesAt ? new Date(head.closesAt).toISOString().slice(0, 16) : '')
                    setReason('')
                    setShowClosingModal(true)
                  }}
                >
                  Change closing time
                </button>
              </div>
            ) : isDraft ? (
              <div className={styles.actionBanner}>
                <div className={styles.actionBannerLeft}>
                  <span>Draft cycle ready to open</span>
                </div>
                <button
                  type="button"
                  className={styles.outlineActionButton}
                  onClick={() => {
                    setReason('')
                    setTransitionAction('open')
                  }}
                >
                  Open for applications
                </button>
              </div>
            ) : isClosed ? (
              <div className={styles.actionBanner}>
                <div className={styles.actionBannerLeft}>
                  <span>Closed cycle ready to archive</span>
                </div>
                <button
                  type="button"
                  className={styles.outlineActionButton}
                  onClick={() => {
                    setReason('')
                    setTransitionAction('archive')
                  }}
                >
                  Archive cycle
                </button>
              </div>
            ) : null}
          </div>

          {/* 2. Policy frozen into this cycle Card */}
          <div className={styles.card} {...mark('cycle-frozen')}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>
                <div className={styles.policyIconBadge}>
                  <ShieldCheck size={18} aria-hidden="true" />
                </div>
                Policy frozen into this cycle
                <Explain label="this policy" opener="What freezing a cycle's policy means">
                  {OFFICE_HELP.frozenPolicy}
                </Explain>
              </h2>
            </div>

            <table className={styles.policyTable}>
              <tbody>
                {/* Applications open */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Calendar size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Applications open</span>
                  </td>
                  <td className={styles.policyValueCell}>{formatDate(head.opensAt)}</td>
                </tr>

                {/* Applications close */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Calendar size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Applications close</span>
                  </td>
                  <td className={styles.policyValueCell}>{formatDate(head.closesAt)}</td>
                </tr>

                {/* Policy reference */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <FileText size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Policy reference</span>
                  </td>
                  <td className={styles.policyValueCell}>{head.policyReference ?? '—'}</td>
                </tr>

                {/* Version */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Tag size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Version</span>
                  </td>
                  <td className={styles.policyValueCell}>{head.currentVersion}</td>
                </tr>

                {/* Required evidence */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell} style={{ verticalAlign: 'middle' }}>
                    <div className={styles.policyIconBadge}>
                      <Folder size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Required evidence</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {data.cycle.documentRules.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <button
                          type="button"
                          className={styles.outlineActionButton}
                          onClick={() => setShowEvidenceModal(true)}
                        >
                          <Folder size={14} aria-hidden="true" />
                          <span>View required evidence ({data.cycle.documentRules.length})</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>

                {/* Assessments an expansion must pass */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell} style={{ verticalAlign: 'middle' }}>
                    <div className={styles.policyIconBadge}>
                      <ShieldCheck size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>
                      Assessments an expansion must pass
                    </span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {data.cycle.assessmentRules.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      <div className={styles.assessmentPillsWrap}>
                        {data.cycle.assessmentRules.map((rule) => (
                          <span
                            key={rule.assessmentType}
                            className={styles.assessmentPill}
                          >
                            <CheckCircle2
                              size={15}
                              className={styles.assessmentCheckIcon}
                              aria-hidden="true"
                            />
                            <span>{humanize(rule.assessmentType)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>

                {/* Approved reasons */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <BadgeCheck size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Approved reasons</span>
                  </td>
                  <td className={styles.policyValueCell}>{data.cycle.reasons.length}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Modal: Change Closing Time */}
      {showClosingModal && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalDialog}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Change closing time</h3>
              <button
                type="button"
                className={styles.modalCloseButton}
                onClick={() => setShowClosingModal(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.modalBody}>
              <div>
                <label className="field-label" htmlFor="newClosesAt">
                  New closing time
                </label>
                <input
                  id="newClosesAt"
                  className="input"
                  type="datetime-local"
                  value={closesAt}
                  onChange={(event) => setClosesAt(event.target.value)}
                />
              </div>

              <div>
                <label className="field-label" htmlFor="closingReason">
                  Reason for this change
                </label>
                <input
                  id="closingReason"
                  className="input"
                  placeholder="Retained in the cycle's history"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className="button"
                onClick={() => setShowClosingModal(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={!canAct || !closesAt}
                onClick={() => changeClosing.mutate()}
              >
                {changeClosing.isPending ? 'Updating…' : 'Change closing time'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Update Guidance */}
      {showGuidanceModal && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalDialog}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Update guidance shown to applicants</h3>
              <button
                type="button"
                className={styles.modalCloseButton}
                onClick={() => setShowGuidanceModal(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.modalBody}>
              <div>
                <label className="field-label" htmlFor="modalGuidance">
                  Guidance text
                </label>
                <textarea
                  id="modalGuidance"
                  className="textarea"
                  rows={4}
                  value={guidance ?? ''}
                  onChange={(event) => setGuidance(event.target.value)}
                />
              </div>

              <div>
                <label className="field-label" htmlFor="guidanceReason">
                  Reason for this change
                </label>
                <input
                  id="guidanceReason"
                  className="input"
                  placeholder="Retained in the cycle's history"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className="button"
                onClick={() => setShowGuidanceModal(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={!canAct || guidance === null}
                onClick={() => changeGuidance.mutate()}
              >
                {changeGuidance.isPending ? 'Updating…' : 'Save guidance'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Transition Action Confirmation (Open / Close / Archive) */}
      {transitionAction && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalDialog}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>
                {transitionAction === 'open'
                  ? 'Open programme cycle'
                  : transitionAction === 'close'
                    ? 'Close programme cycle'
                    : 'Archive programme cycle'}
              </h3>
              <button
                type="button"
                className={styles.modalCloseButton}
                onClick={() => setTransitionAction(null)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.modalBody}>
              <p style={{ margin: 0, fontSize: '13.5px', color: '#475569' }}>
                {transitionAction === 'open'
                  ? 'Opening publishes this cycle and freezes its rules into every application started while it is open.'
                  : transitionAction === 'close'
                    ? 'Closing prevents new applications from being created in this cycle.'
                    : 'Archiving a cycle is final. Its applications will retain their history.'}
              </p>
              <div>
                <label className="field-label" htmlFor="transitionReason">
                  Reason for this action
                </label>
                <input
                  id="transitionReason"
                  className="input"
                  placeholder="Retained in the cycle's history"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className="button"
                onClick={() => setTransitionAction(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={!canAct}
                onClick={() => transition.mutate(transitionAction)}
              >
                {transition.isPending ? 'Updating…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Required Evidence Rules */}
      {showEvidenceModal && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalDialog}>
            <div className={styles.modalHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div className={styles.policyIconBadge}>
                  <Folder size={18} aria-hidden="true" />
                </div>
                <div>
                  <h3 className={styles.modalTitle}>Required evidence</h3>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#64748b' }}>
                    {data.cycle.documentRules.length} document rules enforced in this cycle
                  </p>
                </div>
              </div>
              <button
                type="button"
                className={styles.modalCloseButton}
                onClick={() => setShowEvidenceModal(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.evidenceList}>
                {data.cycle.documentRules.map((rule) => {
                  const isAlways = rule.condition === 'ALWAYS'
                  return (
                    <div key={rule.documentType} className={styles.evidenceItem}>
                      <div className={styles.evidenceItemLeft}>
                        <FileText size={16} className={styles.evidenceDocIcon} aria-hidden="true" />
                        <span className={styles.evidenceDocName}>{humanize(rule.documentType)}</span>
                      </div>
                      <span
                        className={styles.evidenceConditionBadge}
                        data-tone={isAlways ? 'always' : 'conditional'}
                      >
                        <span
                          className={styles.pillDot}
                          data-tone={isAlways ? 'blue' : 'purple'}
                        />
                        {humanize(rule.condition)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className="button"
                onClick={() => setShowEvidenceModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
