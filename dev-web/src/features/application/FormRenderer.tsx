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
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronUp,
  Trash2,
  UserPlus,
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
import { paiseToRupees, rupeesToPaise } from './money'

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
  const isYearField =
    field.key.toUpperCase().includes('YEAR') || field.label.toLowerCase().includes('year')
  const isSchemeField =
    field.key.toUpperCase().includes('SCHEME') || field.label.toLowerCase().includes('scheme')

  const fieldExtras = {
    note: presentation.note,
    tone: presentation.tone,
    widthHint: isYearField ? undefined : presentation.widthHint,
  }
  const autoComplete = presentation.autocompleteHint
    ? { autoComplete: presentation.autocompleteHint }
    : {}

  const placeholder = presentation.placeholder
    ? { placeholder: presentation.placeholder }
    : isYearField
      ? { placeholder: 'Select year' }
      : isSchemeField
        ? { placeholder: 'Select scheme' }
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
      <Field id={id} label={label} explain={explain} issue={issue} {...fieldExtras}>
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
        <Field id={id} label={label} explain={explain} issue={issue} {...fieldExtras}>
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

function formatRupeesWithCommas(value: string): string {
  if (!value) return ''
  const [whole, decimal] = value.split('.')
  const lastThree = whole ? whole.slice(-3) : ''
  const otherNumbers = whole ? whole.slice(0, -3) : ''
  const formattedWhole =
    otherNumbers !== ''
      ? otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree
      : lastThree
  return decimal !== undefined ? `${formattedWhole}.${decimal}` : formattedWhole
}

  if (field.type === 'MONEY_PAISE') {
    const rupees = paiseToRupees(value)
    const displayVal = rupees ? `₹${formatRupeesWithCommas(rupees)}` : ''
    return (
      <Field
        id={id}
        label={moneyLabel}
        explain={explain}
        hint={counter}
        issue={issue}
        {...fieldExtras}
      >
        <input
          id={id}
          className="input tabular"
          type="text"
          inputMode="numeric"
          disabled={disabled}
          value={displayVal}
          placeholder={field.presentation.placeholder ?? '₹0'}
          style={{ width: '100%', minHeight: '44px', padding: '10px 14px', fontSize: '14px' }}
          onChange={(event) => {
            const raw = event.target.value.replace(/[^0-9.]/g, '')
            const paise = rupeesToPaise(raw)
            if (raw === '') {
              onChange(null)
            } else if (paise !== undefined) {
              onChange(paise)
            }
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
  if (isYearField) {
    return (
      <Field
        id={id}
        label={label}
        explain={explain}
        issue={effectiveIssue}
        hint={counter}
        badge={ageBadge}
        {...fieldExtras}
      >
        <YearPicker
          id={id}
          value={typeof value === 'number' ? value : value ? parseInt(String(value), 10) : null}
          disabled={disabled}
          minYear={1901}
          maxYear={2026}
          placeholder={presentation.placeholder ?? 'Select year'}
          issues={effectiveIssues}
          onChange={(next) => onChange(next)}
        />
      </Field>
    )
  }

  return (
    <Field
      id={id}
      label={label}
      explain={explain}
      issue={effectiveIssue}
      hint={counter}
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

function YearPicker({
  id,
  value,
  disabled,
  minYear = 1901,
  maxYear = 2026,
  placeholder = 'Select year',
  issues,
  onChange,
}: {
  id: string
  value: number | null | undefined
  disabled: boolean
  minYear?: number
  maxYear?: number
  placeholder?: string
  issues: FieldIssues
  onChange: (next: number | null) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState<string>(value !== null && value !== undefined ? String(value) : '')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setQuery(value !== null && value !== undefined ? String(value) : '')
  }, [value])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const years = useMemo(() => {
    const list: number[] = []
    for (let y = maxYear; y >= minYear; y--) {
      list.push(y)
    }
    return list
  }, [minYear, maxYear])

  const filteredYears = useMemo(() => {
    if (!query) return years
    const q = query.trim()
    return years.filter((y) => String(y).includes(q))
  }, [years, query])

  const handleSelect = (year: number) => {
    onChange(year)
    setQuery(String(year))
    setIsOpen(false)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '').slice(0, 4)
    setQuery(raw)
    setIsOpen(true)
    if (raw === '') {
      onChange(null)
    } else {
      const num = parseInt(raw, 10)
      if (raw.length === 4) {
        if (num >= minYear && num <= maxYear) {
          onChange(num)
        } else {
          onChange(num)
        }
      } else {
        onChange(null)
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIsOpen(true)
    } else if (e.key === 'Enter') {
      if (filteredYears.length > 0 && isOpen) {
        e.preventDefault()
        handleSelect(filteredYears[0]!)
      }
    }
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <div style={{ position: 'relative', width: '100%' }}>
        <input
          id={id}
          className="input tabular"
          type="text"
          inputMode="numeric"
          disabled={disabled}
          value={query}
          placeholder={placeholder}
          style={{ width: '100%', minHeight: '44px', padding: '10px 38px 10px 14px', fontSize: '14px' }}
          onClick={() => !disabled && setIsOpen(true)}
          onFocus={() => !disabled && setIsOpen(true)}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          {...invalid(issues, id)}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Toggle year selection"
          disabled={disabled}
          onClick={() => !disabled && setIsOpen((prev) => !prev)}
          style={{
            position: 'absolute',
            right: '8px',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            padding: '4px',
            color: 'var(--ink-muted)',
            display: 'flex',
            alignItems: 'center',
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          <Calendar size={16} />
        </button>
      </div>

      {isOpen && !disabled && (
        <div
          ref={listRef}
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: '220px',
            overflowY: 'auto',
            background: '#ffffff',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05)',
            zIndex: 100,
            padding: '4px',
          }}
        >
          {filteredYears.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: '13px', color: 'var(--ink-muted)' }}>
              No matching years ({minYear}–{maxYear})
            </div>
          ) : (
            filteredYears.map((yr) => {
              const isSelected = value === yr
              return (
                <button
                  key={yr}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    fontSize: '13.5px',
                    fontWeight: isSelected ? 600 : 400,
                    borderRadius: '6px',
                    border: 'none',
                    background: isSelected ? '#ebf3fc' : 'transparent',
                    color: isSelected ? 'var(--brand)' : 'var(--ink)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = '#f8fafc'
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'transparent'
                  }}
                  onClick={() => handleSelect(yr)}
                >
                  <span>{yr}</span>
                  {isSelected && <span style={{ fontSize: '12px', color: 'var(--brand)' }}>✓</span>}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

function getInitials(name: string, fallback: string): string {
  if (!name) return fallback
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return fallback
  if (parts.length === 1) return (parts[0]?.[0] ?? fallback).toUpperCase()
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase()
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <legend className="field-label" style={{ fontSize: '1.0625rem', fontWeight: 700, color: 'var(--ink)', margin: 0 }}>
            {field.label}
          </legend>
          <span
            className="badge"
            style={{
              borderColor: '#d8e6f8',
              background: '#ebf3fc',
              color: 'var(--brand)',
              fontSize: '0.75rem',
              fontWeight: 500,
              padding: '2px 8px',
            }}
          >
            {entries.length} {entries.length === 1 ? (field.label.toLowerCase().endsWith('s') ? field.label.toLowerCase().slice(0, -1) : field.label.toLowerCase()) : field.label.toLowerCase()}
          </span>
        </div>
        {!disabled && (atMost === null || entries.length < atMost) ? (
          <button
            type="button"
            className="button"
            title={`Add another ${field.label}`}
            style={{
              width: '32px',
              height: '32px',
              padding: 0,
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--ink)',
            }}
            onClick={() => onChange([...entries, {}])}
          >
            <UserPlus size={16} />
          </button>
        ) : null}
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
                borderRadius: '12px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
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
                  padding: '12px 18px',
                  background: 'var(--surface-sunken)',
                  borderBottom: '1px solid var(--border-soft)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: '#e2e8f0',
                      color: '#334155',
                      fontSize: '12px',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {getInitials(nameValue, String(index + 1))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--ink)' }}>
                      {nameValue || `${field.label} ${index + 1}`}
                    </span>
                    {index === 0 ? (
                      <span className="badge" data-tone="ok" style={{ fontSize: '0.6875rem' }}>
                        Primary / Founder
                      </span>
                    ) : null}
                    {designationValue ? (
                      <span className="badge" style={{ fontSize: '0.6875rem', textTransform: 'uppercase' }}>
                        {designationValue.replace(/_/g, ' ')}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {!disabled && entries.length > atLeast ? (
                    <button
                      type="button"
                      className="button"
                      data-variant="danger"
                      style={{
                        minHeight: '1.875rem',
                        padding: '0 var(--space-2)',
                        fontSize: '0.75rem',
                        gap: '4px',
                      }}
                      onClick={() => onChange(entries.filter((_, each) => each !== index))}
                    >
                      <Trash2 size={13} />
                      <span>Remove</span>
                    </button>
                  ) : (
                    <ChevronUp size={16} color="var(--ink-muted)" aria-hidden="true" />
                  )}
                </div>
              </div>

              <div className="card-body detail-grid" style={{ padding: '20px' }}>
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
              width: 'fit-content',
              minHeight: '2.5rem',
              border: '1px solid var(--brand)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)',
              color: 'var(--brand)',
              gap: '8px',
              padding: '0 var(--space-4)',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
            onClick={() => onChange([...entries, {}])}
          >
            <UserPlus size={16} />
            <span>Add another {field.label.toLowerCase().endsWith('s') ? field.label.toLowerCase().slice(0, -1) : field.label.toLowerCase()}</span>
          </button>
          <div style={{ textAlign: 'left', fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
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

    const fieldGroups = useMemo(() => {
      const nonRepeat = fields.filter((field) => field.type !== 'REPEAT_GROUP')
      const groups: Array<{ type: 'single' | 'grid'; fields: FormField[] }> = []
      let currentGrid: FormField[] = []

      for (const field of nonRepeat) {
        if (field.type === 'BOOLEAN' || field.type === 'STATEMENT' || field.type === 'ATTESTATION') {
          if (currentGrid.length > 0) {
            groups.push({ type: currentGrid.length > 1 ? 'grid' : 'single', fields: currentGrid })
            currentGrid = []
          }
          groups.push({ type: 'single', fields: [field] })
        } else if (stageKey === 'PRIOR_FUNDING' || field.requirement === 'CONDITIONAL') {
          currentGrid.push(field)
        } else {
          if (currentGrid.length > 0) {
            groups.push({ type: currentGrid.length > 1 ? 'grid' : 'single', fields: currentGrid })
            currentGrid = []
          }
          groups.push({ type: 'single', fields: [field] })
        }
      }
      if (currentGrid.length > 0) {
        groups.push({ type: currentGrid.length > 1 ? 'grid' : 'single', fields: currentGrid })
      }
      return groups
    }, [fields, stageKey])

    return (
      <div className="stack" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '28px' }}>
        {fieldGroups.map((group, groupIdx) => {
          if (group.type === 'grid') {
            return (
              <div
                key={groupIdx}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '20px',
                  width: '100%',
                }}
              >
                {group.fields.map((field) => (
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
            )
          }

          const field = group.fields[0]
          if (!field) return null
          return (
            <div key={field.key} style={{ width: '100%' }}>
              <Question
                field={field}
                id={field.key}
                value={(answers[field.key] ?? null) as AnswerValue}
                required={isRequiredWhenVisible(template, field, answers, visible)}
                disabled={disabled}
                issues={issues}
                onChange={(next) => onChange(field.key, next)}
              />
            </div>
          )
        })}

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
