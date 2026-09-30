/**
 * Field types and roles as the office reads them.
 *
 * `humanize` reads most enum names well, but not these: a money field is
 * stored in paise and typed in rupees, so "money paise" names the wrong unit,
 * and a role such as `SEED_FUND_REQUESTED_PAISE` is a key the programme reads,
 * not something a person would call it.
 */
import { humanize } from '#/lib/format'

/** A form field type, lower-case, for "Desired grant amount — money (₹)". */
export const fieldTypeWords = (type: string): string =>
  type === 'MONEY_PAISE' ? 'money (₹)' : humanize(type).toLowerCase()

const ROLE_WORDS: Readonly<Record<string, string>> = {
  SEED_FUND_REQUESTED_PAISE: 'the grant asked for',
  LOAN_REQUESTED_PAISE: 'the loan asked for',
  APPLICANT_DATE_OF_BIRTH: "the applicant's date of birth",
}

/** What the programme reads a role-bound question as: "the grant asked for". */
export const roleWords = (role: string): string => ROLE_WORDS[role] ?? humanize(role).toLowerCase()
