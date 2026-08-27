/**
 * Every reason an answer can be refused, and nothing else.
 *
 * The set is closed and exported as a GraphQL enum, so a client can branch on a
 * code rather than matching a sentence. That only works while the two agree, and
 * a test asserts they do — adding a member here without adding it to the schema
 * is meant to go red.
 *
 * ## Why the set shrank in some places and grew in others
 *
 * The old validator had a code per *question* — `INVALID_GSTIN`, `INVALID_PIN`.
 * Those cannot survive a form the schema has never seen: whether a cycle asks
 * for a GSTIN at all is now the cycle's decision. They become
 * `PATTERN_MISMATCH`, and the sentence the applicant reads comes from the
 * template's own `patternMessage` — which is more correct, because how to word
 * a rule belongs with whoever wrote the rule.
 *
 * What grew is the structural half. When the schema typed every key, GraphQL
 * refused a wrong shape before a resolver ran. It cannot any more, so the
 * engine has to, and each refusal needs a name.
 */
export const validationIssueCodes = [
  /* Structure. These exist because the wire format can no longer be typed. */
  'MALFORMED_ANSWERS',
  'UNKNOWN_FIELD',
  'MISSING_SNAPSHOT_FIELD',
  'FILE_ANSWER_NOT_ALLOWED',
  'STATEMENT_ANSWER_NOT_ALLOWED',
  'ANSWERS_TOO_LARGE',
  'TEMPLATE_UNAVAILABLE',

  /* Type and format. */
  'INVALID_TYPE',
  'INVALID_DATE',
  'INVALID_INTEGER',
  'INVALID_MONEY',
  'INVALID_BOOLEAN',
  'INVALID_ENUM',
  'INVALID_EMAIL',
  'INVALID_PHONE',
  'DUPLICATE_SELECTION',
  'PATTERN_MISMATCH',

  /* Bounds the template declares. */
  'TOO_SHORT',
  'TOO_LONG',
  'TOO_SMALL',
  'TOO_LARGE',
  'DATE_TOO_EARLY',
  'DATE_TOO_LATE',
  'TOO_FEW_SELECTED',
  'TOO_MANY_SELECTED',
  'TOO_FEW_ENTRIES',
  'TOO_MANY_ENTRIES',

  /* Completeness and relevance. */
  'REQUIRED',
  'MUST_BE_TRUE',
  'CONDITIONAL_FIELDS',
  'DOCUMENT_REQUIRED',

  /* Programme policy, which reads cycle scalars rather than template rows. */
  'AGE_INELIGIBLE',
  'ESTABLISHMENT_DATE_MISSING',
  'FUNDING_CEILING_EXCEEDED',
] as const

export type ValidationIssueCode = (typeof validationIssueCodes)[number]

/**
 * Where an issue happened, as a path the client can put on a control's `id`.
 *
 * A plain field key for an ordinary answer; `GROUP[2].MEMBER` inside a repeated
 * group, because "the partner's name" is several different answers and a link
 * that could only reach the group would drop somebody on the right screen and
 * the wrong row.
 *
 * The grammar is closed at one level of nesting, and the SDL says so, because a
 * client has to parse it.
 */
export const issuePath = (
  fieldKey: string,
  groupKey?: string | null,
  entryIndex?: number | null,
): string => {
  if (!groupKey || entryIndex === null || entryIndex === undefined) return fieldKey
  /*
   * The entry as a whole, when the fault is the entry rather than any question
   * in it — an entry that arrived as a string has no member to blame.
   *
   * Without this the path was `GROUP[0].`, with a trailing dot and nothing
   * after it. That matches no control on the screen, so the applicant was told
   * their second partner's details were wrong and had nothing to click.
   */
  if (fieldKey === '') return `${groupKey}[${entryIndex}]`
  return `${groupKey}[${entryIndex}].${fieldKey}`
}

/** One refusal, addressed to the applicant and to the control that produced it. */
export type ValidationIssue = {
  /** The template stage the field belongs to, so a client can group refusals. */
  stageKey: string
  /** The field, by `issuePath`. */
  field: string
  code: ValidationIssueCode
  /** What to show the applicant. Never names an internal rule or a pattern. */
  message: string
}

export const issue = (
  stageKey: string,
  field: string,
  code: ValidationIssueCode,
  message: string,
): ValidationIssue => ({ stageKey, field, code, message })
