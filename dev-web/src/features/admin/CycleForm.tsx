/**
 * The programme cycle form.
 *
 * A cycle is the policy an application is judged by, frozen at the moment a
 * draft is started: ages, the funding ceiling, the pipeline its applications
 * are worked in, and the kinds of application it accepts — each with the
 * eligibility rules an enterprise must meet to start one.
 *
 * The pipeline is chosen here and pinned when the cycle opens; its stages and
 * actions are authored on the pipeline's own screens. The kinds replace the
 * hard-coded initial/expansion pair: `EXPANSION` is whatever its rules say.
 * The last step holds the form's rules about several answers at once, which
 * travel with the form template.
 */
import { useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  IndianRupee,
  Info,
  ShieldCheck,
} from 'lucide-react'
import type {
  ApplicationKindInput,
  ProgrammeCycleInput,
} from '#/graphql/generated/schema'
import styles from './CycleForm.module.css'
import { useMarker } from '#/features/guide/GuideContext'
import { CycleFormRulesStep, CyclePipelineStep } from '#/features/pipeline/CyclePipelineStep'
import { defaultFormTemplate } from './defaultFormTemplate'
import { toLocalDateTimeInput } from '#/lib/format'

/**
 * The kinds a new cycle starts with: one first application per enterprise at a
 * time. A later kind — an expansion — is added with the rules that make it one.
 */
const defaultKinds = (): ApplicationKindInput[] => [
  {
    kindKey: 'INITIAL',
    label: 'First application',
    description: 'The enterprise’s first Mission SEP application.',
    rules: [{ ruleType: 'NO_OPEN_APPLICATION_OF_KIND', paramsJson: '{"kind":"INITIAL"}' }],
  },
]

export const emptyCycle = (year: number): ProgrammeCycleInput => ({
  cycleCode: `SEP-${year}`,
  displayName: `Mission SEP ${year}`,
  cycleYear: year,
  applicantGuidance: null,
  opensAt: null,
  closesAt: null,
  policy: {
    minimumApplicantAge: 18,
    maximumApplicantAge: 60,
    categoryAMaximumMonths: 24,
    majorityOwnershipRequired: true,
    jurisdiction: 'TTAADC',
    // Unresolved until TTAADC states one authoritative maximum — roadmap §21.
    fundingCeilingState: 'UNRESOLVED',
    fundingCeilingAmountPaise: null,
    fundingCeilingScope: null,
    formTemplate: defaultFormTemplate(),
    // Chosen on the last step; opening refuses a pipeline never published.
    pipelineId: '',
    applicationKinds: defaultKinds(),
  },
})

/** Turns a datetime-local value into the ISO instant the API expects. */
const toInstant = (value: string): string | null =>
  value ? new Date(value).toISOString() : null

/** And back again, since `datetime-local` cannot read an ISO string with a zone. */
const toLocalInput = toLocalDateTimeInput

export function CycleForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: ProgrammeCycleInput
  submitLabel: string
  busy: boolean
  onSubmit: (values: ProgrammeCycleInput) => void
  onCancel?: () => void
}) {
  const [activeStep, setActiveStep] = useState<number>(0)
  const [values, setValues] = useState<ProgrammeCycleInput>(initial)
  const mark = useMarker()

  const set = <TKey extends keyof ProgrammeCycleInput>(
    key: TKey,
    value: ProgrammeCycleInput[TKey],
  ) => setValues((current) => ({ ...current, [key]: value }))

  const setPolicy = <TKey extends keyof ProgrammeCycleInput['policy']>(
    key: TKey,
    value: ProgrammeCycleInput['policy'][TKey],
  ) =>
    setValues((current) => ({
      ...current,
      policy: { ...current.policy, [key]: value },
    }))

  const kinds = values.policy.applicationKinds

  // Milestones definition. The questions the cycle asks are not among them:
  // the form template has its own editor on the cycle's page.
  const MILESTONES = [
    {
      id: 'cycle',
      stepNumber: 1,
      title: 'The cycle',
      subtitle: 'Code, name & schedule',
      complete: Boolean(
        values.cycleCode.trim() && values.displayName.trim() && values.cycleYear,
      ),
    },
    {
      id: 'eligibility',
      stepNumber: 2,
      title: 'Eligibility policy',
      subtitle: 'Age, location & ownership',
      complete:
        values.policy.minimumApplicantAge !== null &&
        values.policy.maximumApplicantAge !== null,
    },
    {
      id: 'funding',
      stepNumber: 3,
      title: 'Funding',
      subtitle: 'The ceiling',
      complete: values.policy.fundingCeilingState !== null,
    },
    {
      id: 'pipeline',
      stepNumber: 4,
      title: 'Pipeline & kinds',
      subtitle: 'Route and who may apply',
      complete: Boolean(values.policy.pipelineId.trim()) && kinds.length > 0,
    },
    {
      id: 'rules',
      stepNumber: 5,
      title: 'Answer rules',
      subtitle: 'Across several answers',
      // Optional: a form may state no rule between its answers.
      complete: true,
    },
  ] as const

  return (
    <form
      className={styles.formContainer}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(values)
      }}
    >
      {/* Top Notice Banner */}
      <div className={styles.infoBanner}>
        <div className={styles.infoIconWrap}>
          <Info size={16} aria-hidden="true" />
        </div>
        <div className={styles.infoContent}>
          <h2 className={styles.infoTitle}>A cycle is created as a draft</h2>
          <p className={styles.infoText}>
            Nothing here reaches applicants until you open it — and it can only be opened
            once the policy PDF, applicant guidance, the opening date, every eligibility
            field, a published pipeline, and at least one kind of application are all
            present.
          </p>
        </div>
      </div>

      {/* Milestone Stepper Navigation */}
      <nav className={styles.stepperNav} aria-label="Cycle creation steps">
        {MILESTONES.map((step, index) => (
          <div key={step.id} className={styles.stepSlot}>
            <button
              type="button"
              className={styles.stepButton}
              data-active={activeStep === index ? 'true' : undefined}
              onClick={() => setActiveStep(index)}
              aria-current={activeStep === index ? 'step' : undefined}
            >
              <div
                className={styles.stepBadge}
                data-complete={step.complete ? 'true' : undefined}
              >
                {step.complete && activeStep !== index ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  step.stepNumber
                )}
              </div>
              <div className={styles.stepTextWrap}>
                <span className={styles.stepTitle}>{step.title}</span>
                <span className={styles.stepSubtitle}>{step.subtitle}</span>
              </div>
            </button>
            {index < MILESTONES.length - 1 ? (
              <div className={styles.stepDivider} aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </nav>

      {/* Milestone 1: The Cycle */}
      {activeStep === 0 && (
        <div className={styles.tabPane}>
          <div className={styles.sectionCard} {...mark('cycle-policy')}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>The cycle</h2>
              <div className={styles.sectionDivider} />
            </div>

            {/* Row 1: Code, Name, Year */}
            <div className={styles.formGrid3}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="cycleCode">
                  Cycle code
                </label>
                <input
                  id="cycleCode"
                  className={styles.inputField}
                  placeholder="e.g., SEP-2026"
                  required
                  value={values.cycleCode}
                  // Upper-cased as it is typed. The API accepts only upper case,
                  // and correcting it here is kinder than refusing the whole
                  // form after a round trip.
                  onChange={(event) => set('cycleCode', event.target.value.toUpperCase())}
                />
                <span className={styles.fieldHint}>
                  3–32 upper-case letters, numbers or hyphens. Unique, and shown to
                  applicants beside the name.
                </span>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="displayName">
                  Name
                </label>
                <input
                  id="displayName"
                  className={styles.inputField}
                  placeholder="Enter cycle name"
                  required
                  value={values.displayName}
                  onChange={(event) => set('displayName', event.target.value)}
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="cycleYear">
                  Programme year
                </label>
                <select
                  id="cycleYear"
                  className={styles.selectField}
                  value={values.cycleYear}
                  onChange={(event) => set('cycleYear', Number(event.target.value))}
                >
                  <option value={values.cycleYear}>{values.cycleYear}</option>
                  <option value={values.cycleYear + 1}>{values.cycleYear + 1}</option>
                  <option value={values.cycleYear - 1}>{values.cycleYear - 1}</option>
                  <option value={values.cycleYear - 2}>{values.cycleYear - 2}</option>
                </select>
              </div>
            </div>

            {/* Row 2: Policy document pointer. The upload itself lives on the
                cycle page — a draft must exist before a file can belong to it. */}
            <span className={styles.fieldHint}>
              After creating the draft, upload the order or circular this cycle
              implements (as a PDF) on the cycle&rsquo;s page. The cycle cannot be
              opened without it.
            </span>

            {/* Row 3: Opening date. There is no closing input: a cycle takes
                applications until the office closes it. */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="opensAt">
                Applications open
              </label>
              <input
                id="opensAt"
                className={styles.inputField}
                type="datetime-local"
                value={toLocalInput(values.opensAt)}
                onChange={(event) => set('opensAt', toInstant(event.target.value))}
              />
              <span className={styles.fieldHint}>
                Applications stay open until the office closes the cycle.
              </span>
            </div>

            {/* Row 4: Applicant Guidance */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="applicantGuidance">
                Guidance for applicants
              </label>
              <textarea
                id="applicantGuidance"
                className={styles.textareaField}
                rows={3}
                placeholder="Enter guidance for applicants"
                value={values.applicantGuidance ?? ''}
                onChange={(event) => set('applicantGuidance', event.target.value || null)}
              />
              <span className={styles.fieldHint}>
                Shown on the applicant's programme cycle page. Required before the cycle
                can be opened.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Milestone 2: Eligibility Policy */}
      {activeStep === 1 && (
        <div className={styles.tabPane}>
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <div
                className={styles.sectionHeaderIconWrap}
                data-color="green"
                aria-hidden="true"
              >
                <ShieldCheck size={18} />
              </div>
              <h2 className={styles.sectionTitle}>Eligibility policy</h2>
              <div className={styles.sectionDivider} />
            </div>

            {/* 4 Numeric Constraints */}
            <div className={styles.formGrid4}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="minimumApplicantAge">
                  Minimum applicant age
                </label>
                <input
                  id="minimumApplicantAge"
                  className={styles.inputField}
                  type="number"
                  placeholder="Enter years"
                  value={values.policy.minimumApplicantAge ?? ''}
                  onChange={(event) =>
                    setPolicy(
                      'minimumApplicantAge',
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="maximumApplicantAge">
                  Maximum applicant age
                </label>
                <input
                  id="maximumApplicantAge"
                  className={styles.inputField}
                  type="number"
                  placeholder="Enter years"
                  value={values.policy.maximumApplicantAge ?? ''}
                  onChange={(event) =>
                    setPolicy(
                      'maximumApplicantAge',
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="categoryAMaximumMonths">
                  Category A maximum age of enterprise (months)
                </label>
                <input
                  id="categoryAMaximumMonths"
                  className={styles.inputField}
                  type="number"
                  placeholder="Enter months"
                  value={values.policy.categoryAMaximumMonths ?? ''}
                  onChange={(event) =>
                    setPolicy(
                      'categoryAMaximumMonths',
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                />
              </div>

            </div>

            {/* Fixed policy, stated rather than asked. The values still travel
                in the input (the API refuses nulls at opening); only the choice
                left the screen — every SEP cycle is TTAADC, majority-ST. */}
            <span className={styles.fieldHint}>
              This cycle applies to TTAADC areas and requires majority ST
              ownership.
            </span>
          </div>
        </div>
      )}

      {/* Milestone 3: Funding */}
      {activeStep === 2 && (
        <div className={styles.tabPane}>
          {/* Funding Ceiling */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <div
                className={styles.sectionHeaderIconWrap}
                data-color="orange"
                aria-hidden="true"
              >
                <Info size={18} />
              </div>
              <h2 className={styles.sectionTitle}>Funding ceiling</h2>
              <div className={styles.sectionDivider} />
            </div>

            <p className={styles.fieldHint} style={{ margin: 0 }}>
              TTAADC has not yet stated one authoritative maximum, so a cycle may be
              published with this unresolved. Applications are then not bounded by a
              ceiling.
            </p>

            <div className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Ceiling</span>
              <div className={styles.choiceCardsGrid}>
                {/* Not yet decided. An unresolved ceiling carries neither an
                    amount nor a scope. */}
                <div
                  className={styles.choiceCard}
                  data-selected={
                    values.policy.fundingCeilingState === 'UNRESOLVED'
                      ? 'true'
                      : undefined
                  }
                  data-theme="orange"
                  onClick={() => {
                    setPolicy('fundingCeilingState', 'UNRESOLVED')
                    setPolicy('fundingCeilingAmountPaise', null)
                    setPolicy('fundingCeilingScope', null)
                  }}
                  role="radio"
                  aria-checked={values.policy.fundingCeilingState === 'UNRESOLVED'}
                  tabIndex={0}
                >
                  <div className={styles.choiceCardLeft}>
                    <div className={styles.radioIndicator}>
                      {values.policy.fundingCeilingState === 'UNRESOLVED' ? (
                        <div className={styles.radioDot} />
                      ) : null}
                    </div>
                    <span className={styles.choiceCardText}>Not yet decided</span>
                  </div>
                </div>

                {/* Decided */}
                <div
                  className={styles.choiceCard}
                  data-selected={
                    values.policy.fundingCeilingState === 'RESOLVED' ? 'true' : undefined
                  }
                  data-theme="orange"
                  onClick={() => setPolicy('fundingCeilingState', 'RESOLVED')}
                  role="radio"
                  aria-checked={values.policy.fundingCeilingState === 'RESOLVED'}
                  tabIndex={0}
                >
                  <div className={styles.choiceCardLeft}>
                    <div className={styles.radioIndicator}>
                      {values.policy.fundingCeilingState === 'RESOLVED' ? (
                        <div className={styles.radioDot} />
                      ) : null}
                    </div>
                    <span className={styles.choiceCardText}>Decided</span>
                  </div>
                  <IndianRupee
                    size={18}
                    className={styles.choiceCardIcon}
                    aria-hidden="true"
                  />
                </div>
              </div>
            </div>

            {values.policy.fundingCeilingState === 'RESOLVED' ? (
              <div className={styles.formGrid2}>
                <div className={styles.fieldGroup}>
                  <label
                    className={styles.fieldLabel}
                    htmlFor="fundingCeilingAmountPaise"
                  >
                    Maximum, in rupees
                  </label>
                  <input
                    id="fundingCeilingAmountPaise"
                    className={styles.inputField}
                    type="number"
                    min={1}
                    placeholder="e.g., 500000"
                    value={
                      values.policy.fundingCeilingAmountPaise
                        ? Number(values.policy.fundingCeilingAmountPaise) / 100
                        : ''
                    }
                    onChange={(event) =>
                      setPolicy(
                        'fundingCeilingAmountPaise',
                        // Money is a string of paise on the wire, so rupees are
                        // converted here rather than anywhere the value is read.
                        event.target.value
                          ? String(Math.round(Number(event.target.value) * 100))
                          : null,
                      )
                    }
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="fundingCeilingScope">
                    Applies to
                  </label>
                  <select
                    id="fundingCeilingScope"
                    className={styles.selectField}
                    value={values.policy.fundingCeilingScope ?? ''}
                    onChange={(event) =>
                      setPolicy(
                        'fundingCeilingScope',
                        (event.target.value ||
                          null) as ProgrammeCycleInput['policy']['fundingCeilingScope'],
                      )
                    }
                  >
                    <option value="">Choose a scope</option>
                    <option value="APPLICATION">Each application</option>
                    <option value="PHASE">Each phase</option>
                    <option value="ENTERPRISE">Each enterprise</option>
                    <option value="FUNDING_CASE">The whole funding case</option>
                  </select>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Milestone 4: The pipeline, and the kinds of application accepted */}
      {activeStep === 3 && (
        <div className={styles.tabPane}>
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Pipeline and kinds of application</h2>
              <div className={styles.sectionDivider} />
            </div>
            <CyclePipelineStep
              pipelineId={values.policy.pipelineId}
              onPipelineChange={(pipelineId) => setPolicy('pipelineId', pipelineId)}
              kinds={kinds}
              onKindsChange={(next) => setPolicy('applicationKinds', next)}
            />
          </div>
        </div>
      )}

      {/* Milestone 5: What the form says about several answers at once */}
      {activeStep === 4 && (
        <div className={styles.tabPane}>
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Rules across answers</h2>
              <div className={styles.sectionDivider} />
            </div>
            <CycleFormRulesStep
              template={values.policy.formTemplate}
              onChange={(rules) => setPolicy('formTemplate', { ...values.policy.formTemplate, rules })}
            />
          </div>
        </div>
      )}

      {/* Footer Navigation Bar */}
      <div className={styles.footerBar}>
        {onCancel ? (
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        ) : (
          <div />
        )}

        <div className={styles.footerRight}>
          {activeStep > 0 ? (
            <button
              type="button"
              className={styles.prevButton}
              onClick={() => setActiveStep((current) => current - 1)}
              disabled={busy}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              Previous
            </button>
          ) : null}

          {activeStep < MILESTONES.length - 1 ? (
            <button
              type="button"
              className={styles.nextButton}
              onClick={() => setActiveStep((current) => current + 1)}
              disabled={busy}
            >
              Next: {MILESTONES[activeStep + 1]!.title}
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ) : null}

          <button
            type="submit"
            className={styles.submitButton}
            disabled={busy}
            data-variant="primary"
          >
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </form>
  )
}
