/**
 * Reading one answer, per the type the template declared.
 *
 * A table rather than a chain of branches, deliberately. The old validator had
 * a hand-written rule per question, and its complexity waiver said so; a
 * dispatch table has one small function per type and no waiver to re-earn. If
 * one of these grows branches, that is the signal the design has drifted back
 * to what it replaced.
 *
 * **Normalization happens here, not in a pattern.** `EMAIL` and `PHONE` are
 * types rather than patterns precisely so the server can own lower-casing and
 * separator-stripping — a cycle can still constrain them further with a
 * pattern, but it cannot make two spellings of one address compare unequal.
 */
import { cleanLongText, cleanLower, cleanPhone, cleanText, cleanUpper } from '../text'
import { parseDateOnly } from '../validation'
import type { ValidationIssueCode } from './codes'
import type { AnswerValue, FormField } from './types'

export type Coerced =
  | { readonly ok: true; readonly value: AnswerValue }
  | { readonly ok: false; readonly code: ValidationIssueCode; readonly message: string }

const bad = (code: ValidationIssueCode, message: string): Coerced => ({
  ok: false,
  code,
  message,
})

/**
 * `-0` collapses to `0`.
 *
 * Not cosmetic: the no-op check and the change diff both compare answers, and
 * `-0` stored where `0` was sent would report an edit that never happened on
 * every save.
 */
const normalizeNumber = (value: number): number => (Object.is(value, -0) ? 0 : value)

const text = (value: unknown, field: FormField, normalize: (v: string) => string | null): Coerced => {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return bad('INVALID_TYPE', `${field.label} must be text.`)
  }
  return { ok: true, value: normalize(value) }
}

const wholeNumber = (
  value: unknown,
  field: FormField,
  code: ValidationIssueCode,
  noun: string,
): Coerced => {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return bad(code, `${field.label} must be ${noun}.`)
  }
  // Refused rather than rounded: silently accepting 1.5 paise would store a
  // number nobody sent, and an amount is the worst place to guess.
  if (!Number.isSafeInteger(value)) {
    return bad(code, `${field.label} must be ${noun}.`)
  }
  return { ok: true, value: normalizeNumber(value) }
}

const choice = (value: unknown, field: FormField): Coerced => {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return bad('INVALID_TYPE', `Choose one of the options for ${field.label}.`)
  }
  const cleaned = cleanText(value)
  if (cleaned === null) return { ok: true, value: null }
  if (!field.options.some((option) => option.value === cleaned)) {
    return bad('INVALID_ENUM', `Choose one of the options for ${field.label}.`)
  }
  return { ok: true, value: cleaned }
}

const multipleChoice = (value: unknown, field: FormField): Coerced => {
  if (value === null || value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return bad('INVALID_TYPE', `Choose from the options for ${field.label}.`)
  }
  const selected: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return bad('INVALID_TYPE', `Choose from the options for ${field.label}.`)
    }
    if (!field.options.some((option) => option.value === entry)) {
      return bad('INVALID_ENUM', `Choose from the options for ${field.label}.`)
    }
    if (selected.includes(entry)) {
      return bad('DUPLICATE_SELECTION', `${field.label} lists the same choice twice.`)
    }
    selected.push(entry)
  }
  /*
   * Sorted into the template's own option order.
   *
   * The stored order is compared when deciding whether a save changed anything,
   * and a client is free to send selections in whatever order they were
   * clicked. Without a canonical order, re-selecting the same two choices in
   * the other order would read as an edit.
   */
  const position = new Map(field.options.map((option) => [option.value, option.position]))
  return {
    ok: true,
    value: selected.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)),
  }
}

/**
 * What an `EMAIL` and a `PHONE` have to look like.
 *
 * These are types rather than patterns a cycle authors, which is a promise
 * that the server knows what they mean — and `INVALID_EMAIL` and
 * `INVALID_PHONE` were in the closed code set from the first commit. Nothing
 * emitted them: both types normalised their input and then accepted whatever
 * was left, so a question labelled "Contact email" stored `not-an-email` and
 * the applicant found out when nobody could reach them.
 *
 * **Deliberately loose.** Neither is RFC 5322 or E.164, and neither should be:
 * a stricter rule rejects addresses and numbers that work, and every rejection
 * falls on somebody who cannot argue with it. What they catch is input that
 * cannot be an address or a number at all. A cycle wanting more can still add
 * a pattern; it cannot make two spellings of one address compare unequal,
 * because normalisation happened above.
 *
 * Both are anchored, bounded and free of nested quantifiers — they run on a
 * Worker CPU budget against input a `maxLength` has already capped.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u

/** Optional `+`, then 8 to 15 digits — separators are stripped above. */
const PHONE_SHAPE = /^\+?\d{8,15}$/u

/** One coercer per declared type. Exhaustive by construction. */
export const coerceAnswer = (field: FormField, value: unknown): Coerced => {
  switch (field.type) {
    case 'TEXT':
      return text(value, field, (v) => cleanText(v))
    // Its own coercer, because `cleanText` collapses every run of whitespace —
    // which is right for a name and destroys the paragraphs of a business plan.
    case 'LONG_TEXT':
      return text(value, field, (v) => cleanLongText(v))
    case 'EMAIL': {
      const cleaned = text(value, field, (v) => cleanLower(v))
      if (!cleaned.ok || cleaned.value === null) return cleaned
      if (!EMAIL_SHAPE.test(String(cleaned.value))) {
        return bad('INVALID_EMAIL', `${field.label} must be an email address.`)
      }
      return cleaned
    }
    case 'PHONE': {
      const cleaned = text(value, field, (v) => cleanPhone(v))
      if (!cleaned.ok || cleaned.value === null) return cleaned
      if (!PHONE_SHAPE.test(String(cleaned.value))) {
        return bad('INVALID_PHONE', `${field.label} must be a phone number.`)
      }
      return cleaned
    }
    case 'DATE': {
      const cleaned = text(value, field, (v) => cleanUpper(v))
      if (!cleaned.ok || cleaned.value === null) return cleaned
      if (parseDateOnly(String(cleaned.value)) === null) {
        return bad('INVALID_DATE', `${field.label} must be a real date, as YYYY-MM-DD.`)
      }
      return cleaned
    }
    case 'INTEGER':
      return wholeNumber(value, field, 'INVALID_INTEGER', 'a whole number')
    case 'MONEY_PAISE': {
      const amount = wholeNumber(value, field, 'INVALID_MONEY', 'an amount in paise')
      if (!amount.ok || amount.value === null) return amount
      if (typeof amount.value === 'number' && amount.value < 0) {
        return bad('INVALID_MONEY', `${field.label} cannot be negative.`)
      }
      return amount
    }
    case 'BOOLEAN':
    case 'ATTESTATION':
      if (value === null || value === undefined) return { ok: true, value: null }
      if (typeof value !== 'boolean') {
        return bad('INVALID_BOOLEAN', `Answer yes or no to ${field.label}.`)
      }
      return { ok: true, value }
    case 'SINGLE_CHOICE':
      return choice(value, field)
    case 'MULTI_CHOICE':
      return multipleChoice(value, field)
    case 'FILE':
      /*
       * A file is evidence, not an answer.
       *
       * It has its own versioned row, its own soft deletion and its own scan
       * result. Accepting a value here — even null — would put a permanently
       * empty slot in the answer set that invites somebody to write to it, and
       * would make the answered keys disagree with the answerable ones.
       */
      return bad(
        'FILE_ANSWER_NOT_ALLOWED',
        `${field.label} is a document. Upload it rather than answering it.`,
      )
    case 'STATEMENT':
      // Read, never answered — even null would put a writable-looking slot in
      // the answer set, the same trap the FILE case above refuses.
      return bad(
        'STATEMENT_ANSWER_NOT_ALLOWED',
        `${field.label} is a statement to read. It does not take an answer.`,
      )
    case 'REPEAT_GROUP':
      // Handled by the engine, which walks each entry's members itself.
      return bad('INVALID_TYPE', `${field.label} is a repeated group.`)
  }
}
