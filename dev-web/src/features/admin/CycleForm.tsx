/**
 * The programme cycle form.
 *
 * A cycle is the policy an application is judged by, frozen at the moment a
 * draft is started. That makes this the densest form in the product: ages,
 * waiting periods, the funding ceiling, which assessments an expansion needs,
 * and the reason catalogue every later administrative action must choose from.
 *
 * The reason catalogue matters more than it looks. Desk review, revisions, bank
 * outcomes, programme decisions, award changes and recovery all require a
 * reason approved by the cycle, so a cycle created without them produces a
 * workflow that cannot be operated. The defaults below cover every context the
 * API defines, and are editable like everything else.
 */
import { useState } from 'react'
import {
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileText,
  IndianRupee,
  Info,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type {
  AssessmentType,
  DeskReviewCheckType,
  DeskReviewIdentifierKind,
  IdentifierDuplicatePolicy,
  IdentifierRequirement,
  ProgrammeCycleInput,
  ProgrammeReasonContext,
} from '#/graphql/generated/schema'

/**
 * One row of the identifier editor.
 *
 * `checkType` is optional to match the generated input exactly: the API accepts
 * it absent as well as null, and narrowing it here would make every rule the
 * server sends back fail to typecheck on the way in.
 */
type IdentifierRuleValue = {
  kind: DeskReviewIdentifierKind
  requirement: IdentifierRequirement
  duplicatePolicy: IdentifierDuplicatePolicy
  checkType?: DeskReviewCheckType | null
}
import styles from './CycleForm.module.css'
import { CHECKS } from './DeskReviewForm'
import { useMarker } from '#/features/guide/GuideContext'
import { defaultFormTemplate } from './defaultFormTemplate'
import { humanize, toLocalDateTimeInput } from '#/lib/format'

const ASSESSMENT_TYPES: AssessmentType[] = [
  'UTILIZATION',
  'PERFORMANCE',
  'FINANCIAL_AUDIT',
]

const REASON_CONTEXTS: ProgrammeReasonContext[] = [
  // Assignment release and reassignment left the product, and their reason
  // contexts left the API's enum with them. CYCLE_CLOSE stays in the enum but
  // is not offered here: closing takes a free-text reason, so a catalogue
  // entry for it was demanded of officers and then never consumed.
  'REVISION',
  'REJECTION',
  'BANK_REFERRAL_CANCEL',
  'BANK_OUTCOME_CORRECTION',
  'DECISION_CORRECTION',
  'AWARD_AMENDMENT',
  'AWARD_SUSPENSION',
  'AWARD_CANCELLATION',
  'AWARD_CLOSURE',
  'RELEASE_REVERSAL',
  'RECOVERY',
  'RECOVERY_WAIVER',
]

/** One usable reason per context, so a new cycle can be operated immediately. */
const defaultReasons = () =>
  REASON_CONTEXTS.map((context) => ({
    context,
    code: context,
    label: humanize(context),
    applicantMessageTemplate: null as string | null,
  }))

/** Every identifier the desk review knows how to transcribe. */
const IDENTIFIER_KINDS: DeskReviewIdentifierKind[] = [
  'ST_CERTIFICATE',
  'IDENTITY_DOCUMENT',
  'BANK_ACCOUNT',
  'BUSINESS_REGISTRATION',
]

const IDENTIFIER_REQUIREMENTS: IdentifierRequirement[] = [
  'REQUIRED_ON_PASS',
  'OPTIONAL',
  'OFF',
]

/**
 * What each setting means, in the words an officer configuring a cycle needs.
 *
 * The two settings are independent on purpose, and that is the thing most
 * likely to be misread: an identifier can be collected without being compared
 * (joint and family bank accounts are real, and refusing them would be wrong),
 * and it can be compared without being demanded.
 */
const REQUIREMENT_HELP: Record<IdentifierRequirement, string> = {
  REQUIRED_ON_PASS: 'Demanded whenever the check it stands behind is passed.',
  OPTIONAL: 'Collected if the reviewer has it. Never blocks the review.',
  OFF: 'Not collected at all. The field does not appear.',
}

/**
 * How Mission SEP is configured today, as the starting point for a new cycle.
 *
 * Business registration is optional rather than demanded: an unregistered
 * enterprise has none, and demanding one would make somebody invent a number to
 * get past the form.
 */
const defaultIdentifierRules = (): IdentifierRuleValue[] => [
  {
    kind: 'ST_CERTIFICATE',
    requirement: 'REQUIRED_ON_PASS',
    duplicatePolicy: 'CHECKED',
    checkType: 'ST_ELIGIBILITY',
  },
  {
    kind: 'IDENTITY_DOCUMENT',
    requirement: 'REQUIRED_ON_PASS',
    duplicatePolicy: 'CHECKED',
    checkType: 'IDENTITY_KYC',
  },
  {
    kind: 'BANK_ACCOUNT',
    requirement: 'REQUIRED_ON_PASS',
    duplicatePolicy: 'CHECKED',
    checkType: 'DOCUMENT_COMPLETENESS',
  },
  {
    kind: 'BUSINESS_REGISTRATION',
    requirement: 'OPTIONAL',
    duplicatePolicy: 'NOT_CHECKED',
    checkType: null,
  },
]

export const emptyCycle = (year: number): ProgrammeCycleInput => ({
  cycleCode: `SEP-${year}`,
  displayName: `Mission SEP ${year}`,
  cycleYear: year,
  applicantGuidance: null,
  partnerBankGuidance: null,
  opensAt: null,
  closesAt: null,
  policy: {
    minimumApplicantAge: 18,
    maximumApplicantAge: 60,
    categoryAMaximumMonths: 24,
    expansionWaitMonths: 12,
    majorityOwnershipRequired: true,
    jurisdiction: 'TTAADC',
    // Unresolved until TTAADC states one authoritative maximum — roadmap §21.
    fundingCeilingState: 'UNRESOLVED',
    fundingCeilingAmountPaise: null,
    fundingCeilingScope: null,
    requiredAssessmentTypes: [...ASSESSMENT_TYPES],
    formTemplate: defaultFormTemplate(),
    identifierRules: defaultIdentifierRules(),
    reasons: defaultReasons(),
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

  /*
   * The API treats an absent list as "collect nothing", so the field is
   * nullable there. The form always has a list to render, and an empty one is
   * shown back as the real setting it is rather than as a blank.
   */
  const identifierRules: IdentifierRuleValue[] = values.policy.identifierRules ?? []

  const toggleAssessment = (type: AssessmentType) =>
    setPolicy(
      'requiredAssessmentTypes',
      values.policy.requiredAssessmentTypes.includes(type)
        ? values.policy.requiredAssessmentTypes.filter((candidate) => candidate !== type)
        : [...values.policy.requiredAssessmentTypes, type],
    )

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
      id: 'assessments',
      stepNumber: 3,
      title: 'Expansion & Funding',
      subtitle: 'Assessments & ceiling',
      complete: values.policy.requiredAssessmentTypes.length > 0,
    },
    {
      id: 'review',
      stepNumber: 4,
      title: 'Desk review & Reasons',
      subtitle: 'Identifiers & admin rules',
      complete: values.policy.reasons.length > 0,
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
            field, at least one assessment, and a reason for every administrative action
            are all present.
          </p>
        </div>
      </div>

      {/* Milestone Stepper Navigation */}
      <nav className={styles.stepperNav} aria-label="Cycle creation steps">
        {MILESTONES.map((step, index) => (
          <div key={step.id} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
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

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="expansionWaitMonths">
                  Expansion waiting period (months)
                </label>
                <input
                  id="expansionWaitMonths"
                  className={styles.inputField}
                  type="number"
                  placeholder="Enter months"
                  value={values.policy.expansionWaitMonths ?? ''}
                  onChange={(event) =>
                    setPolicy(
                      'expansionWaitMonths',
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

      {/* Milestone 3: Expansion & Funding */}
      {activeStep === 2 && (
        <div className={styles.tabPane}>
          {/* Assessments an expansion must pass */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <div
                className={styles.sectionHeaderIconWrap}
                data-color="purple"
                aria-hidden="true"
              >
                <ClipboardCheck size={18} />
              </div>
              <h2 className={styles.sectionTitle}>Assessments an expansion must pass</h2>
              <div className={styles.sectionDivider} />
            </div>

            <div className={styles.choiceCardsGrid}>
              {ASSESSMENT_TYPES.map((type) => {
                const isSelected = values.policy.requiredAssessmentTypes.includes(type)
                const IconComponent =
                  type === 'UTILIZATION'
                    ? ClipboardCheck
                    : type === 'PERFORMANCE'
                      ? BarChart3
                      : FileText

                return (
                  <div
                    key={type}
                    className={styles.choiceCard}
                    data-selected={isSelected ? 'true' : undefined}
                    data-theme="purple"
                    onClick={() => toggleAssessment(type)}
                    role="checkbox"
                    aria-checked={isSelected}
                    tabIndex={0}
                  >
                    <div className={styles.choiceCardLeft}>
                      <div className={styles.checkboxIndicator}>
                        {isSelected ? <Check size={13} aria-hidden="true" /> : null}
                      </div>
                      <span className={styles.choiceCardText}>{humanize(type)}</span>
                    </div>
                    <IconComponent
                      size={18}
                      className={styles.choiceCardIcon}
                      aria-hidden="true"
                    />
                  </div>
                )
              })}
            </div>
          </div>

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

      {/* Milestone 4: Desk review identifiers & Reason catalogue */}
      {activeStep === 3 && (
        <div className={styles.tabPane}>
          {/* Numbers the desk review writes down */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Numbers the desk review writes down</h2>
              <div className={styles.sectionDivider} />
            </div>

            <p className={styles.fieldHint} style={{ margin: 0 }}>
              A reviewer transcribes these off the documents as they pass each check. The
              two settings are separate: what is <em>demanded</em> and what is{' '}
              <em>compared</em> against other applications. A bank account shared by a
              family is a real thing, so it can be collected without a match ever blocking
              anybody.
            </p>

            {identifierRules.length === 0 ? (
              /*
               * An empty rule set is a real configuration — it demands nothing
               * and compares nothing — and it is indistinguishable from a cycle
               * somebody forgot to configure. Saying so is the difference.
               */
              <p className="notice">
                <span className="notice-title">This cycle asks for no numbers</span>
                Nothing will be transcribed and no duplicate can be detected. That is a
                valid setting, but rarely the intended one.
              </p>
            ) : null}

            <div className="stack" style={{ gap: '8px' }}>
              {identifierRules.map((rule, index) => {
                const update = (patch: Partial<IdentifierRuleValue>) =>
                  setPolicy(
                    'identifierRules',
                    identifierRules.map((current, position) =>
                      position === index ? { ...current, ...patch } : current,
                    ),
                  )
                return (
                  <div
                    className="row"
                    key={`${rule.kind}-${index}`}
                    style={{ gap: '10px' }}
                  >
                    <select
                      className={styles.selectField}
                      aria-label={`Identifier ${index + 1}`}
                      value={rule.kind}
                      onChange={(event) =>
                        update({ kind: event.target.value as DeskReviewIdentifierKind })
                      }
                    >
                      {IDENTIFIER_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {humanize(kind)}
                        </option>
                      ))}
                    </select>

                    <select
                      className={styles.selectField}
                      aria-label={`Demanded, for identifier ${index + 1}`}
                      value={rule.requirement}
                      onChange={(event) => {
                        const requirement = event.target.value as IdentifierRequirement
                        /*
                         * Only REQUIRED_ON_PASS has a moment at which it
                         * applies, and the database enforces exactly that with
                         * a CHECK. Clearing the check here keeps the form from
                         * composing a row the API will refuse.
                         */
                        update({
                          requirement,
                          checkType:
                            requirement === 'REQUIRED_ON_PASS'
                              ? (rule.checkType ?? CHECKS[0]!.type)
                              : null,
                        })
                      }}
                    >
                      {IDENTIFIER_REQUIREMENTS.map((requirement) => (
                        <option key={requirement} value={requirement}>
                          {humanize(requirement)}
                        </option>
                      ))}
                    </select>

                    <select
                      className={styles.selectField}
                      aria-label={`Evidence for which check, for identifier ${index + 1}`}
                      value={rule.checkType ?? ''}
                      disabled={rule.requirement !== 'REQUIRED_ON_PASS'}
                      onChange={(event) =>
                        update({ checkType: event.target.value as DeskReviewCheckType })
                      }
                    >
                      {CHECKS.map((check) => (
                        <option key={check.type} value={check.type}>
                          {check.title}
                        </option>
                      ))}
                    </select>

                    <label className="checkbox-row" style={{ whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={rule.duplicatePolicy === 'CHECKED'}
                        aria-label={`Compare for duplicates, for identifier ${index + 1}`}
                        onChange={(event) =>
                          update({
                            duplicatePolicy: event.target.checked
                              ? 'CHECKED'
                              : 'NOT_CHECKED',
                          })
                        }
                      />
                      Compare
                    </label>

                    <button
                      type="button"
                      className={styles.cancelButton}
                      style={{ padding: '8px 12px' }}
                      aria-label={`Remove identifier ${index + 1}`}
                      onClick={() =>
                        setPolicy(
                          'identifierRules',
                          identifierRules.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}

              <div>
                <button
                  type="button"
                  className={styles.prevButton}
                  disabled={identifierRules.length >= IDENTIFIER_KINDS.length}
                  onClick={() =>
                    setPolicy('identifierRules', [
                      ...identifierRules,
                      {
                        // The first kind not already configured, so adding a
                        // row cannot produce the duplicate the API refuses.
                        kind:
                          IDENTIFIER_KINDS.find(
                            (kind) => !identifierRules.some((rule) => rule.kind === kind),
                          ) ?? IDENTIFIER_KINDS[0]!,
                        requirement: 'OPTIONAL',
                        duplicatePolicy: 'NOT_CHECKED',
                        checkType: null,
                      },
                    ])
                  }
                >
                  <Plus size={15} aria-hidden="true" />
                  Add an identifier
                </button>
              </div>

              <p className={styles.fieldHint} style={{ marginTop: '8px' }}>
                {REQUIREMENT_HELP.REQUIRED_ON_PASS} {REQUIREMENT_HELP.OPTIONAL}{' '}
                {REQUIREMENT_HELP.OFF}
              </p>
            </div>
          </div>

          {/* Reason Catalogue (Collapsible disclosure) */}
          <details className={styles.sectionCard}>
            <summary
              className="disclosure"
              style={{ cursor: 'pointer', fontWeight: 600 }}
            >
              <span className={styles.sectionTitle}>Reason catalogue</span>
              <span className="muted" style={{ marginLeft: '10px', fontSize: '13px' }}>
                ({values.policy.reasons.length} administrative action reasons)
              </span>
            </summary>
            <p className={styles.fieldHint} style={{ margin: '10px 0' }}>
              Every later administrative action — a revision, a rejection, a reversal —
              must choose a reason approved by this cycle. A cycle without them cannot be
              operated, so these are filled in for you and can be renamed.
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Used for</th>
                    <th scope="col">Code</th>
                    <th scope="col">Label staff choose</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {values.policy.reasons.map((reason, index) => (
                    <tr key={`${reason.context}-${reason.code}-${index}`}>
                      <td>{humanize(reason.context)}</td>
                      <td>
                        <input
                          className={styles.inputField}
                          aria-label={`Code for reason ${index + 1}`}
                          value={reason.code}
                          onChange={(event) =>
                            setPolicy(
                              'reasons',
                              values.policy.reasons.map((current, position) =>
                                position === index
                                  ? { ...current, code: event.target.value }
                                  : current,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className={styles.inputField}
                          aria-label={`Label for reason ${index + 1}`}
                          value={reason.label}
                          onChange={(event) =>
                            setPolicy(
                              'reasons',
                              values.policy.reasons.map((current, position) =>
                                position === index
                                  ? { ...current, label: event.target.value }
                                  : current,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.cancelButton}
                          style={{ padding: '6px 10px' }}
                          aria-label={`Remove reason ${index + 1}`}
                          onClick={() =>
                            setPolicy(
                              'reasons',
                              values.policy.reasons.filter(
                                (_, position) => position !== index,
                              ),
                            )
                          }
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
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
