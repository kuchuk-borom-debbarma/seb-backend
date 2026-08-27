/**
 * The controls the form is built from.
 *
 * These were already generic — only their callers were hand-written, one per
 * question. They move here unchanged so that what the renderer draws is exactly
 * what the six hand-built sections drew, which is what makes the ~150
 * label-addressed end-to-end assertions a proof that the cutover preserved
 * behaviour rather than a set of tests to rewrite.
 */
import { Explain } from '#/features/guide/Explain'

export const orNull = (value: string): string | null => (value.trim() === '' ? null : value)

/** One labelled control, with the API's own message for the field beneath it. */
export function Field({
  id,
  label,
  hint,
  note,
  tone,
  widthHint,
  issue,
  explain,
  children,
}: {
  id: string
  label: string
  hint?: string
  /** The cycle's own inline hint under the control, styled by `tone`. */
  note?: string | null
  tone?: string | null
  /** The cycle's width token; the stylesheet maps it to a max width. */
  widthHint?: string | null
  issue?: string
  /** Why this question is asked, for the few where the name does not say. */
  explain?: string
  children: React.ReactNode
}) {
  return (
    <div {...(widthHint ? { 'data-width': widthHint } : {})}>
      {/*
        The explanation sits beside the label, not inside it. A control inside a
        <label> becomes part of the field's accessible name — the select would
        have announced as "Category ?".
      */}
      {explain ? (
        <span className="label-row">
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          <Explain label={label}>{explain}</Explain>
        </span>
      ) : (
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {note ? (
        <span className="field-note" {...(tone ? { 'data-tone': tone } : {})}>
          {note}
        </span>
      ) : null}
      {issue ? (
        <span className="field-error" id={`${id}-error`}>
          {issue}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  )
}

/**
 * A block of prose the cycle asks the applicant to read. Takes no answer at
 * all — the server refuses one — so it renders as a notice, toned by the
 * template, and never as a control.
 */
export function Statement({
  id,
  title,
  body,
  tone,
}: {
  id: string
  title: string
  body?: string | null
  tone?: string | null
}) {
  const noticeTone =
    tone === 'WARNING' || tone === 'DANGER' ? 'error' : tone === 'SUCCESS' ? 'ok' : 'action'
  return (
    <p className="notice" data-tone={noticeTone} id={id} tabIndex={-1}>
      <span className="notice-title">{title}</span>
      {body ?? null}
    </p>
  )
}

/**
 * A required yes/no question.
 *
 * Deliberately not a checkbox. A checkbox has two states and this question has
 * three: yes, no, and not answered yet — and the API tells them apart, treating
 * an unanswered question as a validation issue while "no" is a complete answer.
 * An unticked box looks answered and is not, which is how somebody reaches the
 * submit screen and is told a question they never saw is missing.
 */
export function YesNoField({
  name,
  question,
  hint,
  explain,
  issue,
  value,
  disabled,
  onAnswer,
}: {
  name: string
  question: string
  hint?: string
  /** Why this question is asked, for the few where the wording does not say. */
  explain?: string
  issue?: string
  value: boolean | null | undefined
  disabled: boolean
  onAnswer: (answer: boolean) => void
}) {
  return (
    /*
     * The id and tabIndex are what let the review report link to this control.
     * Every issue there addresses `#<field>`, and a fieldset carries no id of
     * its own — so before this, "take me to the answer that is wrong" silently
     * did nothing for every yes/no question on the form. tabIndex makes it
     * focusable as well as scrollable, so arriving here also moves the caret.
     */
    <fieldset className="choice-field" id={name} tabIndex={-1} disabled={disabled}>
      {/*
        Beside the question, never inside the legend: a control in there becomes
        part of the group's accessible name, and the fieldset would announce as
        "Is a no-objection certificate needed for these premises? ?".
      */}
      {explain ? (
        <span className="label-row">
          <legend className="field-label">{question}</legend>
          <Explain label={question}>{explain}</Explain>
        </span>
      ) : (
        <legend className="field-label">{question}</legend>
      )}
      <div className="choice-row">
        {ANSWERS.map((answer) => (
          <label className="choice" key={answer.label}>
            <input
              type="radio"
              name={name}
              checked={value === answer.value}
              onChange={() => onAnswer(answer.value)}
              {...(issue ? { 'aria-describedby': `${name}-error` } : {})}
            />
            {answer.label}
          </label>
        ))}
      </div>
      {issue ? (
        <span className="field-error" id={`${name}-error`}>
          {issue}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </fieldset>
  )
}

/**
 * A single statement the applicant confirms.
 *
 * Unlike a yes/no question there is only one acceptable answer, so a checkbox
 * is the honest control: the API's rule is "must be confirmed", not "must be
 * answered". The refusal to confirm is expressed by leaving it unticked, and
 * the API's own message says what that costs.
 */
export function Attestation({
  id,
  statement,
  issue,
  checked,
  disabled,
  onChange,
}: {
  id: string
  statement: string
  issue?: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div>
      <div className="checkbox-row">
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          {...(issue ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {})}
        />
        <label htmlFor={id}>{statement}</label>
      </div>
      {issue ? (
        <span className="field-error" id={`${id}-error`}>
          {issue}
        </span>
      ) : null}
    </div>
  )
}

const ANSWERS = [
  { label: 'Yes', value: true },
  { label: 'No', value: false },
] as const


export type FieldIssues = Record<string, string>

/** Marks a control invalid so the browser and assistive technology agree. */
export const invalid = (issues: FieldIssues, field: string) =>
  issues[field]
    ? ({ 'aria-invalid': true, 'aria-describedby': `${field}-error` } as const)
    : {}
