/**
 * The route a file takes.
 *
 * Every status the programme has, placed under the desk that holds the file at
 * that moment, in the order they happen.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Compass,
  FileCheck,
  FilePenLine,
  FileText,
  IndianRupee,
  Info,
  Inbox,
  Landmark,
  ListOrdered,
  Minus,
  Search,
  User,
  Users,
  X,
} from 'lucide-react'
import { statusGuideQuery } from '#/features/application/queries'
import type { ApplicationStatus } from '#/graphql/generated/schema'
import { useGuide } from './GuideContext'
import { STAGE_DETAILS, type StageDetail } from './stageDetails'
import { DESKS, TOURS, canWalk, type Desk } from './tours'
import type { Capability, UserRole } from '#/graphql/generated/schema'
import styles from './RouteDiagram.module.css'

export const ROUTE_LENGTH = STAGE_DETAILS.length

/*
 * The fourth column is the recorded decision. The committee module left the
 * product — decisions are the programme office's, recorded from the queue —
 * so the column is a stage of the route rather than a desk of its own.
 */
const DECISION_COLUMN = 'Decision' as const
type DiagramColumn = Desk | typeof DECISION_COLUMN

const DESK_COLUMNS: Array<{ desk: DiagramColumn; icon: typeof User }> = [
  { desk: DESKS.applicant, icon: User },
  { desk: DESKS.office, icon: Building2 },
  { desk: DESKS.bank, icon: Landmark },
  { desk: DECISION_COLUMN, icon: Users },
]

function StageIcon({ id }: { id: ApplicationStatus }) {
  switch (id) {
    case 'DRAFT':
      return <FilePenLine size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'SUBMITTED':
      return <Inbox size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'DESK_REVIEW':
      return <Search size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'REVISION_REQUIRED':
      return <ArrowLeft size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'PARTNER_BANK_EVALUATION':
      return <Landmark size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'AWAITING_DECISION':
      return <Users size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'APPROVED':
      return <Check size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'SANCTIONED':
      return <FileCheck size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'DISBURSED':
      return <IndianRupee size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'REJECTED':
      return <X size={15} className={styles.stageCardIcon} aria-hidden="true" />
    case 'CANCELLED':
      return <Minus size={15} className={styles.stageCardIcon} aria-hidden="true" />
    default:
      return null
  }
}

function AboutIcon({
  icon,
}: {
  icon: 'check' | 'document' | 'clock' | 'rupee' | 'bank' | 'user' | 'alert'
}) {
  switch (icon) {
    case 'check':
      return <CheckCircle2 size={16} className={styles.aboutIcon} aria-hidden="true" />
    case 'document':
      return <FileText size={16} className={styles.aboutIcon} aria-hidden="true" />
    case 'clock':
      return <Clock size={16} className={styles.aboutIcon} aria-hidden="true" />
    case 'rupee':
      return <IndianRupee size={16} className={styles.aboutIcon} aria-hidden="true" />
    case 'bank':
      return <Landmark size={16} className={styles.aboutIcon} aria-hidden="true" />
    case 'user':
      return <User size={16} className={styles.aboutIcon} aria-hidden="true" />
    case 'alert':
      return <AlertTriangle size={16} className={styles.aboutIcon} aria-hidden="true" />
  }
}

function TourIllustration() {
  return (
    <div className={styles.tourAvatar} aria-hidden="true">
      <User size={22} className={styles.tourAvatarIcon} />
    </div>
  )
}

export function RouteDiagram({
  user,
}: {
  user?: { roles: readonly UserRole[]; capabilities: readonly Capability[] }
}) {
  const { data: guide } = useQuery(statusGuideQuery)
  const { start, tour: running } = useGuide()
  const [selectedStageIndex, setSelectedStageIndex] = useState<number | null>(null)

  // References for drawing SVG connectors
  const containerRef = useRef<HTMLDivElement>(null)
  const card01Ref = useRef<HTMLButtonElement>(null)
  const card02Ref = useRef<HTMLButtonElement>(null)
  const card03Ref = useRef<HTMLButtonElement>(null)
  const card04Ref = useRef<HTMLButtonElement>(null)
  const card05Ref = useRef<HTMLButtonElement>(null)
  const card06Ref = useRef<HTMLButtonElement>(null)
  const card07Ref = useRef<HTMLButtonElement>(null)

  const [paths, setPaths] = useState<{
    p01_02: string
    p03_04: string
    p03_05: string
    p05_06: string
    p06_07: string
  }>({
    p01_02: '',
    p03_04: '',
    p03_05: '',
    p05_06: '',
    p06_07: '',
  })

  const updateSvgConnectors = () => {
    if (!containerRef.current) return
    const containerRect = containerRef.current.getBoundingClientRect()

    const getBox = (el: HTMLElement | null) => {
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return {
        left: rect.left - containerRect.left,
        right: rect.right - containerRect.left,
        top: rect.top - containerRect.top,
        bottom: rect.bottom - containerRect.top,
        width: rect.width,
        height: rect.height,
        centerX: rect.left - containerRect.left + rect.width / 2,
        centerY: rect.top - containerRect.top + rect.height / 2,
      }
    }

    const b01 = getBox(card01Ref.current)
    const b02 = getBox(card02Ref.current)
    const b03 = getBox(card03Ref.current)
    const b04 = getBox(card04Ref.current)
    const b05 = getBox(card05Ref.current)
    const b06 = getBox(card06Ref.current)
    const b07 = getBox(card07Ref.current)

    if (b01 && b02 && b03 && b04 && b05 && b06 && b07) {
      // Row 1: 01 -> 02 (straight horizontal line right)
      const yRow1 = Math.round(b01.centerY)
      const p01_02 = `M ${b01.right} ${yRow1} L ${b02.left - 4} ${yRow1}`

      const r = 6

      // 03 -> 04: Dashed line from top-left of 03, turning 90 deg down into top of 04
      const x0 = b03.left
      const y0 = Math.round(b03.top + 16)
      const targetX = Math.round(b04.left + 36)
      const targetY = Math.round(b04.top - 2)
      const p03_04 = `M ${x0} ${y0} H ${targetX + r} A ${r} ${r} 0 0 0 ${targetX} ${y0 + r} V ${targetY}`

      // Row 2: 03 -> 05 (straight horizontal line right)
      const yRow2 = Math.round((b03.centerY + b05.centerY + b06.centerY) / 3)
      const p03_05 = `M ${b03.right} ${yRow2} L ${b05.left - 4} ${yRow2}`

      // Row 2: 05 -> 06 (straight horizontal line right)
      const p05_06 = `M ${b05.right} ${yRow2} L ${b06.left - 4} ${yRow2}`

      // 06 -> 07: Dashed return line from bottom of 06, down to 07 centerY, then straight left into 07
      const xReturn0 = Math.round(b06.centerX)
      const yReturn0 = Math.round(b06.bottom)
      const targetReturnX = Math.round(b07.right + 2)
      const targetReturnY = Math.round(b07.centerY)
      const p06_07 = `M ${xReturn0} ${yReturn0} V ${targetReturnY - r} A ${r} ${r} 0 0 1 ${xReturn0 - r} ${targetReturnY} H ${targetReturnX}`

      setPaths({
        p01_02,
        p03_04,
        p03_05,
        p05_06,
        p06_07,
      })
    }
  }

  useLayoutEffect(() => {
    updateSvgConnectors()

    if (!containerRef.current) return

    let rafId: number
    const triggerUpdate = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updateSvgConnectors)
    }

    const resizeObserver = new ResizeObserver(() => {
      triggerUpdate()
    })

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    const cardRefs = [
      card01Ref.current,
      card02Ref.current,
      card03Ref.current,
      card04Ref.current,
      card05Ref.current,
      card06Ref.current,
      card07Ref.current,
    ]

    for (const el of cardRefs) {
      if (el) resizeObserver.observe(el)
    }

    window.addEventListener('resize', triggerUpdate)
    window.addEventListener('transitionend', triggerUpdate)

    const mutationObserver = new MutationObserver(() => {
      triggerUpdate()
    })

    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-collapsed', 'class', 'style'],
      subtree: true,
    })

    return () => {
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', triggerUpdate)
      window.removeEventListener('transitionend', triggerUpdate)
    }
  }, [])

  const allowedTours = TOURS.filter((tour) => canWalk(tour, user))
  const mainTour = allowedTours[0]

  const activeStage: StageDetail | null =
    selectedStageIndex !== null ? STAGE_DETAILS[selectedStageIndex] ?? null : null

  // Keyboard navigation and escape to close drawer
  useEffect(() => {
    if (selectedStageIndex === null) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedStageIndex(null)
      } else if (e.key === 'ArrowRight' && selectedStageIndex < STAGE_DETAILS.length - 1) {
        setSelectedStageIndex((prev) => (prev !== null ? prev + 1 : null))
      } else if (e.key === 'ArrowLeft' && selectedStageIndex > 0) {
        setSelectedStageIndex((prev) => (prev !== null ? prev - 1 : null))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedStageIndex])

  // Map API guide explanations
  const apiGuides = new Map((guide ?? []).map((entry) => [entry.status, entry]))

  const stageByIndex = (index: number) => STAGE_DETAILS[index]

  return (
    <div className={styles.diagramWrapper}>
      <section className={styles.mainCard} aria-label="Route diagram">
        <div className={styles.cardTopHeader}>
          <div className={styles.cardTitleBlock}>
            <h2 className={styles.cardSectionTitle}>The route a file takes</h2>
            <p className={styles.cardSectionDesc}>
              Each stop sits under the desk holding the file, numbered in the order they
              happen. Where you can see it, the applicant&rsquo;s own wording is quoted
              beneath.
            </p>
          </div>

          <button
            type="button"
            className={styles.learnButton}
            onClick={() => setSelectedStageIndex(0)}
          >
            <Info size={15} aria-hidden="true" />
            <span>Learn how each state works</span>
          </button>
        </div>

        {/* 4 Swimlane Columns Grid with SVG Connector Layer */}
        <div className={styles.swimlanesContainer} ref={containerRef}>
          {/* SVG Connector Layer */}
          <svg className={styles.svgConnectorLayer} aria-hidden="true">
            <defs>
              {/* Solid arrow marker: points along path direction */}
              <marker
                id="arrow-solid"
                viewBox="0 0 10 10"
                refX="6"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#0f172a" />
              </marker>

              {/* Dashed line arrow marker: points along path direction */}
              <marker
                id="arrow-dashed"
                viewBox="0 0 10 10"
                refX="6"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#64748b" />
              </marker>
            </defs>

            {/* 01 -> 02 */}
            {paths.p01_02 ? (
              <path
                d={paths.p01_02}
                stroke="#0f172a"
                strokeWidth="1.5"
                fill="none"
                markerEnd="url(#arrow-solid)"
              />
            ) : null}

            {/* 03 -> 04 (dashed, curves down into 04) */}
            {paths.p03_04 ? (
              <path
                d={paths.p03_04}
                stroke="#64748b"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                fill="none"
                markerEnd="url(#arrow-dashed)"
              />
            ) : null}

            {/* 03 -> 05 */}
            {paths.p03_05 ? (
              <path
                d={paths.p03_05}
                stroke="#0f172a"
                strokeWidth="1.5"
                fill="none"
                markerEnd="url(#arrow-solid)"
              />
            ) : null}

            {/* 05 -> 06 */}
            {paths.p05_06 ? (
              <path
                d={paths.p05_06}
                stroke="#0f172a"
                strokeWidth="1.5"
                fill="none"
                markerEnd="url(#arrow-solid)"
              />
            ) : null}

            {/* 06 -> 07 (dashed return, curves left into 07) */}
            {paths.p06_07 ? (
              <path
                d={paths.p06_07}
                stroke="#64748b"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                fill="none"
                markerEnd="url(#arrow-dashed)"
              />
            ) : null}
          </svg>

          {DESK_COLUMNS.map(({ desk, icon: DeskIcon }) => {
            return (
              <div key={desk} className={styles.swimlaneColumn} data-desk={desk}>
                <div className={styles.columnHeader} data-desk={desk}>
                  <span className={styles.columnHeaderIcon}>
                    <DeskIcon size={16} aria-hidden="true" />
                  </span>
                  <span>{desk}</span>
                </div>

                {/* Column 1: Applicant */}
                {desk === DESKS.applicant ? (
                  <>
                    {/* Row 1 -> Stage 01: Draft */}
                    <button
                      ref={card01Ref}
                      type="button"
                      className={styles.stageCard}
                      data-active={selectedStageIndex === 0 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(0)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(0)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="DRAFT" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(0)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(0)?.shortDescription}
                      </p>
                    </button>

                    {/* Gap to position 04 lower down for the connector arrow */}
                    <div className={styles.gapCorrectionRow} />

                    {/* Row 2 -> Stage 04: Correction asked for */}
                    <button
                      ref={card04Ref}
                      type="button"
                      className={styles.stageCard}
                      data-active={selectedStageIndex === 3 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(3)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(3)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="REVISION_REQUIRED" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(3)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(3)?.shortDescription}
                      </p>
                    </button>
                  </>
                ) : null}

                {/* Column 2: Programme office */}
                {desk === DESKS.office ? (
                  <>
                    {/* Row 1 -> Stage 02: Submitted */}
                    <button
                      ref={card02Ref}
                      type="button"
                      className={styles.stageCard}
                      data-active={selectedStageIndex === 1 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(1)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(1)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="SUBMITTED" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(1)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(1)?.shortDescription}
                      </p>
                    </button>

                    <div className={styles.verticalArrowWrap}>
                      <ArrowDown size={14} aria-hidden="true" />
                    </div>

                    {/* Row 2 -> Stage 03: Desk review */}
                    <button
                      ref={card03Ref}
                      type="button"
                      className={styles.stageCard}
                      data-active={selectedStageIndex === 2 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(2)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(2)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="DESK_REVIEW" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(2)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(2)?.shortDescription}
                      </p>
                    </button>

                    <div className={styles.verticalArrowWrap}>
                      <ArrowDown size={14} aria-hidden="true" />
                    </div>

                    {/* Row 3 -> Stage 07: Approved */}
                    <button
                      ref={card07Ref}
                      type="button"
                      className={`${styles.stageCard} ${styles.stageCardCompact}`}
                      data-active={selectedStageIndex === 6 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(6)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(6)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="APPROVED" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(6)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(6)?.shortDescription}
                      </p>
                    </button>

                    <div className={styles.verticalArrowWrap}>
                      <ArrowDown size={14} aria-hidden="true" />
                    </div>

                    {/* Row 4 -> Stage 08: Sanctioned */}
                    <button
                      type="button"
                      className={`${styles.stageCard} ${styles.stageCardCompact}`}
                      data-active={selectedStageIndex === 7 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(7)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(7)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="SANCTIONED" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(7)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(7)?.shortDescription}
                      </p>
                    </button>

                    <div className={styles.verticalArrowWrap}>
                      <ArrowDown size={14} aria-hidden="true" />
                    </div>

                    {/* Row 5 -> Stage 09: Money released */}
                    <button
                      type="button"
                      className={`${styles.stageCard} ${styles.stageCardCompact}`}
                      data-active={selectedStageIndex === 8 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(8)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(8)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="DISBURSED" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(8)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(8)?.shortDescription}
                      </p>
                    </button>
                  </>
                ) : null}

                {/* Column 3: Partner bank */}
                {desk === DESKS.bank ? (
                  <>
                    <div className={styles.rowSpacer} />
                    <div className={styles.verticalArrowWrap} />

                    {/* Row 2 -> Stage 05: With a partner bank */}
                    <button
                      ref={card05Ref}
                      type="button"
                      className={styles.stageCard}
                      data-stage-type="bank"
                      data-active={selectedStageIndex === 4 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(4)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(4)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="PARTNER_BANK_EVALUATION" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(4)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(4)?.shortDescription}
                      </p>
                    </button>
                  </>
                ) : null}

                {/* Column 4: the recorded decision */}
                {desk === DECISION_COLUMN ? (
                  <>
                    <div className={styles.rowSpacer} />
                    <div className={styles.verticalArrowWrap} />

                    {/* Row 2 -> Stage 06: Before the committee */}
                    <button
                      ref={card06Ref}
                      type="button"
                      className={styles.stageCard}
                      data-stage-type="decision"
                      data-active={selectedStageIndex === 5 ? 'true' : undefined}
                      onClick={() => setSelectedStageIndex(5)}
                    >
                      <div className={styles.stageCardTop}>
                        <span className={styles.stageNumBadge}>
                          {stageByIndex(5)?.number}
                        </span>
                        <div className={styles.stageIconTitleRow}>
                          <StageIcon id="AWAITING_DECISION" />
                          <h3 className={styles.stageCardTitle}>
                            {stageByIndex(5)?.name}
                          </h3>
                        </div>
                      </div>
                      <p className={styles.stageCardDesc}>
                        {stageByIndex(5)?.shortDescription}
                      </p>
                    </button>
                  </>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>

      {/* Bottom Section: Alternative Endings & Guided Routes */}
      <div className={styles.bottomRow}>
        {/* Alternative Endings Card */}
        <section className={styles.alternativeEndingsCard} aria-label="Alternative endings">
          <div className={styles.altHeader}>
            <h3 className={styles.altTitle}>Alternative endings</h3>
            <p className={styles.altDesc}>
              These states close the application without funding.
            </p>
          </div>

          <div className={styles.altCardsList}>
            {/* Stage 10: Rejected */}
            <button
              type="button"
              className={styles.altCard}
              onClick={() => setSelectedStageIndex(9)}
            >
              <div className={styles.stageCardTop}>
                <span className={styles.stageNumBadge} data-ending="true">
                  {stageByIndex(9)?.number}
                </span>
                <div className={styles.stageIconTitleRow}>
                  <StageIcon id="REJECTED" />
                  <h4 className={styles.stageCardTitle}>{stageByIndex(9)?.name}</h4>
                </div>
              </div>
              <p className={styles.stageCardDesc}>
                {stageByIndex(9)?.shortDescription}
              </p>
            </button>

            {/* Stage 11: Cancelled */}
            <button
              type="button"
              className={styles.altCard}
              onClick={() => setSelectedStageIndex(10)}
            >
              <div className={styles.stageCardTop}>
                <span className={styles.stageNumBadge} data-ending="true">
                  {stageByIndex(10)?.number}
                </span>
                <div className={styles.stageIconTitleRow}>
                  <StageIcon id="CANCELLED" />
                  <h4 className={styles.stageCardTitle}>{stageByIndex(10)?.name}</h4>
                </div>
              </div>
              <p className={styles.stageCardDesc}>
                {stageByIndex(10)?.shortDescription}
              </p>
            </button>
          </div>
        </section>

        {/* Guided Routes Card */}
        <section className={styles.guidedRoutesCard} aria-label="Guided routes">
          <div className={styles.guidedHeader}>
            <h3 className={styles.guidedTitle}>
              <Compass size={17} className={styles.guidedTitleIcon} aria-hidden="true" />
              <span>Guided routes</span>
            </h3>
            <p className={styles.guidedDesc}>
              Each one walks the real screens with a note beside whatever is being discussed.
              You can leave at any point and carry on where you stopped.
            </p>
          </div>

          {mainTour ? (
            <div className={styles.tourItemCard}>
              <div className={styles.tourItemLeft}>
                <TourIllustration />
                <div className={styles.tourInfo}>
                  <h4 className={styles.tourItemTitle}>{mainTour.title}</h4>
                  <p className={styles.tourItemPromise}>{mainTour.promise}</p>
                  <div className={styles.tourItemMeta}>
                    <span className={styles.metaItem}>
                      <ListOrdered size={14} className={styles.metaIcon} aria-hidden="true" />
                      <span>{mainTour.steps.length} steps</span>
                    </span>
                    <span className={styles.metaDot}>·</span>
                    <span className={styles.metaItem}>
                      <User size={14} className={styles.metaIcon} aria-hidden="true" />
                      <span>{mainTour.audience}</span>
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                className={styles.walkButton}
                onClick={() => start(mainTour.id)}
              >
                <span>{running?.id === mainTour.id ? 'Start again' : 'Walk this route'}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {allowedTours.length < TOURS.length ? (
            <p className={styles.withheldNotice}>
              <Info size={14} aria-hidden="true" />
              <span>
                {TOURS.length - allowedTours.length === 1
                  ? '1 more route covers work this account cannot do. It appears once it holds the role.'
                  : `${TOURS.length - allowedTours.length} more routes cover work this account cannot do. They appear once it holds the role.`}
              </span>
            </p>
          ) : null}
        </section>
      </div>

      {/* Interactive Stage Details Drawer (Mockup 2) */}
      {activeStage !== null ? (
        <>
          <div
            className={styles.drawerBackdrop}
            onClick={() => setSelectedStageIndex(null)}
            aria-hidden="true"
          />
          <aside
            className={styles.stageDrawer}
            role="dialog"
            aria-modal="true"
            aria-label={`Stage details: ${activeStage.name}`}
          >
            <div className={styles.drawerHeader}>
              <span className={styles.drawerStageCountPill}>
                Stage {selectedStageIndex! + 1} of {STAGE_DETAILS.length}
              </span>
              <button
                type="button"
                className={styles.drawerCloseBtn}
                onClick={() => setSelectedStageIndex(null)}
                aria-label="Close details"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className={styles.drawerBody}>
              <div className={styles.drawerTitleGroup}>
                <span
                  className={styles.drawerStageBadge}
                  data-ending={
                    activeStage.id === 'REJECTED' || activeStage.id === 'CANCELLED'
                      ? 'true'
                      : undefined
                  }
                >
                  {activeStage.number}
                </span>
                <div className={styles.drawerTitleTexts}>
                  <h3 className={styles.drawerStageTitle}>{activeStage.name}</h3>
                  <p className={styles.drawerStageDesk}>{activeStage.desk}</p>
                </div>
              </div>

              <p className={styles.drawerFullDesc}>{activeStage.fullDescription}</p>

              {/* What the applicant sees Quote */}
              <div className={styles.applicantQuoteCard}>
                <h4 className={styles.quoteCardTitle}>What the applicant sees</h4>
                <div className={styles.quoteContent}>
                  <span className={styles.quoteGlyph} aria-hidden="true">
                    &ldquo;
                  </span>
                  <p className={styles.quoteText}>
                    {apiGuides.get(activeStage.id)?.explanation ??
                      activeStage.applicantQuote.text}
                  </p>
                </div>
                <div className={styles.waitingOnRow}>
                  <span>Waiting on</span>
                  <span className={styles.waitingOnBadge}>
                    {activeStage.desk}
                  </span>
                </div>
              </div>

              {/* About this stage */}
              <div className={styles.drawerSection}>
                <h4 className={styles.drawerSectionTitle}>About this stage</h4>
                <ul className={styles.aboutList}>
                  {activeStage.aboutStage.map((item) => (
                    <li key={item.text} className={styles.aboutItem}>
                      <AboutIcon icon={item.icon} />
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Key screens used by this desk */}
              <div className={styles.drawerSection}>
                <h4 className={styles.drawerSectionTitle}>Key screens used by this desk</h4>
                <ul className={styles.screensList}>
                  {activeStage.keyScreens.map((screen) => (
                    <li key={screen} className={styles.screenItem}>
                      {screen}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Sticky Drawer Navigation Footer */}
            <div className={styles.drawerFooter}>
              <button
                type="button"
                className={styles.drawerNavBtn}
                disabled={selectedStageIndex! <= 0}
                onClick={() => setSelectedStageIndex((prev) => (prev !== null ? prev - 1 : null))}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                <span>Previous stage</span>
              </button>

              <span className={styles.drawerNavCount}>
                {selectedStageIndex! + 1} of {STAGE_DETAILS.length}
              </span>

              <button
                type="button"
                className={styles.drawerNavBtn}
                data-primary="true"
                disabled={selectedStageIndex! >= STAGE_DETAILS.length - 1}
                onClick={() => setSelectedStageIndex((prev) => (prev !== null ? prev + 1 : null))}
              >
                <span>Next stage</span>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  )
}
