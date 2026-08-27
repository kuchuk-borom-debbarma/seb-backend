/**
 * The bounds a cycle declares for one answer.
 *
 * Every rule here is the template's, not the programme's: a length, a range, a
 * pattern. The three rules that read cycle *policy* rather than template rows —
 * the applicant age band, the category-versus-age check and the funding ceiling
 * — cannot be expressed as a field bound and stay hand-written in the engine.
 *
 * Messages come from the template where it supplies one. That is not only
 * convenience: whether a cycle demands a GSTIN at all is the cycle's decision,
 * so how to word the refusal belongs with whoever made it.
 */
import { parseDateOnly } from '../validation'
import type { ValidationIssueCode } from './codes'
import type { AnswerValue, FormField } from './types'

export type RuleFailure = {
  readonly code: ValidationIssueCode
  readonly message: string
}

const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/*
 * Three checkers, one per shape of answer, and the dispatch below.
 *
 * Split because they had grown into one function of a hundred and thirteen
 * lines in which a date bound and a string length sat under the same `rules`,
 * and the only thing separating them was a `typeof` several screens up.
 */
/** Length and format, for the four types whose answer is written text. */
const textRules = (field: FormField, value: string): RuleFailure | null => {
  const { rules } = field
  if (rules.minLength !== null && value.length < rules.minLength) {
    return {
      code: 'TOO_SHORT',
      message: `${field.label} must be at least ${rules.minLength} characters.`,
    }
  }
  /*
   * Length before pattern, and that order is load-bearing.
   *
   * The expression is authored by a programme officer and runs on a Worker
   * CPU budget. Testing a bounded string first is what stops a pathological
   * pattern being handed an unbounded one — which is why the schema refuses a
   * patterned field that declares no cap.
   */
  if (rules.maxLength !== null && value.length > rules.maxLength) {
    return {
      code: 'TOO_LONG',
      message: `${field.label} must be ${rules.maxLength} characters or fewer.`,
    }
  }
  if (field.compiledPattern !== null && !field.compiledPattern.test(value)) {
    return {
      code: 'PATTERN_MISMATCH',
      // Never the expression itself: it is authoring detail, it means nothing
      // to an applicant, and it is exactly the sort of internal shape the
      // security rules say must not be disclosed.
      message: rules.patternMessage ?? `${field.label} is not in the expected format.`,
    }
  }
  return null
}

/** The numeric range, worded as rupees where the question is an amount. */
const numberRules = (field: FormField, value: number): RuleFailure | null => {
  const { rules } = field
  if (rules.minValue !== null && value < rules.minValue) {
    return {
      code: 'TOO_SMALL',
      message:
        field.type === 'MONEY_PAISE'
          ? `${field.label} must be at least ${rupees(rules.minValue)}.`
          : `${field.label} must be at least ${rules.minValue}.`,
    }
  }
  if (rules.maxValue !== null && value > rules.maxValue) {
    return {
      code: 'TOO_LARGE',
      message:
        field.type === 'MONEY_PAISE'
          ? `${field.label} cannot be more than ${rupees(rules.maxValue)}.`
          : `${field.label} cannot be more than ${rules.maxValue}.`,
    }
  }
  return null
}

/** Fixed and relative date bounds. */
const dateRules = (field: FormField, value: string, now: Date): RuleFailure | null => {
  const { rules } = field
  const answered = parseDateOnly(value)
  // Unparseable dates were already refused during coercion.
  if (answered === null) return null

  if (rules.minDate !== null) {
    const floor = parseDateOnly(rules.minDate)
    if (floor && answered.getTime() < floor.getTime()) {
      return { code: 'DATE_TOO_EARLY', message: `${field.label} cannot be before ${rules.minDate}.` }
    }
  }
  if (rules.maxDate !== null) {
    const ceiling = parseDateOnly(rules.maxDate)
    if (ceiling && answered.getTime() > ceiling.getTime()) {
      return { code: 'DATE_TOO_LATE', message: `${field.label} cannot be after ${rules.maxDate}.` }
    }
  }
  /*
   * Relative bounds resolve against the write's own instant, never `new
   * Date()` read here. The validator and the write that follows it must agree
   * about what "today" is, and a request that straddles midnight would
   * otherwise validate against one day and store against another.
   */
  if (rules.relativeDateBound === 'NOT_FUTURE' && answered.getTime() > now.getTime()) {
    return { code: 'DATE_TOO_LATE', message: `${field.label} cannot be in the future.` }
  }
  if (rules.relativeDateBound === 'NOT_PAST' && answered.getTime() < startOfDay(now)) {
    return { code: 'DATE_TOO_EARLY', message: `${field.label} cannot be in the past.` }
  }
  return null
}

/**
 * How many choices were taken — the ceiling only.
 *
 * Choosing too many is something the applicant has *done* and can undo, so it
 * is refused on the way in, against the control they just clicked.
 *
 * The floor is completeness — see `checkSelectionMinimum` — and belongs to
 * submission. An unanswered multiple choice normalises to the empty list, and
 * an empty list is still a list, so checking the minimum here refused every
 * save until the question was answered: the applicant could not keep what they
 * had already typed elsewhere on the form.
 */
const selectionRules = (field: FormField, value: readonly string[]): RuleFailure | null => {
  const { maxLength } = field.rules
  if (maxLength !== null && value.length > maxLength) {
    return {
      code: 'TOO_MANY_SELECTED',
      message: `Choose no more than ${maxLength} for ${field.label}.`,
    }
  }
  return null
}

/**
 * Checks one already-coerced answer against its field's declared bounds.
 *
 * Returns the first failure rather than all of them: a single answer that is
 * both too short and badly formatted has one thing wrong with it as far as the
 * person typing is concerned, and two messages under one control reads as a
 * malfunction.
 *
 * An unanswered field has no bounds to break — whether it is *allowed* to be
 * unanswered is a requiredness question, decided elsewhere.
 */
export const checkFieldRules = (
  field: FormField,
  value: AnswerValue,
  now: Date,
): RuleFailure | null => {
  if (value === null) return null

  const written = field.type === 'TEXT' || field.type === 'LONG_TEXT'
    || field.type === 'EMAIL' || field.type === 'PHONE'
  if (written && typeof value === 'string') return textRules(field, value)
  if (typeof value === 'number') return numberRules(field, value)
  if (field.type === 'DATE' && typeof value === 'string') return dateRules(field, value, now)
  if (Array.isArray(value)) return selectionRules(field, value)
  return null
}

/**
 * How many selections a question needs before the form can be sent.
 *
 * Separate from `checkFieldRules` because it is a completeness rule and the
 * two tiers are the point: a save says "is this a well-formed answer", and
 * submission says "is this enough". Only called from the second.
 */
export const checkSelectionMinimum = (
  field: FormField,
  value: AnswerValue,
): RuleFailure | null => {
  const { minLength } = field.rules
  if (minLength === null || !Array.isArray(value) || value.length >= minLength) return null
  return {
    code: 'TOO_FEW_SELECTED',
    message: `Choose at least ${minLength} for ${field.label}.`,
  }
}

/** Midnight UTC on the day of `now`, so "not in the past" means "not before today". */
const startOfDay = (now: Date): number =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

/** How many entries a repeated group may carry. */
export const checkRepeatBounds = (field: FormField, entries: number): RuleFailure | null => {
  const { minRepeat, maxRepeat } = field.rules
  if (minRepeat !== null && entries < minRepeat) {
    return {
      code: 'TOO_FEW_ENTRIES',
      message: `Add at least ${minRepeat} to ${field.label}.`,
    }
  }
  if (maxRepeat !== null && entries > maxRepeat) {
    return {
      code: 'TOO_MANY_ENTRIES',
      message: `${field.label} cannot have more than ${maxRepeat}.`,
    }
  }
  return null
}
