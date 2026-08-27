import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  Archive,
  ArrowLeft,
  BadgeCheck,
  Banknote,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  FileText,
  Hourglass,
  Lock,
  MapPin,
  Scale,
  Search,
  ShieldCheck,
  Tag,
  Users,
  X,
} from 'lucide-react'
import {
  AdminCycleByIdDocument,
  ArchiveCycleDocument,
  ChangeCycleClosingDocument,
  CloseCycleDocument,
  OpenCycleDocument,
  SoftDeleteCycleDraftDocument,
  UpdateCycleDraftDocument,
  UpdateCycleGuidanceDocument,
} from '#/graphql/generated/operations'
import type { ProgrammeCycleInput } from '#/graphql/generated/schema'
import { formatDate, formatDateTime, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { can } from '#/lib/session'
import { CycleForm } from '#/features/admin/CycleForm'
import { toTemplateInput } from '#/features/admin/formAuthoring'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { OFFICE_LEDES } from '#/features/admin/officeGuidance'
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
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data } = useQuery(cycleQuery(id))

  const [reason, setReason] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const [guidance, setGuidance] = useState<string | null>(null)

  // Modal Dialog States. Removal shares the transition dialog because it takes
  // the same shape — a version guard and a retained reason.
  const [showClosingModal, setShowClosingModal] = useState(false)
  const [showGuidanceModal, setShowGuidanceModal] = useState(false)
  const [transitionAction, setTransitionAction] = useState<
    'open' | 'close' | 'archive' | 'remove' | null
  >(null)

  const head = data?.cycle.head
  const policy = data?.cycle.policy
  const template = data?.cycle.formTemplate ?? null

  /*
   * Refetches, and only refetches. It used to close every modal too — so a
   * refusal wired through it closed the dialog mid-error, and the message
   * landed at the page top where the overlay had been. Success closes its
   * own modal with `settle`; failure keeps it open with the refusal inside.
   */
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-cycle', id] })
    // The authoring screen quotes the version it read, so its copy is stale
    // the moment a rule change bumps it here.
    await queryClient.invalidateQueries({ queryKey: ['admin-cycle-form', id] })
    await queryClient.invalidateQueries({ queryKey: ['admin-cycles'] })
    // The applicant-facing cycle lists change the moment a cycle opens or
    // closes, so they are refreshed here rather than left stale.
    await queryClient.invalidateQueries({ queryKey: ['cycles'] })
  }

  /**
   * Every lifecycle transition takes the same shape: the expected version and a
   * retained reason. One mutation covers them so a new transition cannot
   * accidentally skip either.
   */
  const settle = async () => {
    await refresh()
    setReason('')
    setShowClosingModal(false)
    setShowGuidanceModal(false)
    setTransitionAction(null)
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
    onSuccess: settle,
    // A refusal usually means the version moved — an edit on the form screen
    // is a revision too. Refetch so the next attempt quotes the fresh one,
    // while the dialog stays to show the refusal.
    onError: refresh,
  })

  const changeClosing = useMutation({
    // Null removes the closing time: the cycle takes applications until the
    // office closes it.
    mutationFn: async (nextClosesAt: string | null) => {
      const result = await gql(ChangeCycleClosingDocument, {
        input: {
          id,
          expectedVersion: head?.currentVersion ?? 0,
          closesAt: nextClosesAt,
          reason,
        },
      })
      return unwrap(result.admin.programmeCycle.changeClosingTime)
    },
    onSuccess: async () => {
      setClosesAt('')
      await settle()
    },
    onError: refresh,
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
      await settle()
    },
    onError: refresh,
  })

  /**
   * Replaces the whole rule set of a draft — the only way a cycle's rules
   * change at all, since an open cycle admits nothing but guidance and the
   * closing time. The form below is populated from what the cycle actually
   * holds, so saving cannot silently reset a rule to a client default.
   */
  const changeDraft = useMutation({
    mutationFn: async (cycle: ProgrammeCycleInput) => {
      const result = await gql(UpdateCycleDraftDocument, {
        input: { id, expectedVersion: head?.currentVersion ?? 0, reason, cycle },
      })
      return unwrap(result.admin.programmeCycle.updateDraft)
    },
    onSuccess: settle,
    onError: refresh,
  })

  const removeDraft = useMutation({
    mutationFn: async () => {
      const result = await gql(SoftDeleteCycleDraftDocument, {
        input: { id, expectedVersion: head?.currentVersion ?? 0, reason },
      })
      return unwrap(result.admin.programmeCycle.softDeleteDraft)
    },
    onSuccess: async () => {
      await settle()
      // The draft is out of the default listing now, so the list — which can
      // still show it under "Include removed drafts" — is the honest place to be.
      await router.navigate({ to: '/admin/cycles' })
    },
    onError: refresh,
  })

  if (!data || !head || !policy) return null

  const busy =
    transition.isPending ||
    changeClosing.isPending ||
    changeGuidance.isPending ||
    changeDraft.isPending ||
    removeDraft.isPending
  const error =
    transition.error ??
    changeClosing.error ??
    changeGuidance.error ??
    changeDraft.error ??
    removeDraft.error
  // Every transition needs a retained reason, so the buttons stay disabled
  // until one is written rather than failing after the click.
  const canAct = reason.trim().length > 0 && !busy

  // Lifecycle stage helpers
  const isOpen = head.status === 'OPEN'
  const isClosed = head.status === 'CLOSED'
  const isArchived = head.status === 'ARCHIVED'
  const isDraft = head.status === 'DRAFT'

  /*
   * The draft's rules, exactly as this cycle version holds them, in the shape
   * `updateDraft` takes back. Built from the aggregate rather than from any
   * client default — resending defaults is how a settled rule gets reset by
   * somebody changing something else. The template is rebuilt in authoring
   * form (structure members stripped, definitions carried) because the read
   * returns the expanded one.
   */
  const draftRules: ProgrammeCycleInput | null =
    isDraft && template && can(user, 'CYCLE_ADMIN')
      ? {
          cycleCode: head.cycleCode,
          displayName: head.displayName,
          cycleYear: head.cycleYear,
          policyReference: head.policyReference,
          applicantGuidance: head.applicantGuidance,
          partnerBankGuidance: head.partnerBankGuidance,
          opensAt: head.opensAt,
          closesAt: head.closesAt,
          policy: {
            minimumApplicantAge: policy.minimumApplicantAge,
            maximumApplicantAge: policy.maximumApplicantAge,
            categoryAMaximumMonths: policy.categoryAMaximumMonths,
            expansionWaitMonths: policy.expansionWaitMonths,
            majorityOwnershipRequired: policy.majorityOwnershipRequired,
            jurisdiction: policy.jurisdiction,
            fundingCeilingState: policy.fundingCeilingState,
            fundingCeilingAmountPaise: policy.fundingCeilingAmountPaise,
            fundingCeilingScope: policy.fundingCeilingScope,
            requiredAssessmentTypes: data.cycle.assessmentRules.map(
              (rule) => rule.assessmentType,
            ),
            formTemplate: toTemplateInput(template, data.cycle.groupDefinitions),
            identifierRules: data.cycle.identifierRules.map(
              ({ kind, requirement, duplicatePolicy, checkType }) => ({
                kind,
                requirement,
                duplicatePolicy,
                checkType,
              }),
            ),
            reasons: data.cycle.reasons.map(
              ({ context, code, label, applicantMessageTemplate }) => ({
                context,
                code,
                label,
                applicantMessageTemplate,
              }),
            ),
          },
        }
      : null

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
              <span className={styles.statusBadge} data-tone={head.status.toLowerCase()}>
                <span className={styles.statusDot} />
                {humanize(head.status)}
              </span>
            </div>
            <p className={styles.cycleMeta}>
              {head.cycleCode} · programme year {head.cycleYear}
            </p>
            <p className={styles.cycleDescription}>{OFFICE_LEDES.cycle}</p>
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
              {/* Guidance changes go through `updateOpenGuidance`, which the
                  API accepts only while the cycle is open — a draft's guidance
                  is edited with the rest of its rules below. */}
              {isOpen ? (
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
              ) : null}
            </div>
            <div className={styles.guidanceBody}>
              <GuidanceIllustration />
              <div className={styles.guidanceTextWrap}>
                {head.applicantGuidance ? (
                  <p className={styles.guidanceText}>{head.applicantGuidance}</p>
                ) : (
                  <>
                    <div
                      className={styles.guidancePlaceholderLine}
                      style={{ width: '85%' }}
                    />
                    <div
                      className={styles.guidancePlaceholderLine}
                      style={{ width: '95%' }}
                    />
                    <div
                      className={styles.guidancePlaceholderLine}
                      style={{ width: '70%' }}
                    />
                    <div
                      className={styles.guidancePlaceholderLine}
                      style={{ width: '40%' }}
                    />
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
                        <span className={styles.countLabel}>
                          {humanize(count.status)}
                        </span>
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
              /* Events record lifecycle transitions — opening, closing, a
                 guidance change — so a draft that has never moved has none. */
              <p className="muted" style={{ margin: 0, fontSize: '13px' }}>
                No lifecycle events yet. The first appears when this cycle is opened;
                every change after that is recorded here with its reason.
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
                  data-state={
                    isOpen || isClosed || isArchived
                      ? 'done'
                      : isDraft
                        ? 'current'
                        : 'future'
                  }
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
                  data-state={
                    isClosed || isArchived ? 'done' : isOpen ? 'current' : 'future'
                  }
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

            {/* Lifecycle Action Bars. Only the transitions the current state
                actually permits are offered: a draft opens (or is removed); an
                open cycle closes or moves its closing time; a closed cycle is
                archived. */}
            {isOpen ? (
              <>
                <div className={styles.actionBanner}>
                  <div className={styles.actionBannerLeft}>
                    <Clock size={16} aria-hidden="true" />
                    <span>Move the closing time</span>
                  </div>
                  <button
                    type="button"
                    className={styles.outlineActionButton}
                    onClick={() => {
                      setClosesAt(
                        head.closesAt
                          ? new Date(head.closesAt).toISOString().slice(0, 16)
                          : '',
                      )
                      setReason('')
                      setShowClosingModal(true)
                    }}
                  >
                    Change closing time
                  </button>
                </div>
                <div className={styles.actionBanner}>
                  <div className={styles.actionBannerLeft}>
                    <Lock size={16} aria-hidden="true" />
                    <span>Stop taking applications</span>
                  </div>
                  <button
                    type="button"
                    className={styles.outlineActionButton}
                    onClick={() => {
                      setReason('')
                      setTransitionAction('close')
                    }}
                  >
                    Close to new applications
                  </button>
                </div>
              </>
            ) : isDraft ? (
              <>
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
                {/*
                 * Reversible, and only ever possible here: a cycle that has
                 * been opened is part of the programme's record and the API
                 * refuses to remove it. Restoring happens from the list,
                 * under "Include removed drafts".
                 */}
                <div className={styles.actionBanner}>
                  <div className={styles.actionBannerLeft}>
                    <span>Not needed after all?</span>
                  </div>
                  <button
                    type="button"
                    className={styles.outlineActionButton}
                    onClick={() => {
                      setReason('')
                      setTransitionAction('remove')
                    }}
                  >
                    Remove this draft
                  </button>
                </div>
              </>
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
                <Explain
                  label="this policy"
                  opener="What freezing a cycle's policy means"
                >
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
                  <td className={styles.policyValueCell}>
                    {head.closesAt ? formatDate(head.closesAt) : 'Open until closed by the office'}
                  </td>
                </tr>

                {/* Policy reference */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <FileText size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Policy reference</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {head.policyReference ?? '—'}
                  </td>
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

                {/*
                 * The eligibility rules as this cycle holds them. They could be
                 * written and not read until the admin schema returned them, so
                 * the only way to see what a cycle enforced was to apply to it.
                 */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Users size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Applicant age</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {policy.minimumApplicantAge === null &&
                    policy.maximumApplicantAge === null
                      ? 'Any'
                      : `${policy.minimumApplicantAge ?? 'any'} to ${
                          policy.maximumApplicantAge ?? 'any'
                        }`}
                  </td>
                </tr>

                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Clock size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Category A up to</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {policy.categoryAMaximumMonths === null
                      ? 'Not set'
                      : `${policy.categoryAMaximumMonths} months of trading`}
                  </td>
                </tr>

                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Hourglass size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Wait before an expansion</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {policy.expansionWaitMonths === null
                      ? 'None'
                      : `${policy.expansionWaitMonths} months`}
                  </td>
                </tr>

                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Scale size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Majority ownership</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {policy.majorityOwnershipRequired
                      ? 'Must be confirmed'
                      : 'Not required'}
                  </td>
                </tr>

                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <MapPin size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Jurisdiction</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {humanize(policy.jurisdiction ?? '—')}
                  </td>
                </tr>

                {/*
                 * `UNRESOLVED` is a real state rather than a missing one — no
                 * amount is checked against a ceiling nobody has approved — so it
                 * is shown in those words rather than as a blank.
                 */}
                <tr className={styles.policyRow}>
                  <td className={styles.policyKeyCell}>
                    <div className={styles.policyIconBadge}>
                      <Banknote size={18} aria-hidden="true" />
                    </div>
                    <span className={styles.policyKeyText}>Funding ceiling</span>
                  </td>
                  <td className={styles.policyValueCell}>
                    {policy.fundingCeilingState === 'RESOLVED'
                      ? `${formatMoney(policy.fundingCeilingAmountPaise)} per ${humanize(
                          policy.fundingCeilingScope ?? '',
                        ).toLowerCase()}`
                      : 'Not settled, so no amount is checked against one'}
                  </td>
                </tr>

                {/* Assessments an expansion must pass */}
                <tr className={styles.policyRow}>
                  <td
                    className={styles.policyKeyCell}
                    style={{ verticalAlign: 'middle' }}
                  >
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

      {/*
       * What this cycle asks, stage by stage — read-only here, with the
       * door to the editor beside it. The editor is offered only to the
       * capability the API gates it on, and only while the cycle is a
       * draft, because that is the only time the API will accept a change.
       */}
      {template ? (
        <div className={styles.card} {...mark('cycle-questions')}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Questions this cycle asks</h2>
            {/* Any officer may look; the preview renders with the applicant's
                own components, so what it shows is what they get. */}
            <Link
              to="/admin/cycles/$id/preview"
              params={{ id }}
              className={styles.outlineActionButton}
            >
              View as an applicant
            </Link>
            {can(user, 'CYCLE_ADMIN') ? (
              isDraft ? (
                <Link
                  to="/admin/cycles/$id/form"
                  params={{ id }}
                  className={styles.outlineActionButton}
                >
                  Edit the form
                </Link>
              ) : (
                <span className="muted" style={{ fontSize: '13px' }}>
                  A cycle’s questions freeze once it opens.
                </span>
              )
            ) : null}
          </div>
          <div>
            {template.stages.map((stage) => {
              const asked = template.fields.filter(
                (field) => field.stageKey === stage.key && field.repeatGroupKey === null,
              )
              return (
                <section key={stage.key}>
                  <h3>{stage.title}</h3>
                  {stage.description ? (
                    <p className="muted">{stage.description}</p>
                  ) : null}
                  <ul>
                    {asked.map((field) => (
                      <li key={field.key}>
                        {field.label}
                        {' — '}
                        {humanize(field.type).toLowerCase()}
                        {field.requirement === 'REQUIRED' ? ', required' : null}
                        {field.requirement === 'CONDITIONAL'
                          ? ', required in some answers'
                          : null}
                        {field.role
                          ? `, read by the programme as ${humanize(field.role)}`
                          : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        </div>
      ) : null}

      {/*
       * The rules, editable while the cycle is a draft. The whole cycle
       * form, populated from what is stored — the same form creation uses —
       * folded away because reading a cycle is the common case and editing
       * its every rule is not.
       */}
      {draftRules ? (
        <div className={styles.card}>
          <details className="fieldset">
            <summary className="disclosure">
              <span className="eyebrow">Edit this draft’s rules</span>
              <span className="muted">
                Dates, eligibility, ceiling, identifiers and reasons — everything but the
                questions, which have their own editor above.
              </span>
            </summary>
            {/* Saving is a cycle revision, so it takes a retained reason like
                every lifecycle change on this page. */}
            <div style={{ margin: '0.75rem 0' }}>
              <label className="field-label" htmlFor="draftReason">
                Reason for this change
              </label>
              <input
                id="draftReason"
                className="input"
                placeholder="Retained in the cycle's history"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <CycleForm
              // Remounted per version so a save shows back what the server
              // now holds rather than the working copy it was opened with.
              key={head.currentVersion}
              initial={draftRules}
              submitLabel="Save the draft’s rules"
              busy={changeDraft.isPending}
              onSubmit={(values) => changeDraft.mutate(values)}
            />
          </details>
        </div>
      ) : null}

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
              {changeClosing.error ? (
                <p className="notice" data-tone="error" role="alert" style={{ margin: 0 }}>
                  {messageFor(changeClosing.error)}
                </p>
              ) : null}
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
                disabled={!canAct}
                title="The cycle stays open until the office closes it."
                onClick={() => changeClosing.mutate(null)}
              >
                Remove the closing time
              </button>
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={!canAct || !closesAt}
                onClick={() => changeClosing.mutate(new Date(closesAt).toISOString())}
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

      {/* Modal: Transition Confirmation (Open / Close / Archive / Remove) */}
      {transitionAction && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalDialog}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>
                {transitionAction === 'open'
                  ? 'Open programme cycle'
                  : transitionAction === 'close'
                    ? 'Close programme cycle'
                    : transitionAction === 'archive'
                      ? 'Archive programme cycle'
                      : 'Remove this draft'}
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
                    : transitionAction === 'archive'
                      ? 'Archiving a cycle is final. Its applications will retain their history.'
                      : 'Removing takes this draft out of every default view. It can be restored from the list under "Include removed drafts".'}
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
              {/* The refusal belongs where the click happened — rendered only
                  at the page top, it hid behind this very overlay. */}
              {transition.error || removeDraft.error ? (
                <p className="notice" data-tone="error" role="alert" style={{ margin: 0 }}>
                  {messageFor(transition.error ?? removeDraft.error)}
                </p>
              ) : null}
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
                onClick={() =>
                  transitionAction === 'remove'
                    ? removeDraft.mutate()
                    : transition.mutate(transitionAction)
                }
              >
                {transition.isPending || removeDraft.isPending ? 'Updating…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
