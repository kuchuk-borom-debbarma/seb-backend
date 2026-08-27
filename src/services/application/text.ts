/**
 * Normalizing typed text, in one place.
 *
 * Two callers need exactly this: the enterprise profile, whose fields are a
 * fixed typed contract, and the form engine, whose fields a cycle declares.
 * They were the same three lines twice, and two spellings of "what counts as
 * empty" is the kind of difference that shows up as an enterprise named `" "`
 * passing where the same value on a form is refused.
 */

/**
 * Trims, collapses internal whitespace, and treats what is left of nothing as
 * nothing.
 *
 * Returning `null` for an empty result is what makes "unanswered" a single
 * state: without it a cleared control sends `""`, a never-touched one sends
 * `null`, and every downstream check has to know both.
 */
export const cleanText = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const cleaned = value.trim().replace(/\s+/gu, ' ')
  return cleaned === '' ? null : cleaned
}

/**
 * The same, for an answer that is meant to have paragraphs.
 *
 * `cleanText` collapses every run of whitespace to one space, which is right
 * for a name and wrong for a business plan: a `LONG_TEXT` question is exactly
 * where somebody writes several paragraphs, and sharing the short coercer meant
 * their line breaks were **silently destroyed on save**. Nothing failed; the
 * text came back as one block.
 *
 * What is still normalised is what carries no meaning: line endings become
 * `\n` so two platforms compare equal, trailing spaces on a line go, runs of
 * spaces and tabs *within* a line collapse, and more than one blank line in a
 * row becomes one. What survives is the shape the applicant gave it.
 *
 * **Leading space on a line is kept**, unlike trailing. Somebody indenting a
 * list has said something with it; somebody leaving a space at the end of a
 * line has not.
 */
export const cleanLongText = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const cleaned = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return cleaned === '' ? null : cleaned
}

/** Cleaned and upper-cased, for identifiers people type in either case. */
export const cleanUpper = (value: string | null | undefined): string | null =>
  cleanText(value)?.toUpperCase() ?? null

/** Cleaned and lower-cased, for addresses where case carries no meaning. */
export const cleanLower = (value: string | null | undefined): string | null =>
  cleanText(value)?.toLowerCase() ?? null

/**
 * A telephone number with its formatting removed.
 *
 * People type spaces, brackets and dashes; none of them are part of the number,
 * and keeping them would make two spellings of one number compare unequal.
 */
export const cleanPhone = (value: string | null | undefined): string | null =>
  cleanText(value)?.replace(/[\s()-]/gu, '') || null
