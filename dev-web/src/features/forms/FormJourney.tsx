/**
 * The shared frame for work that is safer to complete one category at a time.
 *
 * It owns presentation and navigation semantics only. Callers still decide
 * what makes a step complete, which steps may be opened, and what Back or Next
 * actually does, so no business rule is duplicated into the design system.
 */
import { AlertCircle, Check, Circle, LockKeyhole } from 'lucide-react'
import styles from './FormJourney.module.css'

export type JourneyStepStatus = 'available' | 'blocked' | 'complete' | 'error' | 'locked'

export type JourneyStep<TId extends string = string> = {
  id: TId
  label: string
  description: string
  status: JourneyStepStatus
  issueCount?: number
}

export function FormJourney<TId extends string>({
  steps,
  activeStepId,
  onStepSelect,
  children,
  footer,
  footerStatus,
}: {
  steps: Array<JourneyStep<TId>>
  activeStepId: TId
  onStepSelect?: (step: TId) => void
  children: React.ReactNode
  footer: React.ReactNode
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
        <nav className={styles.rail} aria-label="Form categories">
          <ol>
            {steps.map((step, index) => {
              const current = step.id === activeStepId
              const interactive = canOpen(step) && Boolean(onStepSelect)
              return (
                <li key={step.id} data-current={current ? 'true' : undefined}>
                  <button
                    type="button"
                    className={styles.step}
                    disabled={!interactive}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => onStepSelect?.(step.id)}
                  >
                    <span className={styles.marker} data-status={step.status}>
                      <StepIcon status={step.status} />
                    </span>
                    <span className={styles.stepCopy}>
                      <span className={styles.stepLabel}>
                        <span className={styles.stepNumber}>{index + 1}.</span>{' '}
                        {step.label}
                      </span>
                      <span className={styles.stepState}>
                        {stateLabel(step, current)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className={styles.workspace}>
          <header className={styles.sectionHeader} aria-live="polite">
            <p className="eyebrow">
              Category {activeIndex + 1} of {steps.length}
            </p>
            <h2 id="journey-section-title">{active.label}</h2>
            <p>{active.description}</p>
          </header>

          <div className={styles.content}>{children}</div>
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerStatus}>{footerStatus}</div>
        <div className={styles.footerActions}>{footer}</div>
      </footer>
    </section>
  )
}

function StepIcon({ status }: { status: JourneyStepStatus }) {
  if (status === 'complete') return <Check aria-hidden="true" />
  if (status === 'locked') return <LockKeyhole aria-hidden="true" />
  if (status === 'error') return <AlertCircle aria-hidden="true" />
  return <Circle aria-hidden="true" />
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
