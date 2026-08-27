/**
 * The two things done to every answer set, and the only two.
 *
 * `normalizeAnswers` runs on every save: shape, unknown keys, presence,
 * coercion, and the bounds a field declares. `validateAnswersForSubmission`
 * runs when an application is actually sent, and adds completeness, relevance,
 * documents and the three programme rules that read cycle policy.
 *
 * The split is inherited deliberately from the validator this replaces. The
 * relevance rule in particular belongs at submission and not at save: moving it
 * earlier means an applicant who flips a yes/no to "no" cannot save until they
 * have also cleared the three answers that question was hiding, which is a
 * refusal they cannot act on from the screen they are looking at.
 */
import { addUtcCalendarMonths, parseDateOnly } from '../validation'
import { pruneHidden } from './answers'
import { isRequiredWhenVisible, isAnswered, visibleFields } from './conditions'
import { issue, issuePath, type ValidationIssue } from './codes'
import { coerceAnswer } from './coerce'
import { checkFieldRules, checkRepeatBounds, checkSelectionMinimum } from './rules'
import { groupMembers } from './template'
import type {
  AnswerEntry,
  AnswerMap,
  AnswerValue,
  CyclePolicy,
  FormField,
  ResolvedFormTemplate,
  EnterpriseFacts,
} from './types'

/**
 * How much answer one application may carry.
 *
 * The GraphQL body limit is 64 KB and counts the whole request, so a template
 * generous enough to exceed this could be opened and then never submitted
 * against. The authoring write checks the same budget from the template's own
 * declared caps, which is what turns "no applicant can submit" into "this cycle
 * cannot be opened".
 */
export const MAX_ANSWER_BYTES = 32 * 1024

export type NormalizedAnswers = {
  readonly value: AnswerMap | null
  readonly issues: readonly ValidationIssue[]
}

export type ValidationReport = {
  readonly valid: boolean
  readonly issues: readonly ValidationIssue[]
}

const stageOf = (template: ResolvedFormTemplate, key: string): string =>
  template.byKey.get(key)?.stageKey ?? template.stages[0]?.key ?? 'UNKNOWN'

/** Tier A. Every save. Shape, presence, type and the template's own bounds. */
/**
 * One repeated group's entries, coerced entry by entry.
 *
 * Its own function because it is a second, nested copy of the loop above — the
 * same total-replacement rule, the same coercion, the same per-question rules,
 * one level down. Keeping it inline made `normalizeAnswers` a hundred and
 * ninety lines in which the two loops looked alike enough to read as one, and
 * a guard added to the outer one and forgotten in this one is exactly the
 * defect this repository already found here once.
 */
const coerceGroup = (
  template: ResolvedFormTemplate,
  field: FormField,
  given: unknown,
  now: Date,
): { entries: readonly AnswerEntry[]; issues: ValidationIssue[] } => {
  const issues: ValidationIssue[] = []
  // An unanswered group is no entries, not an error: a draft is saved long
  // before it is finished, and how many it must have is the submission's rule.
  if (given === null || given === undefined) return { entries: [], issues }
  if (!Array.isArray(given)) {
    return {
      entries: [],
      issues: [issue(field.stageKey, field.key, 'INVALID_TYPE', `${field.label} must be a list.`)],
    }
  }

  const members = groupMembers(template, field.key)
  const entries: AnswerEntry[] = []
  given.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push(
        issue(field.stageKey, issuePath('', field.key, index), 'INVALID_TYPE',
          `Each ${field.label} entry must be a set of answers.`),
      )
      return
    }
    const row = entry as Record<string, unknown>
    const coercedRow: Record<string, AnswerValue> = {}
    for (const member of members) {
      /*
       * The same two exclusions the top-level loop makes.
       *
       * A guard that holds at two of three entry points is a boundary
       * maintained by vigilance. A server-derived member inside a group would
       * otherwise be coerced, stored and read back by a reviewer as
       * programme-derived fact rather than as an applicant's claim.
       */
      if (member.source === 'SERVER_DERIVED' || member.type === 'FILE') continue
      const path = issuePath(member.key, field.key, index)
      if (!Object.prototype.hasOwnProperty.call(row, member.key)) {
        issues.push(
          issue(member.stageKey, path, 'MISSING_SNAPSHOT_FIELD',
            `The replacement answers must include ${member.label}.`),
        )
        continue
      }
      const coerced = coerceAnswer(member, row[member.key])
      if (!coerced.ok) {
        issues.push(issue(member.stageKey, path, coerced.code, coerced.message))
        continue
      }
      const broken = checkFieldRules(member, coerced.value, now)
      if (broken) {
        issues.push(issue(member.stageKey, path, broken.code, broken.message))
        continue
      }
      coercedRow[member.key] = coerced.value
    }
    entries.push(coercedRow)
  })
  return { entries, issues }
}

export const normalizeAnswers = (
  template: ResolvedFormTemplate,
  submitted: unknown,
  now: Date,
): NormalizedAnswers => {
  const issues: ValidationIssue[] = []
  const firstStage = template.stages[0]?.key ?? 'UNKNOWN'

  /*
   * The schema can no longer type the keys, so this is the only thing between
   * a client and the stored answers. Every guarantee GraphQL used to give for
   * free — that a key exists, that a value has the right type, that an enum
   * member is a member — now lives here.
   */
  if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) {
    return {
      value: null,
      issues: [
        issue(firstStage, '', 'MALFORMED_ANSWERS', 'The answers must be sent as an object.'),
      ],
    }
  }
  const raw = submitted as Record<string, unknown>

  /*
   * An unrecognised key is refused, never dropped.
   *
   * A browser holding a form from an older cycle version would otherwise get
   * `success: true` and watch its answers disappear — the worst possible
   * outcome, because nothing tells the applicant their work was discarded. The
   * refusal has to say to reload the form.
   */
  for (const key of Object.keys(raw)) {
    const field = template.byKey.get(key)
    if (!field) {
      issues.push(
        issue(firstStage, key, 'UNKNOWN_FIELD',
          'This form has changed. Reload the page and try again.'),
      )
      continue
    }
    if (field.type === 'FILE') {
      issues.push(
        issue(field.stageKey, key, 'FILE_ANSWER_NOT_ALLOWED',
          `${field.label} is a document. Upload it rather than answering it.`),
      )
    }
    if (field.type === 'STATEMENT') {
      // Same trap as FILE: a statement is read, and a key addressed to it
      // would put a writable-looking slot in the answer set.
      issues.push(
        issue(field.stageKey, key, 'STATEMENT_ANSWER_NOT_ALLOWED',
          `${field.label} is a statement to read. It does not take an answer.`),
      )
    }
    if (field.source === 'SERVER_DERIVED') {
      // These are computed from the award and the ledger. Accepting one from an
      // applicant would let them assert their own prior funding.
      issues.push(
        issue(field.stageKey, key, 'UNKNOWN_FIELD',
          `${field.label} is recorded by the programme office and cannot be answered.`),
      )
    }
    /*
     * A member of a repeated group, sent at the top level.
     *
     * This gate was matching against `byKey`, which holds every field — so a
     * member key was *found*, no issue was raised, and the loop below skipped
     * it because members are only read inside their group. The applicant got
     * `success: true` and the answer was never stored, which is precisely the
     * silent drop this gate exists to prevent; it was only closed against keys
     * the template does not declare at all.
     */
    if (field.repeatGroupKey !== null) {
      issues.push(
        issue(field.stageKey, key, 'UNKNOWN_FIELD',
          `${field.label} is answered inside ${
            template.byKey.get(field.repeatGroupKey)?.label ?? field.repeatGroupKey
          }, not on its own.`),
      )
    }
  }

  const value: Record<string, AnswerValue | readonly AnswerEntry[]> = {}

  for (const field of template.fields) {
    // A statement is skipped like FILE: the gate above already refused any
    // value addressed to it, and there is nothing to coerce.
    if (field.repeatGroupKey !== null || field.type === 'FILE') continue
    if (field.type === 'STATEMENT') continue
    if (field.source === 'SERVER_DERIVED') continue

    /*
     * A save replaces the whole answer set rather than merging into it, so an
     * absent key is an error and an explicit null is a cleared answer. Without
     * that distinction there is no way to take an optional answer back.
     */
    if (!Object.prototype.hasOwnProperty.call(raw, field.key)) {
      issues.push(
        issue(field.stageKey, field.key, 'MISSING_SNAPSHOT_FIELD',
          `The replacement answers must include ${field.label}.`),
      )
      continue
    }

    if (field.type === 'REPEAT_GROUP') {
      const group = coerceGroup(template, field, raw[field.key], now)
      issues.push(...group.issues)
      value[field.key] = group.entries
      continue
    }

    const coerced = coerceAnswer(field, raw[field.key])
    if (!coerced.ok) {
      issues.push(issue(field.stageKey, field.key, coerced.code, coerced.message))
      continue
    }
    const broken = checkFieldRules(field, coerced.value, now)
    if (broken) {
      issues.push(issue(field.stageKey, field.key, broken.code, broken.message))
      continue
    }
    value[field.key] = coerced.value
  }

  if (issues.length > 0) return { value: null, issues }

  /*
   * Measured in bytes, not characters.
   *
   * `String.length` counts UTF-16 code units, so a form answered in Bengali or
   * Kokborok — which this programme's applicants write in — would be counted at
   * roughly a third of what it actually costs on the wire and in storage. The
   * budget exists to stay under a byte limit, so it has to be a byte count.
   */
  const encoded = new TextEncoder().encode(JSON.stringify(value))
  if (encoded.byteLength > MAX_ANSWER_BYTES) {
    return {
      value: null,
      issues: [
        issue(firstStage, '', 'ANSWERS_TOO_LARGE',
          'The answers are too long to save. Shorten the longest ones and try again.'),
      ],
    }
  }

  return { value, issues: [] }
}

/**
 * The relevance rule: an answer to a question that is no longer being asked.
 *
 * Reported once, against the question that put the others away, and naming
 * them — which is what the old form did with three government-funding fields
 * and one message. Three issues on three controls the applicant cannot see
 * would be three refusals they cannot act on.
 */
const relevanceIssues = (
  template: ResolvedFormTemplate,
  answers: AnswerMap,
  visible: ReadonlySet<string>,
): ValidationIssue[] => {
  const strays = template.fields.filter(
    (field) =>
      field.repeatGroupKey === null &&
      field.type !== 'FILE' &&
      !visible.has(field.key) &&
      isAnswered(answers[field.key]),
  )
  if (strays.length === 0) return []

  // Attribute the stray answers to whichever question controls them, so the
  // message points at a control that is actually on the screen.
  const byController = new Map<string, FormField[]>()
  for (const stray of strays) {
    const controller = stray.conditions.find((condition) => condition.effect === 'VISIBLE_WHEN')
    const key = controller?.sourceFieldKey ?? stray.key
    byController.set(key, [...(byController.get(key) ?? []), stray])
  }

  return [...byController.entries()].map(([controllerKey, hidden]) => {
    const controller = template.byKey.get(controllerKey)
    const names = hidden.map((field) => field.label).join(', ')
    return issue(
      controller?.stageKey ?? stageOf(template, controllerKey),
      controllerKey,
      'CONDITIONAL_FIELDS',
      `Clear ${names} — your answer to ${controller?.label ?? 'an earlier question'} means ${
        hidden.length === 1 ? 'it is' : 'they are'
      } no longer asked.`,
    )
  })
}

/**
 * Whether a repeated group has enough entries, each answered enough.
 *
 * Extracted for the reason `coerceGroup` is: it is the nested twin of the loop
 * that follows, and two loops that look alike are two places a rule has to be
 * remembered. A member that is required is required in *every* entry, and the
 * issue names which one — an applicant told only that a partner's name is
 * missing would have to check each card themselves.
 */
const groupIsComplete = (
  template: ResolvedFormTemplate,
  field: FormField,
  answers: AnswerMap,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const entries = (answers[field.key] ?? []) as readonly AnswerEntry[]
  const bounds = checkRepeatBounds(field, entries.length)
  if (bounds) issues.push(issue(field.stageKey, field.key, bounds.code, bounds.message))

  const members = groupMembers(template, field.key)
  entries.forEach((entry, index) => {
    const entryVisible = visibleFields(template, answers, entry, field.key)
    for (const member of members) {
      if (member.source === 'SERVER_DERIVED' || member.type === 'FILE') continue
      if (!entryVisible.has(member.key)) continue
      /*
       * A role-bound member is required in every entry, whatever the template
       * flag says — the age rule reads the date of birth from each owner, and
       * an entry allowed to omit it would be an owner the rule cannot see.
       * The same reasoning as the top-level role-required rule below.
       */
      const memberRequired = member.role !== null
        || isRequiredWhenVisible(template, member, answers, entryVisible, entry, field.key)
      if (!memberRequired) continue
      if (!isAnswered(entry[member.key])) {
        issues.push(
          issue(member.stageKey, issuePath(member.key, field.key, index), 'REQUIRED',
            `${member.label} is needed before you can submit.`),
        )
      }
    }
  })
  return issues
}
/** Tier B. Submission only: completeness, relevance, documents and policy. */
export const validateAnswersForSubmission = (
  template: ResolvedFormTemplate,
  answers: AnswerMap,
  activeDocumentFieldKeys: ReadonlySet<string>,
  now: Date,
  policy: CyclePolicy,
  /*
   * Facts about the enterprise the application belongs to, for the rules that
   * read the entity rather than an answer. Optional because only the category
   * threshold needs it: a caller that passes nothing and sets no threshold
   * loses nothing, and the two production call sites both pass it.
   */
  facts?: EnterpriseFacts | null,
): ValidationReport => {
  const issues: ValidationIssue[] = []
  const visible = visibleFields(template, answers)

  for (const field of template.fields) {
    if (field.source === 'SERVER_DERIVED') continue
    if (field.repeatGroupKey !== null) continue
    /*
     * A file carries no answer, so "is it answered" is the wrong question to
     * ask of it — a required FILE field would otherwise be reported missing on
     * every submission, whatever had been uploaded. Whether the evidence is
     * present is decided further down, against the documents actually held.
     */
    if (field.type === 'FILE' || field.type === 'STATEMENT') continue
    if (!visible.has(field.key)) continue

    if (field.type === 'REPEAT_GROUP') {
      issues.push(...groupIsComplete(template, field, answers))
      continue
    }

    /*
     * A role-bound field is required whatever the template says, and a
     * role-bound amount must be positive.
     *
     * This is not a nicety. The programme's decision is bounded by the
     * requested amount, read straight off the submission; if a cycle could
     * publish a template leaving that field optional, an approval could be
     * compared against nothing at all. Making the requirement follow the role
     * rather than the flag is what keeps that impossible.
     */
    const roleBound = field.role !== null
    const required =
      roleBound || isRequiredWhenVisible(template, field, answers, visible)

    if (required && !isAnswered(answers[field.key])) {
      issues.push(
        issue(field.stageKey, field.key, 'REQUIRED',
          `${field.label} is needed before you can submit.`),
      )
      continue
    }
    if (roleBound && field.type === 'MONEY_PAISE') {
      const amount = answers[field.key]
      if (typeof amount !== 'number' || amount <= 0) {
        issues.push(
          issue(field.stageKey, field.key, 'TOO_SMALL',
            `${field.label} must be more than zero.`),
        )
        continue
      }
    }
    /*
     * An attestation has one acceptable answer; a yes/no question has two.
     *
     * `REQUIRED` on a `BOOLEAN` means it must be *answered*, and "no" answers
     * it — which the completeness check above already enforces. Only an
     * `ATTESTATION` must be true.
     */
    if (field.type === 'ATTESTATION' && answers[field.key] !== true) {
      issues.push(
        issue(field.stageKey, field.key, 'MUST_BE_TRUE',
          `${field.label} must be confirmed before you can submit.`),
      )
      continue
    }
    /*
     * How many selections a question needs. A completeness rule, so it lives
     * here rather than with the shape checks a save runs — an applicant part
     * way through choosing must still be able to keep the rest of the form.
     */
    const chosen = answers[field.key]
    const tooFew = checkSelectionMinimum(field, Array.isArray(chosen) ? chosen : null)
    if (tooFew) issues.push(issue(field.stageKey, field.key, tooFew.code, tooFew.message))
  }

  issues.push(...relevanceIssues(template, answers, visible))

  for (const key of requiredDocumentFieldKeys(template, answers)) {
    if (activeDocumentFieldKeys.has(key)) continue
    const field = template.byKey.get(key)
    issues.push(
      issue(field?.stageKey ?? stageOf(template, key), key, 'DOCUMENT_REQUIRED',
        `${field?.label ?? 'A document'} has not been uploaded.`),
    )
  }

  issues.push(...policyIssues(template, answers, now, policy, facts ?? null))

  return { valid: issues.length === 0, issues }
}

/**
 * The documents this application must carry.
 *
 * Exported because submission checks the same thing twice — once when
 * validating and again inside the guarded write, so a document deleted between
 * the two cannot slip past. Both must ask this one function, which is the
 * successor to the old `requiredDocumentTypes` and the reason it was named in
 * the one-rule-one-definition table.
 *
 * The four hard-coded conditions it used to carry — always, when registered,
 * when a GSTIN is present, when a no-objection certificate applies — are now
 * ordinary conditions against whatever fields the cycle happens to declare,
 * which is strictly more expressive and is the clearest sign the design is
 * right.
 */
export const requiredDocumentFieldKeys = (
  template: ResolvedFormTemplate,
  answers: AnswerMap,
): string[] => {
  const visible = visibleFields(template, answers)
  return template.fields
    .filter(
      (field) =>
        field.type === 'FILE' &&
        visible.has(field.key) &&
        (field.requirement === 'REQUIRED' ||
          isRequiredWhenVisible(template, field, answers, visible)),
    )
    .map((field) => field.key)
}

/**
 * The three rules that read cycle policy rather than template rows.
 *
 * They cannot become field bounds because their inputs are cycle scalars, not
 * anything an applicant answers. What they need from the template is only
 * *which field* carries the date of birth, the category and the requested
 * amount — which is exactly what the role bindings are for.
 */
/**
 * Which category this enterprise falls in, computed rather than asked.
 *
 * CATEGORY_A is the established side: trading for at least the cycle's
 * threshold (24 months by default) at the moment of submission. Null when the
 * cycle sets no threshold or the date is unknown — and the unknown case is
 * refused at submission by `ESTABLISHMENT_DATE_MISSING`, so a submitted
 * application on a sorting cycle always carries a category.
 */
export const applicationCategoryOf = (
  establishmentDate: string | null,
  thresholdMonths: number | null,
  now: Date,
): 'CATEGORY_A' | 'CATEGORY_B' | null => {
  if (thresholdMonths === null || establishmentDate === null) return null
  const from = parseDateOnly(establishmentDate)
  if (!from) return null
  return addUtcCalendarMonths(from, thresholdMonths).getTime() <= now.getTime()
    ? 'CATEGORY_A'
    : 'CATEGORY_B'
}

const policyIssues = (
  template: ResolvedFormTemplate,
  answers: AnswerMap,
  now: Date,
  policy: CyclePolicy,
  facts: EnterpriseFacts | null,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = []

  /*
   * Age. The date of birth usually lives inside the owners group, and the
   * rule is deliberately "at least one owner in band": a firm with a founder
   * of 30 and a retired parent as co-owner is eligible, and demanding every
   * owner be in band would refuse it for the member the rule was never about.
   * The issue attaches to the group key, which is a real control the client
   * can scroll to.
   */
  const min = policy.minimumApplicantAge
  const max = policy.maximumApplicantAge
  // Total on a resolved template: resolve refuses an unbound role.
  const dobField = template.byKey.get(template.roles.APPLICANT_DATE_OF_BIRTH)
  if (dobField && (min !== null || max !== null)) {
    const inBand = (value: unknown): boolean | null => {
      if (typeof value !== 'string') return null
      const born = parseDateOnly(value)
      if (!born) return null
      const age = fullYearsBetween(born, now)
      return !((min !== null && age < min) || (max !== null && age > max))
    }
    if (dobField.repeatGroupKey === null) {
      if (inBand(answers[dobField.key]) === false) {
        issues.push(
          issue(dobField.stageKey, dobField.key, 'AGE_INELIGIBLE',
            `This programme is open to applicants aged ${min ?? 0} to ${max ?? 'any'}.`),
        )
      }
    } else {
      const group = template.byKey.get(dobField.repeatGroupKey)
      const entries = answers[dobField.repeatGroupKey]
      // Emptiness is the group's own REQUIRED rule; this one only judges the
      // dates actually given, so the two refusals never say the same thing.
      if (group && Array.isArray(entries) && entries.length > 0) {
        const someoneQualifies = entries.some(
          (entry) => inBand((entry as AnswerEntry)[dobField.key]) === true,
        )
        if (!someoneQualifies) {
          issues.push(
            issue(group.stageKey, group.key, 'AGE_INELIGIBLE',
              `At least one owner must be aged ${min ?? 0} to ${max ?? 'any'}.`),
          )
        }
      }
    }
  }

  /*
   * The category threshold reads the enterprise entity, not an answer — the
   * category itself is computed by the server at submission. What can still
   * fail here is the input being absent: an enterprise registered without an
   * establishment date cannot be sorted, and the fix lives on the enterprise
   * screen rather than in this form, which is what the message says.
   */
  if (policy.categoryAMaximumMonths !== null && facts && facts.establishmentDate === null) {
    const firstStage = template.stages[0]?.key ?? ''
    issues.push(
      issue(firstStage, 'ESTABLISHMENT_DATE', 'ESTABLISHMENT_DATE_MISSING',
        'This cycle sorts enterprises by how long they have traded, and this '
        + 'enterprise has no establishment date. Record it on the enterprise, '
        + 'then submit again.'),
    )
  }

  const requested = template.byKey.get(template.roles.SEED_FUND_REQUESTED_PAISE)
  const requestedValue = requested === undefined ? undefined : answers[requested.key]
  if (
    requested &&
    typeof requestedValue === 'number' &&
    policy.fundingCeilingState === 'RESOLVED' &&
    policy.fundingCeilingScope === 'APPLICATION' &&
    policy.fundingCeilingAmountPaise !== null &&
    requestedValue > policy.fundingCeilingAmountPaise
  ) {
    issues.push(
      issue(requested.stageKey, requested.key, 'FUNDING_CEILING_EXCEEDED',
        `The most this programme awards for one application is ₹${(
          policy.fundingCeilingAmountPaise / 100
        ).toLocaleString('en-IN')}.`),
    )
  }

  return issues
}

const fullYearsBetween = (from: Date, to: Date): number => {
  let years = to.getUTCFullYear() - from.getUTCFullYear()
  const monthDelta = to.getUTCMonth() - from.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && to.getUTCDate() < from.getUTCDate())) years -= 1
  return years
}
