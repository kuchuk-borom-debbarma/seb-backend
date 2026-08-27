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
  CheckCircle2,
  FileCheck,
  FileSignature,
  FileText,
  History,
  IndianRupee,
  LockKeyhole,
  Paperclip,
  User,
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

function CategoryIcon({ id, size = 20 }: { id: string; size?: number }) {
  switch (id) {
    case 'ENTERPRISE':
      return <Building2 size={size} className={styles.formTitleIcon} aria-hidden="true" />
    case 'APPLICANT_PROFILE':
      return <User size={size} className={styles.formTitleIcon} aria-hidden="true" />
    case 'FINANCIAL':
      return <IndianRupee size={size} className={styles.formTitleIcon} aria-hidden="true" />
    case 'PRIOR_FUNDING':
      return <History size={size} className={styles.formTitleIcon} aria-hidden="true" />
    case 'DOCUMENTS':
      return <FileText size={size} className={styles.formTitleIcon} aria-hidden="true" />
    case 'DECLARATION':
      return <FileSignature size={size} className={styles.formTitleIcon} aria-hidden="true" />
    case 'ATTACH_EVIDENCE':
      return <Paperclip size={size} className={styles.formTitleIcon} aria-hidden="true" />
    case 'REVIEW':
      return <CheckCircle2 size={size} className={styles.formTitleIcon} aria-hidden="true" />
    default:
      return null
  }
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
                    aria-current={current ? 'step' : undefined}
                    onClick={() => onStepSelect?.(step.id)}
                  >
                    <span className={styles.stepCircle} data-status={step.status}>
                      {step.status === 'complete' ? (
                        <Check size={14} strokeWidth={2.8} aria-hidden="true" />
                      ) : (
                        index + 1
                      )}
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
                            step.status === 'complete'
                              ? styles.stepSubComplete
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
            <h2 id="journey-section-title" className={styles.formTitle}>
              <CategoryIcon id={active.id} />
              <span>{active.label}</span>
            </h2>
            <p className={styles.formDesc}>{active.description}</p>
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
  if (step.status === 'blocked') return 'Complete earlier categories first'
  if (step.status === 'locked') return 'Read only'
  if (step.issueCount) {
    return `${step.issueCount} ${step.issueCount === 1 ? 'item' : 'items'} to fix`
  }
  if (current) return 'Current category'
  if (step.status === 'complete') return 'Complete'
  return 'Available'
}
