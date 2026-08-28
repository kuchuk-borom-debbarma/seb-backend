/**
 * The application form, drawn from the cycle's own template.
 *
 * One renderer for every cycle. What used to be six hand-built sections is now
 * a walk over `template.fields`: the labels, the help text, the choices, the
 * bounds and the conditions are all the cycle's, so a programme officer adding
 * a question adds a control here without a deploy.
 *
 * **Memoised per stage.** A keystroke re-renders one stage rather than the whole
 * form, which the six hand-built sections also did and which their header called
 * the single largest rendering cost in this product. A generic renderer that
 * passed the whole answer object to every stage would be correct, would pass
 * every test, and would get steadily slower as cycles grow — so each stage takes
 * only the answers its own fields and its own condition sources use.
 */
import { memo, useMemo } from 'react'
import {
  AlertCircle,
  Briefcase,
  Calendar,
  Check,
  IndianRupee,
  Mail,
  Percent,
  Phone,
  Plus,
  Trash2,
  User,
  UserCheck,
  Users,
} from 'lucide-react'
import type { AnswerEntry, AnswerMap, AnswerValue } from './answers'
import { entriesOf, issuePath } from './answers'
import { Attestation, Field, invalid, Statement, YesNoField } from './FormControls'
import type { FieldIssues } from './FormControls'
import {
  isRequiredWhenVisible,
  visibleFields,
  type FormField,
  type ResolvedTemplate,
} from './formTemplate'
import { formatMoney } from '#/lib/format'
import { paiseToRupees, rupeesToPaise } from './money'

/** Selects a suitable Lucide icon for recognized field roles and keys. */
function getFieldIcon(field: FormField): React.ReactNode | undefined {
  const key = field.key.toUpperCase()
  const label = field.label.toLowerCase()

  if (
    field.role === 'APPLICANT_DATE_OF_BIRTH' ||
    field.type === 'DATE' ||
    label.includes('date of birth') ||
    label.includes('dob')
  ) {
    return <Calendar size={14} />
  }
  if (
    key.includes('NAME') ||
    key.includes('PROMOTER') ||
    label.includes('name') ||
    label.includes('promoter')
  ) {
    return <User size={14} />
  }
  if (
    key.includes('DESIGNATION') ||
    key.includes('ROLE') ||
    label.includes('role in') ||
    label.includes('designation')
  ) {
    return <Briefcase size={14} />
  }
  if (key.includes('GENDER') || label.includes('gender')) {
    return <UserCheck size={14} />
  }
  if (
    key.includes('RELATIONSHIP') ||
    label.includes('relationship') ||
    label.includes('of (name)')
  ) {
    return <Users size={14} />
  }
  if (
    field.type === 'PHONE' ||
    key.includes('PHONE') ||
    label.includes('phone') ||
    label.includes('mobile')
  ) {
    return <Phone size={14} />
  }
  if (field.type === 'EMAIL' || key.includes('EMAIL') || label.includes('email')) {
    return <Mail size={14} />
  }
  if (key.includes('PERCENT') || key.includes('SHARE') || label.includes('share')) {
    return <Percent size={14} />
  }
  if (field.type === 'MONEY_PAISE') {
    return <IndianRupee size={14} />
  }
  return undefined
}

/** Computes full years between the given date and today. */
function computeAge(dateStr: string | null | undefined): number | null {
  if (!dateStr || typeof dateStr !== 'string') return null
  const parts = dateStr.trim().split('-')
  if (parts.length !== 3) return null
  const year = parseInt(parts[0]!, 10)
  const month = parseInt(parts[1]!, 10) - 1
  const day = parseInt(parts[2]!, 10)
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null
  const birthDate = new Date(Date.UTC(year, month, day))
  const today = new Date()
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear()
  const m = today.getUTCMonth() - birthDate.getUTCMonth()
  if (m < 0 || (m === 0 && today.getUTCDate() < birthDate.getUTCDate())) {
    age--
  }
  return age >= 0 && age < 130 ? age : null
}

/** Maximum date for 18+ eligibility (today - 18 years). */
function getMaxDobDate(): string {
  const today = new Date()
  const maxYear = today.getUTCFullYear() - 18
  const month = String(today.getUTCMonth() + 1).padStart(2, '0')
  const day = String(today.getUTCDate()).padStart(2, '0')
  return `${maxYear}-${month}-${day}`
}

/** The label, with the cycle's own "required" mark where it demands one. */
/**
 * The cycle's own words, with what the software adds after them.
 *
 * `note` is the unit — currency, so far — and it belongs beside the field's
 * name rather than after the optionality. Appended in the money branch, this
 * read "Bank loan proposed (optional) (₹)", which puts the unit at the end of
 * a sentence about whether an answer is needed.
 */
const labelOf = (field: FormField, required: boolean, note?: string): string => {
  const named = note ? `${field.label} (${note})` : field.label
  return required ? named : `${named} (optional)`
}

/**
 * One question, drawn by its declared type.
 *
 * `id` is the issue path rather than the bare key, because the server addresses
 * a refusal by that exact string and the review screen links to `#<field>`. One
 * definition of the path, in `answers.ts`, is what keeps the two in step.
 */
function Question({
  field,
  id,
  value,
  required,
  disabled,
  issues,
  onChange,
}: {
  field: FormField
  id: string
  value: AnswerValue
  required: boolean
  disabled: boolean
  issues: FieldIssues
  onChange: (next: AnswerValue) => void
}) {
  const issue = issues[id]
  const label = labelOf(field, required)
  // Money carries its unit inside the name, before the optional marker.
  const moneyLabel = labelOf(field, required, '₹')
  /*
   * A question's help text is *why it is asked*, not a note under the box.
   *
   * It goes to `Field`'s `explain` slot, which puts it behind a "Why X is
   * asked" control beside the label — the affordance the guide is built around,
   * and the reason that slot exists. Rendered as a plain hint it read as an
   * instruction the applicant had to parse before answering, and the control
   * that a keyboard user opens with Escape disappeared entirely.
   *
   * `hint` stays for what the software computes about the answer as it is
   * typed — the money control's formatted amount is the only one.
   */
  const explain = field.helpText ?? undefined
  /*
   * How the cycle asked for this question to be drawn. Everything here is the
   * author's styling decision; absence means the renderer's defaults.
   */
  const presentation = field.presentation
  const fieldExtras = {
    note: presentation.note,
    tone: presentation.tone,
    widthHint: presentation.widthHint,
  }
  const autoComplete = presentation.autocompleteHint
    ? { autoComplete: presentation.autocompleteHint }
    : {}
  const placeholder = presentation.placeholder
    ? { placeholder: presentation.placeholder }
    : {}
  /* Characters remaining, only where the cycle asked and a cap exists. */
  const counter =
    presentation.showCharCount && field.validation.maxLength
      ? `${Math.max(0, field.validation.maxLength - String(value ?? '').length)} characters left`
      : undefined

  if (field.type === 'STATEMENT') {
    // Read, never answered: the notice is the whole rendering.
    return <Statement id={id} title={field.label} body={presentation.note} tone={presentation.tone} />
  }

  /*
   * The template says which control this is, rather than the renderer guessing.
   *
   * An attestation has one acceptable answer; a yes/no question has two and an
   * unanswered third state, and the API tells them apart — a required question
   * answered "no" is complete, while an unticked attestation is a refusal. This
   * used to be inferred from the requirement flag, which was a guess that
   * happened to be right for the six hand-built questions and would have been
   * wrong for the first cycle that asked a seventh.
   */
  if (field.type === 'ATTESTATION') {
    return (
      <Attestation
        id={id}
        statement={field.label}
        issue={issue}
        checked={value === true}
        disabled={disabled}
        onChange={onChange}
      />
    )
  }

  if (field.type === 'BOOLEAN') {
    return (
      <YesNoField
        name={id}
        question={label}
        explain={explain}
        issue={issue}
        value={typeof value === 'boolean' ? value : null}
        disabled={disabled}
        onAnswer={onChange}
      />
    )
  }

  if (field.type === 'SINGLE_CHOICE') {
    const style = presentation.choiceStyle
    /*
     * The template says which control draws the choice. RADIO and SEGMENTED
     * are radio groups (segmented is styled by the row class); CARD adds the
     * option's own description under its label. The default stays a select.
     */
    if (style === 'RADIO' || style === 'SEGMENTED' || style === 'CARD') {
      return (
        <fieldset
          className={style === 'CARD' ? 'choice-field choice-cards' : 'choice-field'}
          id={id}
          tabIndex={-1}
          disabled={disabled}
          {...(fieldExtras.widthHint ? { 'data-width': fieldExtras.widthHint } : {})}
        >
          <legend className="field-label">{label}</legend>
          <div className={style === 'SEGMENTED' ? 'choice-row' : 'stack'}>
            {field.options.map((option) => (
              <label
                className={style === 'CARD' ? 'choice choice-card' : 'choice'}
                key={option.value}
              >
                <input
                  type="radio"
                  name={id}
                  checked={value === option.value}
                  onChange={() => onChange(option.value)}
                  {...(issue ? { 'aria-describedby': `${id}-error` } : {})}
                />
                <span>
                  {option.label}
                  {style === 'CARD' && option.description ? (
                    <span className="field-hint">{option.description}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          {issue ? (
            <span className="field-error" id={`${id}-error`}>
              {issue}
            </span>
          ) : null}
        </fieldset>
      )
    }
    return (
      <Field id={id} label={label} explain={explain} issue={issue} icon={getFieldIcon(field)} {...fieldExtras}>
        <select
          id={id}
          className="select"
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          {...invalid(issues, id)}
        >
          <option value="">Choose one</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
    )
  }

  if (field.type === 'MULTI_CHOICE') {
    const chosen = Array.isArray(value) ? (value as readonly string[]) : []
    if (presentation.choiceStyle === 'MULTISELECT') {
      return (
        <Field id={id} label={label} explain={explain} issue={issue} icon={getFieldIcon(field)} {...fieldExtras}>
          <select
            id={id}
            className="select"
            multiple
            disabled={disabled}
            value={[...chosen]}
            onChange={(event) =>
              onChange(
                // Template option order, so reordering a selection is not an edit.
                field.options
                  .map((each) => each.value)
                  .filter((each) =>
                    Array.from(event.target.selectedOptions, (option) => option.value)
                      .includes(each)),
              )
            }
            {...invalid(issues, id)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      )
    }
    return (
      <fieldset className="choice-field" id={id} tabIndex={-1} disabled={disabled}>
        <legend className="field-label">{label}</legend>
        <div className="stack">
          {field.options.map((option) => (
            <label className="checkbox-row" key={option.value}>
              <input
                type="checkbox"
                checked={chosen.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? // Kept in the template's own option order, so reordering
                        // a selection does not read as an edit.
                        field.options
                          .map((each) => each.value)
                          .filter((each) => each === option.value || chosen.includes(each))
                      : chosen.filter((each) => each !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
        {issue ? (
          <span className="field-error" id={`${id}-error`}>
            {issue}
          </span>
        ) : null}
      </fieldset>
    )
  }

  if (field.type === 'MONEY_PAISE') {
    const rupees = paiseToRupees(value)
    return (
      <Field
        id={id}
        label={moneyLabel}
        explain={explain}
        icon={getFieldIcon(field)}
        // What the software makes of the amount as it is typed, which is not
        // the same thing as why the question is asked.
        hint={rupees.trim() === '' ? undefined : formatMoney(String(rupeesToPaise(rupees) ?? 0))}
        issue={issue}
        {...fieldExtras}
      >
        <input
          id={id}
          className="input tabular"
          type="number"
          min={0}
          step="0.01"
          disabled={disabled}
          value={rupees}
          {...placeholder}
          onChange={(event) => {
            /*
             * Something that is not an amount leaves the answer alone. It used
             * to become `NaN`, which JSON sends as `null` — so a stray
             * character cleared what they had typed rather than being ignored.
             */
            const paise = rupeesToPaise(event.target.value)
            if (paise !== undefined) onChange(paise)
          }}
          {...invalid(issues, id)}
        />
      </Field>
    )
  }

  if (field.type === 'LONG_TEXT') {
    return (
      <Field
        id={id}
        label={label}
        explain={explain}
        issue={issue}
        hint={counter}
        icon={getFieldIcon(field)}
        {...fieldExtras}
      >
        <textarea
          id={id}
          className="textarea"
          rows={presentation.textareaRows ?? 3}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          {...placeholder}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          {...(field.validation.maxLength ? { maxLength: field.validation.maxLength } : {})}
          {...invalid(issues, id)}
        />
      </Field>
    )
  }

  const inputType =
    field.type === 'DATE'
      ? 'date'
      : field.type === 'INTEGER'
        ? 'number'
        : field.type === 'EMAIL'
          ? 'email'
          : field.type === 'PHONE'
            ? 'tel'
            : 'text'

  const isDob =
    field.role === 'APPLICANT_DATE_OF_BIRTH' ||
    field.key.toUpperCase().includes('DATE_OF_BIRTH') ||
    field.label.toLowerCase().includes('date of birth')

  const effectiveMaxDate = isDob
    ? (field.validation.maxDate ?? getMaxDobDate())
    : field.validation.maxDate

  const age = isDob ? computeAge(typeof value === 'string' ? value : null) : null
  let ageBadge: React.ReactNode = null
  let ageError: string | undefined = undefined

  if (isDob && age !== null) {
    if (age < 18) {
      ageBadge = (
        <span
          className="badge"
          data-tone="error"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <AlertCircle size={11} /> Under 18 ({age} yrs)
        </span>
      )
      ageError = 'Owner must be at least 18 years old.'
    } else if (age <= 60) {
      ageBadge = (
        <span
          className="badge"
          data-tone="ok"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <Check size={11} /> {age} yrs old
        </span>
      )
    } else {
      ageBadge = (
        <span
          className="badge"
          data-tone="action"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          {age} yrs (Policy: 18–60)
        </span>
      )
    }
  }

  const effectiveIssue = issue ?? ageError
  const effectiveIssues = effectiveIssue ? { ...issues, [id]: effectiveIssue } : issues

  const control = (
    <input
      id={id}
      className={field.type === 'INTEGER' ? 'input tabular' : 'input'}
      type={inputType}
      disabled={disabled}
      value={value === null || value === undefined ? '' : String(value)}
      {...placeholder}
      {...autoComplete}
      onChange={(event) =>
        onChange(
          event.target.value === ''
            ? null
            : field.type === 'INTEGER'
              ? Number(event.target.value)
              : event.target.value,
        )
      }
      {...(field.validation.maxLength ? { maxLength: field.validation.maxLength } : {})}
      {...(field.validation.minDate ? { min: field.validation.minDate } : {})}
      {...(effectiveMaxDate ? { max: effectiveMaxDate } : {})}
      {...invalid(effectiveIssues, id)}
    />
  )
  return (
    <Field
      id={id}
      label={label}
      explain={explain}
      issue={effectiveIssue}
      hint={counter}
      icon={getFieldIcon(field)}
      badge={ageBadge}
      {...fieldExtras}
    >
      {presentation.prefixText || presentation.suffixText ? (
        // The affix decorates the control, never the value: aria-hidden text
        // beside the input, GOV.UK style.
        <span className="affix-row">
          {presentation.prefixText ? (
            <span className="affix" aria-hidden="true">{presentation.prefixText}</span>
          ) : null}
          {control}
          {presentation.suffixText ? (
            <span className="affix" aria-hidden="true">{presentation.suffixText}</span>
          ) : null}
        </span>
      ) : (
        control
      )}
    </Field>
  )
}

/** A block the applicant may fill in more than once. */
function RepeatGroup({
  template,
  field,
  answers,
  disabled,
  issues,
  onChange,
}: {
  template: ResolvedTemplate
  field: FormField
  answers: AnswerMap
  disabled: boolean
  issues: FieldIssues
  onChange: (next: readonly AnswerEntry[]) => void
}) {
  const entries = entriesOf(answers, field.key)
  const members = template.membersOfGroup(field.key)
  const atMost = field.validation.maxRepeat ?? 20
  const atLeast = field.validation.minRepeat ?? 0

  return (
    <fieldset className="stack" id={field.key} tabIndex={-1} style={{ border: 0, padding: 0, margin: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
        <div>
          <legend className="field-label" style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--ink)' }}>
            {field.label}
          </legend>
          {field.helpText ? <span className="field-hint">{field.helpText}</span> : null}
        </div>
        <span className="badge" data-tone="action">
          {entries.length} {entries.length === 1 ? (field.label.toLowerCase().endsWith('s') ? field.label.toLowerCase().slice(0, -1) : field.label.toLowerCase()) : field.label.toLowerCase()}
        </span>
      </div>

      {issues[field.key] ? (
        <p className="notice" data-tone="error" id={`${field.key}-error`} style={{ margin: 0 }}>
          <span className="notice-title">Action Required</span>
          {issues[field.key]}
        </p>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {entries.map((entry, index) => {
          const entryVisible = visibleFields(template, answers, entry, field.key)
          // Extract designation label or name if available
          const nameValue = String(entry['OWNERS__NAME'] ?? entry['NAME'] ?? entry['name'] ?? '').trim()
          const designationValue = String(entry['OWNERS__DESIGNATION'] ?? entry['DESIGNATION'] ?? entry['designation'] ?? '').trim()

          return (
            <div
              className="card"
              key={index}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                background: 'var(--surface)',
                overflow: 'hidden',
              }}
            >
              <div
                className="card-header"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 'var(--space-3) var(--space-4)',
                  background: 'var(--surface-sunken)',
                  borderBottom: '1px solid var(--border-soft)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--ink-secondary)',
                    }}
                  >
                    <User size={15} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink)' }}>
                      {nameValue || `${field.label} ${index + 1}`}
                    </span>
                    {index === 0 ? (
                      <span className="badge" data-tone="ok" style={{ fontSize: '0.625rem' }}>
                        Primary / Founder
                      </span>
                    ) : null}
                    {designationValue ? (
                      <span className="badge" style={{ fontSize: '0.625rem' }}>
                        {designationValue.replace(/_/g, ' ')}
                      </span>
                    ) : null}
                  </div>
                </div>

                {!disabled && entries.length > atLeast ? (
                  <button
                    type="button"
                    className="button"
                    data-variant="danger"
                    style={{
                      minHeight: '1.875rem',
                      padding: '0 var(--space-3)',
                      fontSize: '0.75rem',
                      gap: '4px',
                    }}
                    onClick={() => onChange(entries.filter((_, each) => each !== index))}
                  >
                    <Trash2 size={13} />
                    <span>Remove</span>
                  </button>
                ) : null}
              </div>

              <div className="card-body detail-grid" style={{ padding: 'var(--space-4)' }}>
                {members
                  .filter((member) => entryVisible.has(member.key) && member.type !== 'FILE')
                  .map((member) => (
                    <Question
                      key={member.key}
                      field={member}
                      id={issuePath(member.key, field.key, index)}
                      value={entry[member.key] ?? null}
                      required={isRequiredWhenVisible(
                        template,
                        member,
                        answers,
                        entryVisible,
                        entry,
                        field.key,
                      )}
                      disabled={disabled}
                      issues={issues}
                      onChange={(next) =>
                        onChange(
                          entries.map((each, position) =>
                            position === index ? { ...each, [member.key]: next } : each,
                          ),
                        )
                      }
                    />
                  ))}
              </div>
            </div>
          )
        })}
      </div>

      {!disabled && (atMost === null || entries.length < atMost) ? (
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="button"
            style={{
              width: '100%',
              minHeight: '2.75rem',
              borderStyle: 'dashed',
              borderColor: 'var(--border-strong)',
              background: 'var(--surface-sunken)',
              gap: '8px',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
            onClick={() => onChange([...entries, {}])}
          >
            <Plus size={16} />
            <span>Add another {field.label.toLowerCase().endsWith('s') ? field.label.toLowerCase().slice(0, -1) : field.label.toLowerCase()}</span>
          </button>
          <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
            {entries.length} of {atMost} {field.label.toLowerCase()} added
          </div>
        </div>
      ) : null}
    </fieldset>
  )
}

/**
 * One stage of the form.
 *
 * Memoised, and it takes the whole answer map because a condition may name a
 * source in another stage. What bounds the re-render is the comparison below:
 * a stage re-renders only when an answer it actually reads has changed.
 *
 * **It reports the question and the answer, never a rebuilt map**, and that is
 * what the memoisation costs. This used to hand up `{ ...answers, [key]: next }`
 * — the map as of the render this stage last had — and a stage that had not
 * re-rendered since the applicant moved on was holding a stale one. Answering a
 * question here then **discarded every answer given in another stage since**,
 * silently, and the next save stored the loss. Merging belongs where the current
 * answers are, which is the owner.
 */
export const StageForm = memo(
  function StageForm({
    template,
    stageKey,
    answers,
    issues,
    disabled,
    onChange,
  }: {
    template: ResolvedTemplate
    stageKey: string
    answers: AnswerMap
    issues: FieldIssues
    disabled: boolean
    onChange: (fieldKey: string, value: AnswerValue | readonly AnswerEntry[]) => void
  }) {
    const visible = useMemo(() => visibleFields(template, answers), [template, answers])
    const fields = template
      .fieldsOfStage(stageKey)
      .filter((field) => visible.has(field.key) && field.type !== 'FILE')
      .filter((field) => field.source === 'APPLICANT')

    return (
      <div className="stack">
        <div className="detail-grid">
          {fields
            .filter((field) => field.type !== 'REPEAT_GROUP')
            .map((field) => (
              <Question
                key={field.key}
                field={field}
                id={field.key}
                value={(answers[field.key] ?? null) as AnswerValue}
                required={isRequiredWhenVisible(template, field, answers, visible)}
                disabled={disabled}
                issues={issues}
                onChange={(next) => onChange(field.key, next)}
              />
            ))}
        </div>
        {fields
          .filter((field) => field.type === 'REPEAT_GROUP')
          .map((field) => (
            <RepeatGroup
              key={field.key}
              template={template}
              field={field}
              answers={answers}
              disabled={disabled}
              issues={issues}
              onChange={(next) => onChange(field.key, next)}
            />
          ))}
      </div>
    )
  },
  /*
   * Re-render only when something this stage reads has changed.
   *
   * The dependency set is projected from the template — the stage's own fields,
   * their group members, and every field their conditions name — rather than
   * assumed, so a cycle that adds a cross-stage condition keeps working without
   * anybody remembering to widen this.
   */
  (previous, next) => {
    if (
      previous.template !== next.template ||
      previous.stageKey !== next.stageKey ||
      previous.disabled !== next.disabled ||
      previous.issues !== next.issues ||
      previous.onChange !== next.onChange
    ) return false
    if (previous.answers === next.answers) return true
    const watched = new Set<string>()
    const add = (field: FormField) => {
      watched.add(field.key)
      for (const condition of field.conditions) watched.add(condition.sourceFieldKey)
    }
    for (const field of next.template.fieldsOfStage(next.stageKey)) {
      add(field)
      for (const member of next.template.membersOfGroup(field.key)) add(member)
    }
    return [...watched].every((key) => previous.answers[key] === next.answers[key])
  },
)
