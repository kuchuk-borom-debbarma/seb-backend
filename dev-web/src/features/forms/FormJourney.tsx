/**
 * The shared frame for work that is safer to complete one category at a time.
 *
 * It owns presentation and navigation semantics only. Callers still decide
 * what makes a step complete, which steps may be opened, and what Back or Next
 * actually does, so no business rule is duplicated into the design system.
 */
import {
  Building2,
  Check,
  CheckSquare,
  FileSignature,
  FileText,
  IndianRupee,
  LockKeyhole,
  Paperclip,
  ReceiptIndianRupee,
  ShieldCheck,
  Users,
} from 'lucide-react'
import styles from './FormJourney.module.css'

export type JourneyStepStatus = 'available' | 'blocked' | 'complete' | 'error' | 'locked'

export type JourneyStep<TId extends string = string> = {
  id: TId
  label: string
  description: string
  status: JourneyStepStatus
  issueCount?: number
}

function CategoryIcon({
  id,
  label,
  size = 17,
  className,
}: {
  id: string
  label?: string
  size?: number
  className?: string
}) {
  const upper = id.toUpperCase()
  const lowerLabel = (label ?? '').toLowerCase()
  if (
    upper.includes('OWNER') ||
    lowerLabel.includes('owner') ||
    upper.includes('APPLICANT_PROFILE') ||
    lowerLabel.includes('applicant')
  ) {
    return <Users size={size} className={className} aria-hidden="true" />
  }
  if (
    upper.includes('FINANCIAL') ||
    upper.includes('COST') ||
    lowerLabel.includes('cost') ||
    lowerLabel.includes('funding') ||
    upper.includes('PROJECT')
  ) {
    return <IndianRupee size={size} className={className} aria-hidden="true" />
  }
  if (
    upper.includes('PRIOR') ||
    upper.includes('SUPPORT') ||
    upper.includes('CREDIT') ||
    lowerLabel.includes('support') ||
    lowerLabel.includes('credit')
  ) {
    return <ReceiptIndianRupee size={size} className={className} aria-hidden="true" />
  }
  if (
    upper.includes('ATTACH') ||
    upper.includes('EVIDENCE_FILES') ||
    id === 'ATTACH_EVIDENCE' ||
    lowerLabel.includes('attach')
  ) {
    return <Paperclip size={size} className={className} aria-hidden="true" />
  }
  if (
    upper.includes('NOC') ||
    lowerLabel.includes('noc') ||
    upper.includes('DOCUMENT') ||
    upper.includes('EVIDENCE') ||
    lowerLabel.includes('evidence') ||
    lowerLabel.includes('document')
  ) {
    return <ShieldCheck size={size} className={className} aria-hidden="true" />
  }
  if (
    upper.includes('REVIEW') ||
    id === 'REVIEW' ||
    lowerLabel.includes('review') ||
    lowerLabel.includes('submit')
  ) {
    return <CheckSquare size={size} className={className} aria-hidden="true" />
  }
  if (upper.includes('ENTERPRISE') || lowerLabel.includes('enterprise')) {
    return <Building2 size={size} className={className} aria-hidden="true" />
  }
  if (upper.includes('DECLARATION') || lowerLabel.includes('declaration')) {
    return <FileSignature size={size} className={className} aria-hidden="true" />
  }
  return <FileText size={size} className={className} aria-hidden="true" />
}

export function FormJourney<TId extends string>({
  steps,
  activeStepId,
  onStepSelect,
  children,
  footerLeft,
  footerRight,
  footer,
  footerStatus,
}: {
  steps: Array<JourneyStep<TId>>
  activeStepId: TId
  onStepSelect?: (step: TId) => void
  children: React.ReactNode
  footerLeft?: React.ReactNode
  footerRight?: React.ReactNode
  footer?: React.ReactNode
  footerStatus?: React.ReactNode
}) {
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === activeStepId),
  )
  const active = steps[activeIndex] ?? steps[0]
  if (!active) return null

  const canOpen = (step: JourneyStep<TId>) => step.status !== 'blocked'

  return (
    <section
      className={styles.journey}
      aria-labelledby="journey-section-title"
      data-testid="form-journey"
    >
      <div className={styles.mobileProgress}>
        <div>
          <span className={styles.mobileCount}>
            Step {activeIndex + 1} of {steps.length}
          </span>
          <span className={styles.mobileTitle}>{active.label}</span>
        </div>
        <label className={styles.mobileSelectLabel}>
          <span className="visually-hidden">Application category</span>
          <select
            className="select"
            value={activeStepId}
            onChange={(event) => onStepSelect?.(event.target.value as TId)}
          >
            {steps.map((step, index) => (
              <option key={step.id} value={step.id} disabled={!canOpen(step)}>
                {index + 1}. {step.label}
                {step.status === 'blocked'
                  ? ' — Complete earlier categories first'
                  : step.status === 'complete'
                    ? ' — Complete'
                    : step.status === 'locked'
                      ? ' — Read only'
                      : step.issueCount
                        ? ` — ${step.issueCount} to fix`
                        : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.body}>
        <nav className={styles.railCard} aria-label="Form categories">
          <ol className={styles.stepList}>
            {steps.map((step, index) => {
              const current = step.id === activeStepId
              const interactive = canOpen(step) && Boolean(onStepSelect)
              const isLocked = step.status === 'blocked' || step.status === 'locked'
              return (
                <li
                  key={step.id}
                  className={styles.stepItem}
                  data-current={current ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className={styles.stepButton}
                    disabled={!interactive}
                    data-current={current ? 'true' : undefined}
                    data-status={step.status}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => onStepSelect?.(step.id)}
                  >
                    <span
                      className={styles.stepCircle}
                      data-status={step.status}
                      data-current={current ? 'true' : undefined}
                    >
                      {step.status === 'complete' ? (
                        <Check size={13} strokeWidth={2.8} aria-hidden="true" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span
                      className={styles.stepIconWrap}
                      data-current={current ? 'true' : undefined}
                      data-status={step.status}
                    >
                      <CategoryIcon id={step.id} label={step.label} size={17} />
                    </span>
                    <div className={styles.stepCopy}>
                      <span className={styles.stepLabel}>{step.label}</span>
                      {current && step.issueCount ? (
                        <span className={styles.stepIssues}>
                          {step.issueCount}{' '}
                          {step.issueCount === 1 ? 'item' : 'items'} to fix
                        </span>
                      ) : (
                        <span
                          className={
                            current
                              ? styles.stepSubCurrent
                              : step.status === 'complete'
                                ? styles.stepSubComplete
                                : step.issueCount
                                  ? styles.stepIssues
                                  : styles.stepSub
                          }
                        >
                          {stateLabel(step, current)}
                        </span>
                      )}
                    </div>
                    <div className={styles.stepRightSlot}>
                      {isLocked ? (
                        <LockKeyhole
                          size={14}
                          className={styles.lockIcon}
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                  </button>
                </li>
              )
            })}
          </ol>
          <div className={styles.railFooter}>
            Category {activeIndex + 1} of {steps.length}
          </div>
        </nav>

        <div className={styles.formCard}>
          <div className={styles.formHeader} aria-live="polite">
            <div className={styles.formHeaderIconWrap}>
              <CategoryIcon id={active.id} label={active.label} size={24} />
            </div>
            <div className={styles.formHeaderText}>
              <h2 id="journey-section-title" className={styles.formTitle}>
                {active.label}
              </h2>
              <p className={styles.formDesc}>{active.description}</p>
            </div>
          </div>

          <div className={styles.formContent}>{children}</div>

          <div className={styles.formFooter}>
            <div className={styles.footerLeft}>
              {footerLeft ?? footerStatus}
            </div>
            <div className={styles.footerRight}>
              {footerRight ?? footer}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function stateLabel<TId extends string>(
  step: JourneyStep<TId>,
  current: boolean,
): string {
  if (current) return 'Current category'
  if (step.status === 'blocked') return 'Complete earlier categories first'
  if (step.status === 'locked') return 'Read only'
  if (step.issueCount) {
    return `${step.issueCount} ${step.issueCount === 1 ? 'item' : 'items'} to fix`
  }
  if (step.status === 'complete') return 'Complete'
  return 'Available'
}
