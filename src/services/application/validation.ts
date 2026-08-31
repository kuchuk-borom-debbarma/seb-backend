import type { CyclePolicy } from './form/types'
/**
 * The rules that are still the software's rather than a cycle's.
 *
 * Everything about the *application form* moved to `form/`, where the template
 * says what the questions are. What is left is the enterprise profile — a fixed
 * record the portal owns, not a cycle's questionnaire — and the calendar
 * arithmetic the twelve-month expansion rule needs, which is shared rather than
 * duplicated because two implementations of "how many whole months" would
 * disagree at a month boundary.
 *
 * Pure: no database, no storage. That is what lets the validating read and the
 * submitting write apply the identical rule.
 */
import { businessSectors, registrationTypes, tripuraDistricts } from '../../db/schema'
import type { EnterpriseProfileInput, SuppliedEnterpriseProfile } from './types'

/**
 * The cycle scalars a submission is judged by.
 *
 * One name for one thing: the form engine calls it `CyclePolicy`, this is the
 * name the rest of the service already used, and two definitions of the same
 * record is exactly the duplication the envelope was extracted to avoid.
 */
export type SubmissionPolicy = CyclePolicy

const DEFAULT_SUBMISSION_POLICY: SubmissionPolicy = {
  minimumApplicantAge: 18,
  maximumApplicantAge: 60,
  categoryAMaximumMonths: 24,
  majorityOwnershipRequired: true,
  fundingCeilingState: 'UNRESOLVED',
  fundingCeilingAmountPaise: null,
  fundingCeilingScope: null,
}

const MAX_MONEY_PAISE = Number.MAX_SAFE_INTEGER
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
/*
 * Exactly ten digits after the optional '+91' is stripped: the programme is
 * Tripura's, so the contact is an Indian mobile, and one canonical spelling is
 * what lets two records of the same phone compare equal.
 */
const MOBILE_PATTERN = /^\d{10}$/u
const PIN_PATTERN = /^\d{6}$/u
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/u
const MAX_SHORT_TEXT = 200
const MAX_ADDRESS_TEXT = 500
const MAX_EMAIL_LENGTH = 254
const MIN_PRIOR_SUPPORT_YEAR = 1900
const MAX_PRIOR_SUPPORT_YEAR = 2026

/**
 * Accepts `undefined` as well as `null` because GraphQL omits absent nullable
 * input fields entirely. Treating only `null` as empty would throw on every
 * client that leaves an optional answer out instead of sending an explicit null.
 */
const cleanText = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const cleaned = value.trim().replace(/\s+/gu, ' ')
  return cleaned === '' ? null : cleaned
}

const cleanUpper = (value: string | null | undefined): string | null =>
  cleanText(value)?.toUpperCase() ?? null

export const parseDateOnly = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null
}

export const addUtcCalendarMonths = (value: Date, months: number): Date => {
  const day = value.getUTCDate()
  const target = new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months + 1,
      0,
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  )
  target.setUTCDate(Math.min(day, target.getUTCDate()))
  return target
}

export const fullUtcCalendarMonths = (from: Date, to: Date): number => {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    to.getUTCMonth() -
    from.getUTCMonth()
  if (addUtcCalendarMonths(from, months).getTime() > to.getTime()) months -= 1
  return Math.max(0, months)
}

/** The establishment-date refusal, or null where the date is acceptable. */
const establishmentDateProblem = (value: string | null, now: Date): string | null => {
  if (value === null) return null
  const established = parseDateOnly(value)
  if (established === null) return 'Enter a real establishment date in YYYY-MM-DD format.'
  // A date-only value parses to UTC midnight, so "today" always passes.
  if (established.getTime() > now.getTime()) {
    return 'The establishment date cannot be in the future.'
  }
  return null
}

/**
 * `now` is the write's own instant, threaded in rather than read here — see
 * the relative-bound note in `form/rules.ts` for why the validator and the
 * write that follows it must agree about what "today" is.
 */
export const normalizeEnterpriseProfile = (
  input: SuppliedEnterpriseProfile,
  now: Date,
): { value: EnterpriseProfileInput | null; message: string | null } => {
  const suppliedDistrict = cleanText(input.businessDistrict)
  const value: EnterpriseProfileInput = {
    ...input,
    name: cleanText(input.name) ?? '',
    establishmentDate: cleanText(input.establishmentDate),
    registrationNumber: cleanUpper(input.registrationNumber),
    gstin: cleanUpper(input.gstin),
    // Not a text field, so it needs the same absent-to-null collapse spelled
    // out; leaving it undefined would fail the sector rule below with a message
    // about an invalid sector rather than accepting an omitted optional answer.
    businessSector: input.businessSector ?? null,
    otherBusinessSector: cleanText(input.otherBusinessSector),
    businessBlockOrVillage: cleanText(input.businessBlockOrVillage),
    // `find` narrows by value: only a member of the closed set — never the
    // client's free text — can flow into the typed column.
    businessDistrict:
      tripuraDistricts.find((district) => district === suppliedDistrict) ?? null,
    businessPinCode: cleanText(input.businessPinCode),
    contactNumber:
      cleanText(input.contactNumber)?.replace(/[\s()-]/gu, '').replace(/^\+91/u, '') ?? null,
    contactEmail: cleanText(input.contactEmail)?.toLowerCase() ?? null,
  }
  if (value.name.length < 2 || value.name.length > 200) {
    return { value: null, message: 'Enterprise name must contain 2 to 200 characters.' }
  }
  if (!registrationTypes.includes(value.registrationType)) {
    return { value: null, message: 'Select a valid registration type.' }
  }
  /*
   * Companies, LLPs and OPCs hold a statutory number (CIN/LLPIN) from
   * incorporation, so the type without one is a contradiction. A sole
   * proprietorship has no incorporation instrument: it may quote a number it
   * happens to hold, or nothing — both are ordinary.
   */
  if (value.registrationType !== 'SOLE_PROPRIETORSHIP' && value.registrationNumber === null) {
    return { value: null, message: 'Enter the registration number for this registration type.' }
  }
  const establishmentProblem = establishmentDateProblem(value.establishmentDate, now)
  if (establishmentProblem !== null) {
    return { value: null, message: establishmentProblem }
  }
  if (value.gstin !== null && !GSTIN_PATTERN.test(value.gstin)) {
    return { value: null, message: 'Enter a valid GSTIN.' }
  }
  if (value.businessSector !== null && !businessSectors.includes(value.businessSector)) {
    return { value: null, message: 'Select a valid business sector.' }
  }
  if (value.businessSector === 'OTHER' && value.otherBusinessSector === null) {
    return { value: null, message: 'Describe the other business sector.' }
  }
  // An answered district that matched nothing above collapsed to null.
  if (suppliedDistrict !== null && value.businessDistrict === null) {
    return { value: null, message: 'Select one of the eight districts of Tripura.' }
  }
  if (value.businessPinCode !== null && !PIN_PATTERN.test(value.businessPinCode)) {
    return { value: null, message: 'Enter a six-digit PIN code.' }
  }
  if (value.contactNumber !== null && !MOBILE_PATTERN.test(value.contactNumber)) {
    return { value: null, message: 'Enter a 10-digit mobile number.' }
  }
  if (value.contactEmail !== null && !EMAIL_PATTERN.test(value.contactEmail)) {
    return { value: null, message: 'Enter a valid email address.' }
  }
  for (const [field, text, maximum] of [
    ['registration number', value.registrationNumber, MAX_SHORT_TEXT],
    ['other business sector', value.otherBusinessSector, MAX_SHORT_TEXT],
    ['block or village', value.businessBlockOrVillage, MAX_ADDRESS_TEXT],
    ['email address', value.contactEmail, MAX_EMAIL_LENGTH],
  ] as const) {
    if (text !== null && text.length > maximum) {
      return { value: null, message: `Enterprise ${field} must contain at most ${maximum} characters.` }
    }
  }
  return { value, message: null }
}
