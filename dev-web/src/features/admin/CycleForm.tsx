/**
 * The programme cycle form.
 *
 * A cycle is the policy an application is judged by, frozen at the moment a
 * draft is started. That makes this the densest form in the product: ages,
 * waiting periods, the funding ceiling, which assessments an expansion needs,
 * which documents are required and when, and the reason catalogue every later
 * administrative action must choose from.
 *
 * The reason catalogue matters more than it looks. Desk review, revisions, bank
 * outcomes, committee decisions, award changes and recovery all require a
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
  FileCheck,
  FileText,
  Globe,
  IndianRupee,
  Info,
  Map,
  MapPin,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react'
import type {
  AssessmentType,
  DeskReviewCheckType,
  DeskReviewIdentifierKind,
  DocumentType,
  IdentifierDuplicatePolicy,
  IdentifierRequirement,
  ProgrammeCycleInput,
  ProgrammeDocumentCondition,
  ProgrammeReasonContext,
} from '#/graphql/generated/schema'
import styles from './CycleForm.module.css'
import { CHECKS } from './DeskReviewForm'
import { useMarker } from '#/features/guide/GuideContext'
import { humanize } from '#/lib/format'

/**
 * One row of the identifier editor.
 */
type IdentifierRuleValue = {
  kind: DeskReviewIdentifierKind
  requirement: IdentifierRequirement
  duplicatePolicy: IdentifierDuplicatePolicy
  checkType?: DeskReviewCheckType | null
}

const ASSESSMENT_TYPES: AssessmentType[] = [
  'UTILIZATION',
  'PERFORMANCE',
  'FINANCIAL_AUDIT',
]

const DOCUMENT_TYPES: DocumentType[] = [
  'IDENTITY_AGE_PROOF',
  'ST_CERTIFICATE',
  'ADDRESS_PROOF',
  'BUSINESS_REGISTRATION',
  'GST_REGISTRATION',
  'DPR',
  'BANK_DETAILS',
  'NOC',
]

const DOCUMENT_CONDITIONS: ProgrammeDocumentCondition[] = [
  'ALWAYS',
  'WHEN_REGISTERED',
  'WHEN_GSTIN_PRESENT',
  'WHEN_NOC_REQUIRED',
  'OPTIONAL',
]

const REASON_CONTEXTS: ProgrammeReasonContext[] = [
  'CYCLE_CLOSE',
  'ASSIGNMENT_RELEASE',
  'ASSIGNMENT_REASSIGN',
  'REVISION',
  'REJECTION',
  'BANK_REFERRAL_CANCEL',
  'BANK_OUTCOME_CORRECTION',
  'TTM_DEFERRAL',
  'TTM_DECISION_CORRECTION',
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

/** The evidence Mission SEP asks for, with the condition each is required under. */
const defaultDocumentRules = (): Array<{
  documentType: DocumentType
  condition: ProgrammeDocumentCondition
}> => [
  { documentType: 'IDENTITY_AGE_PROOF', condition: 'ALWAYS' },
  { documentType: 'ST_CERTIFICATE', condition: 'ALWAYS' },
  { documentType: 'ADDRESS_PROOF', condition: 'ALWAYS' },
  { documentType: 'DPR', condition: 'ALWAYS' },
  { documentType: 'BANK_DETAILS', condition: 'ALWAYS' },
  { documentType: 'BUSINESS_REGISTRATION', condition: 'WHEN_REGISTERED' },
  { documentType: 'GST_REGISTRATION', condition: 'WHEN_GSTIN_PRESENT' },
  { documentType: 'NOC', condition: 'WHEN_NOC_REQUIRED' },
]

export const emptyCycle = (year: number): ProgrammeCycleInput => ({
  cycleCode: `SEP-${year}`,
  displayName: `Mission SEP ${year}`,
  cycleYear: year,
  policyReference: null,
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
    documentRules: defaultDocumentRules(),
    identifierRules: defaultIdentifierRules(),
    reasons: defaultReasons(),
  },
})

/** Turns a datetime-local value into the ISO instant the API expects. */
const toInstant = (value: string): string | null =>
  value ? new Date(value).toISOString() : null

/** And back again, since `datetime-local` cannot read an ISO string with a zone. */
const toLocalInput = (value: string | null | undefined): string =>
  value ? new Date(value).toISOString().slice(0, 16) : ''

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

  // Milestones definition
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
      id: 'evidence',
      stepNumber: 4,
      title: 'Evidence & Reasons',
      subtitle: 'Documents & admin rules',
      complete:
        values.policy.documentRules.length > 0 && values.policy.reasons.length > 0,
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
            once the policy reference, applicant guidance, both dates, every eligibility
            field, a rule for every document type, at least one assessment, and a reason for
            every administrative action are all present.
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
                  onChange={(event) =>
                    set('cycleCode', event.target.value.toUpperCase())
                  }
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

            {/* Row 2: Policy reference */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="policyReference">
                Policy reference
              </label>
              <input
                id="policyReference"
                className={styles.inputField}
                placeholder="Enter policy reference"
                required
                value={values.policyReference ?? ''}
                onChange={(event) =>
                  set('policyReference', event.target.value || null)
                }
              />
              <span className={styles.fieldHint}>
                The order or circular this cycle implements. Required before the cycle can
                be opened.
              </span>
            </div>

            {/* Row 3: Opens & Closes Dates */}
            <div className={styles.formGrid2}>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="opensAt">
                  Applications open
                </label>
                <input
                  id="opensAt"
                  className={styles.inputField}
                  type="datetime-local"
                  required
                  value={toLocalInput(values.opensAt)}
                  onChange={(event) => set('opensAt', toInstant(event.target.value))}
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="closesAt">
                  Applications close
                </label>
                <input
                  id="closesAt"
                  className={styles.inputField}
                  type="datetime-local"
                  required
                  value={toLocalInput(values.closesAt)}
                  onChange={(event) => set('closesAt', toInstant(event.target.value))}
                />
              </div>
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
                required
                value={values.applicantGuidance ?? ''}
                onChange={(event) =>
                  set('applicantGuidance', event.target.value || null)
                }
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

            {/* Jurisdiction Selectable Choice Cards */}
            <div className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Jurisdiction</span>
              <div className={styles.choiceCardsGrid}>
                {/* Option 1: Not stated */}
                <div
                  className={styles.choiceCard}
                  data-selected={values.policy.jurisdiction === null ? 'true' : undefined}
                  onClick={() => setPolicy('jurisdiction', null)}
                  role="radio"
                  aria-checked={values.policy.jurisdiction === null}
                  tabIndex={0}
                >
                  <div className={styles.choiceCardLeft}>
                    <div className={styles.radioIndicator}>
                      {values.policy.jurisdiction === null ? (
                        <div className={styles.radioDot} />
                      ) : null}
                    </div>
                    <span className={styles.choiceCardText}>Not stated</span>
                  </div>
                  <Globe size={18} className={styles.choiceCardIcon} aria-hidden="true" />
                </div>

                {/* Option 2: TTAADC areas */}
                <div
                  className={styles.choiceCard}
                  data-selected={
                    values.policy.jurisdiction === 'TTAADC' ? 'true' : undefined
                  }
                  onClick={() => setPolicy('jurisdiction', 'TTAADC')}
                  role="radio"
                  aria-checked={values.policy.jurisdiction === 'TTAADC'}
                  tabIndex={0}
                >
                  <div className={styles.choiceCardLeft}>
                    <div className={styles.radioIndicator}>
                      {values.policy.jurisdiction === 'TTAADC' ? (
                        <div className={styles.radioDot} />
                      ) : null}
                    </div>
                    <span className={styles.choiceCardText}>TTAADC areas</span>
                  </div>
                  <MapPin
                    size={18}
                    className={styles.choiceCardIcon}
                    aria-hidden="true"
                  />
                </div>

                {/* Option 3: Tripura */}
                <div
                  className={styles.choiceCard}
                  data-selected={
                    values.policy.jurisdiction === 'TRIPURA' ? 'true' : undefined
                  }
                  onClick={() => setPolicy('jurisdiction', 'TRIPURA')}
                  role="radio"
                  aria-checked={values.policy.jurisdiction === 'TRIPURA'}
                  tabIndex={0}
                >
                  <div className={styles.choiceCardLeft}>
                    <div className={styles.radioIndicator}>
                      {values.policy.jurisdiction === 'TRIPURA' ? (
                        <div className={styles.radioDot} />
                      ) : null}
                    </div>
                    <span className={styles.choiceCardText}>Tripura</span>
                  </div>
                  <Map size={18} className={styles.choiceCardIcon} aria-hidden="true" />
                </div>
              </div>
            </div>

            {/* Majority ST Ownership Required Checkbox Card */}
            <div
              className={styles.fullCheckboxCard}
              data-selected={
                values.policy.majorityOwnershipRequired ? 'true' : undefined
              }
              onClick={() =>
                setPolicy(
                  'majorityOwnershipRequired',
                  !values.policy.majorityOwnershipRequired,
                )
              }
              role="checkbox"
              aria-checked={values.policy.majorityOwnershipRequired ?? false}
              tabIndex={0}
            >
              <div className={styles.checkboxIndicator}>
                {values.policy.majorityOwnershipRequired ? (
                  <Check size={13} aria-hidden="true" />
                ) : null}
              </div>
              <Users size={18} className={styles.choiceCardIcon} aria-hidden="true" />
              <span className={styles.choiceCardText}>
                Majority ST ownership required
              </span>
            </div>
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
                {/* Not yet decided */}
                <div
                  className={styles.choiceCard}
                  data-selected={
                    values.policy.fundingCeilingState === 'UNRESOLVED' ? 'true' : undefined
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

      {/* Milestone 4: Required Evidence & Reasons */}
      {activeStep === 3 && (
        <div className={styles.tabPane}>
          {/* Required Evidence (Document Rules) */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <div
                className={styles.sectionHeaderIconWrap}
                data-color="blue"
                aria-hidden="true"
              >
                <FileCheck size={18} />
              </div>
              <h2 className={styles.sectionTitle}>Required evidence</h2>
              <div className={styles.sectionDivider} />
            </div>

            <p className={styles.fieldHint} style={{ margin: 0 }}>
              The evidence Mission SEP asks for, with the condition each is required
              under.
            </p>

            <div className="stack" style={{ gap: '8px' }}>
              {values.policy.documentRules.map((rule, index) => (
                <div
                  className="row"
                  key={`${rule.documentType}-${index}`}
                  style={{ gap: '10px' }}
                >
                  <select
                    className={styles.selectField}
                    aria-label={`Document ${index + 1}`}
                    value={rule.documentType}
                    onChange={(event) =>
                      setPolicy(
                        'documentRules',
                        values.policy.documentRules.map((current, position) =>
                          position === index
                            ? {
                                ...current,
                                documentType: event.target.value as DocumentType,
                              }
                            : current,
                        ),
                      )
                    }
                  >
                    {DOCUMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {humanize(type)}
                      </option>
                    ))}
                  </select>

                  <select
                    className={styles.selectField}
                    aria-label={`Required when, for document ${index + 1}`}
                    value={rule.condition}
                    onChange={(event) =>
                      setPolicy(
                        'documentRules',
                        values.policy.documentRules.map((current, position) =>
                          position === index
                            ? {
                                ...current,
                                condition: event.target.value as ProgrammeDocumentCondition,
                              }
                            : current,
                        ),
                      )
                    }
                  >
                    {DOCUMENT_CONDITIONS.map((condition) => (
                      <option key={condition} value={condition}>
                        {humanize(condition)}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className={styles.cancelButton}
                    style={{ padding: '8px 12px' }}
                    onClick={() =>
                      setPolicy(
                        'documentRules',
                        values.policy.documentRules.filter(
                          (_, position) => position !== index,
                        ),
                      )
                    }
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              ))}

              <div>
                <button
                  type="button"
                  className={styles.prevButton}
                  onClick={() =>
                    setPolicy('documentRules', [
                      ...values.policy.documentRules,
                      { documentType: 'DPR', condition: 'ALWAYS' },
                    ])
                  }
                >
                  <Plus size={15} aria-hidden="true" />
                  Add a document
                </button>
              </div>
            </div>
          </div>

          {/* Numbers the desk review writes down */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Numbers the desk review writes down</h2>
              <div className={styles.sectionDivider} />
            </div>

            <p className={styles.fieldHint} style={{ margin: 0 }}>
              A reviewer transcribes these off the documents as they pass each check. The
              two settings are separate: what is <em>demanded</em> and what is{' '}
              <em>compared</em> against other applications.
            </p>

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
              Every administrative action — a revision, a rejection, a reversal — must
              choose a reason approved by this cycle.
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
