/**
 * Reading the form a cycle version froze, and the answers given against it.
 *
 * ## Five reads, concurrently, and why not one
 *
 * The template is four tables plus the cycle's scalars. These are issued
 * together on the pool rather than in sequence, so the cost is one round trip's
 * latency rather than five — but it is five connections, which is real pressure
 * on a pooled edge connection and is the first thing to revisit if that becomes
 * the bottleneck.
 *
 * Folding them into a single statement is the better end state and is
 * deliberately not done yet: it needs a lateral aggregate per child, because a
 * flat join across all four is *quietly wrong*. Options and conditions both
 * hang off a field, so joining both multiplies rows — a field with six options
 * and three conditions yields eighteen, and the resolver would see each option
 * three times with nothing thrown. Whichever shape this ends up, that trap is
 * the reason it cannot simply be joined.
 *
 * **This must never be called inside a transaction.** A transaction is bound to
 * one connection, so these five would serialize on it and read as parallel
 * while costing five sequential hops.
 *
 * ## The policy comes with it
 *
 * Both paths that need the cycle's scalar policy — submission and its dry run —
 * need the template too, so they are read together. The draft-read path uses
 * only the template and carries four unread scalars, which costs less than the
 * extra hop separating them would add.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { Database } from '../../../db'
import {
  sebApplicationVersion,
  sebApplicationVersionAnswer,
  sebProgrammeCycleFormField,
  sebProgrammeCycleFormFieldCondition,
  sebProgrammeCycleFormFieldOption,
  sebProgrammeCycleFormStage,
  sebProgrammeCycleVersion,
} from '../../../db/schema'
import { resolveFormTemplate } from '../form/template'
import type {
  AnswerEntry,
  AnswerMap,
  AnswerValue,
  CyclePolicy,
  ResolvedFormTemplate,
} from '../form/types'

export type PinnedCycleRules = {
  readonly policy: CyclePolicy
  readonly template: ResolvedFormTemplate
}

/**
 * Every rule frozen into one cycle version.
 *
 * Returns `null` when the version does not exist or its template does not
 * resolve. The second case should be unreachable — the guarded write that
 * authored it refused an incoherent template and the schema refuses most of the
 * same things again — so it means the rows were edited by hand, and the caller
 * turns it into a refusal rather than a crash.
 */
export const findPinnedCycleRules = async (
  db: Database,
  programmeCycleId: string,
  programmeCycleVersion: number,
): Promise<PinnedCycleRules | null> => {
  /* Every child table is scoped to the same frozen version. */
  const pinned = (
    cycleColumn: PgColumn,
    versionColumn: PgColumn,
  ) => and(eq(cycleColumn, programmeCycleId), eq(versionColumn, programmeCycleVersion))

  const [versions, stages, fields, options, conditions] = await Promise.all([
    db
      .select({
        minimumApplicantAge: sebProgrammeCycleVersion.minimumApplicantAge,
        maximumApplicantAge: sebProgrammeCycleVersion.maximumApplicantAge,
        categoryAMaximumMonths: sebProgrammeCycleVersion.categoryAMaximumMonths,
        majorityOwnershipRequired: sebProgrammeCycleVersion.majorityOwnershipRequired,
        fundingCeilingState: sebProgrammeCycleVersion.fundingCeilingState,
        fundingCeilingAmountPaise: sebProgrammeCycleVersion.fundingCeilingAmountPaise,
        fundingCeilingScope: sebProgrammeCycleVersion.fundingCeilingScope,
      })
      .from(sebProgrammeCycleVersion)
      .where(
        and(
          eq(sebProgrammeCycleVersion.programmeCycleId, programmeCycleId),
          eq(sebProgrammeCycleVersion.version, programmeCycleVersion),
        ),
      )
      .limit(1),
    db
      .select({
        stageKey: sebProgrammeCycleFormStage.stageKey,
        title: sebProgrammeCycleFormStage.title,
        description: sebProgrammeCycleFormStage.description,
        iconName: sebProgrammeCycleFormStage.iconName,
        estimatedMinutes: sebProgrammeCycleFormStage.estimatedMinutes,
        sortOrder: sebProgrammeCycleFormStage.sortOrder,
      })
      .from(sebProgrammeCycleFormStage)
      .where(pinned(sebProgrammeCycleFormStage.programmeCycleId, sebProgrammeCycleFormStage.programmeCycleVersion))
      .orderBy(asc(sebProgrammeCycleFormStage.sortOrder)),
    db
      .select()
      .from(sebProgrammeCycleFormField)
      .where(pinned(sebProgrammeCycleFormField.programmeCycleId, sebProgrammeCycleFormField.programmeCycleVersion))
      .orderBy(asc(sebProgrammeCycleFormField.sortOrder)),
    db
      .select({
        fieldKey: sebProgrammeCycleFormFieldOption.fieldKey,
        optionValue: sebProgrammeCycleFormFieldOption.optionValue,
        optionLabel: sebProgrammeCycleFormFieldOption.optionLabel,
        optionDescription: sebProgrammeCycleFormFieldOption.optionDescription,
        iconName: sebProgrammeCycleFormFieldOption.iconName,
        sortOrder: sebProgrammeCycleFormFieldOption.sortOrder,
      })
      .from(sebProgrammeCycleFormFieldOption)
      .where(pinned(sebProgrammeCycleFormFieldOption.programmeCycleId, sebProgrammeCycleFormFieldOption.programmeCycleVersion))
      .orderBy(asc(sebProgrammeCycleFormFieldOption.sortOrder)),
    db
      .select({
        fieldKey: sebProgrammeCycleFormFieldCondition.fieldKey,
        effect: sebProgrammeCycleFormFieldCondition.effect,
        groupNumber: sebProgrammeCycleFormFieldCondition.groupNumber,
        sequenceNumber: sebProgrammeCycleFormFieldCondition.sequenceNumber,
        sourceFieldKey: sebProgrammeCycleFormFieldCondition.sourceFieldKey,
        operator: sebProgrammeCycleFormFieldCondition.operator,
        comparisonValue: sebProgrammeCycleFormFieldCondition.comparisonValue,
      })
      .from(sebProgrammeCycleFormFieldCondition)
      .where(pinned(sebProgrammeCycleFormFieldCondition.programmeCycleId, sebProgrammeCycleFormFieldCondition.programmeCycleVersion)),
  ])

  const version = versions[0]
  if (!version) return null

  const template = resolveFormTemplate({
    programmeCycleId,
    programmeCycleVersion,
    stages,
    fields: fields.map((row) => ({
      stageKey: row.stageKey,
      fieldKey: row.fieldKey,
      fieldType: row.fieldType,
      role: row.role,
      label: row.label,
      helpText: row.helpText,
      requirement: row.requirement,
      source: row.source,
      sortOrder: row.sortOrder,
      parentFieldKey: row.parentFieldKey,
      groupDefinitionKey: row.groupDefinitionKey,
      repeatMin: row.repeatMin,
      repeatMax: row.repeatMax,
      minLength: row.minLength,
      maxLength: row.maxLength,
      pattern: row.pattern,
      patternMessage: row.patternMessage,
      minValue: row.minValue,
      maxValue: row.maxValue,
      minDate: row.minDate,
      maxDate: row.maxDate,
      relativeDateBound: row.relativeDateBound,
      maxFileBytes: row.maxFileBytes,
      placeholder: row.placeholder,
      note: row.note,
      tone: row.tone,
      widthHint: row.widthHint,
      prefixText: row.prefixText,
      suffixText: row.suffixText,
      autocompleteHint: row.autocompleteHint,
      showCharCount: row.showCharCount,
      textareaRows: row.textareaRows,
      choiceStyle: row.choiceStyle,
    })),
    options,
    conditions,
  })
  if (!template) return null

  return { policy: version, template }
}

/**
 * The rules one application is pinned to, found from the application itself.
 *
 * The cycle *version* lives on the snapshot rather than on the application
 * head, so it cannot be read from the head alone — and reading the cycle's
 * current rules instead would be one call cheaper and wrong, because editing a
 * cycle would retroactively change what an in-flight application is judged by.
 * That is the property the freezing exists to provide.
 */
export const findPinnedRulesForApplication = async (
  db: Database,
  applicationId: string,
  version: number,
): Promise<PinnedCycleRules | null> => {
  const [pin] = await db
    .select({
      programmeCycleId: sebApplicationVersion.programmeCycleId,
      programmeCycleVersion: sebApplicationVersion.programmeCycleVersion,
    })
    .from(sebApplicationVersion)
    .where(
      and(
        eq(sebApplicationVersion.applicationId, applicationId),
        eq(sebApplicationVersion.version, version),
      ),
    )
    .limit(1)
  if (!pin) return null
  return findPinnedCycleRules(db, pin.programmeCycleId, pin.programmeCycleVersion)
}

/**
 * Turning answer rows back into the map the engine and the client work in.
 *
 * The rows are the storage shape; nothing outside this module should have to
 * know about `entry_index` or `value_ordinal`. Reading is driven by the
 * template rather than by the rows, so a field with no row reads as unanswered
 * and a field the template declares always appears — which is what makes
 * "absent means unanswered" hold on the read side as well as the write.
 */
export type StoredAnswerRow = {
  /** Which snapshot the row belongs to. Required, and the reason is below. */
  applicationVersionId: string
  fieldKey: string
  entryIndex: number
  valueOrdinal: number
  valueText: string
}

/**
 * The answers of several snapshots, kept apart.
 *
 * **This is the only function that may be handed rows from more than one
 * version.** `findAnswerRows` reads many at once — the workspace shows every
 * submission an application has made — and folding those into one map would
 * merge one applicant's answers into another's: last row wins for a scalar,
 * selections concatenate, and every value is a plausible value, so nothing
 * downstream could notice. Grouping first makes that impossible to express
 * rather than something a caller must remember.
 */
export const answersByVersion = (
  template: ResolvedFormTemplate,
  rows: readonly StoredAnswerRow[],
): Map<string, AnswerMap> => {
  const byVersion = new Map<string, StoredAnswerRow[]>()
  for (const row of rows) {
    byVersion.set(row.applicationVersionId, [
      ...(byVersion.get(row.applicationVersionId) ?? []),
      row,
    ])
  }
  return new Map(
    [...byVersion.entries()].map(([versionId, versionRows]) => [
      versionId,
      answersFromRows(template, versionId, versionRows),
    ]),
  )
}

export const answersFromRows = (
  template: ResolvedFormTemplate,
  applicationVersionId: string,
  rows: readonly StoredAnswerRow[],
): AnswerMap => {
  const scalars = new Map<string, string>()
  const multi = new Map<string, { ordinal: number; value: string }[]>()
  /*
   * Group → entry → member → the selections, each carrying its ordinal.
   *
   * The ordinal is carried for the same reason the top-level branch below
   * sorts on it, and it was not: rows arrive in whatever order the read
   * returned, so a multiple choice inside a repeated group came back in an
   * arbitrary order while the same answer coerced fresh is sorted into the
   * template's option order. The two never compared equal, so **every save
   * reported an edit to a group that nobody had touched** — and under revision
   * that is the difference between a change being in scope and out of it.
   */
  const groups = new Map<string, Map<number, Map<string, { ordinal: number; value: string }[]>>>()
  /*
   * Which entries each group has, from the row written for each entry itself.
   *
   * Kept apart from the members, because how many entries there are is not the
   * same question as what is in them: an entry whose members are all blank has
   * no member rows, and inferring the count from those made it disappear and
   * shifted every entry after it down.
   */
  const entryIndices = new Map<string, Set<number>>()

  for (const row of rows) {
    /*
     * Filtered here as well as grouped by the caller.
     *
     * Taking the id as an argument makes a multi-version array impossible to
     * pass unnoticed — structural typing would otherwise accept
     * `findAnswerRows`' result verbatim — and this check means that even a
     * caller that ignores the signature cannot merge two applicants' answers.
     */
    if (row.applicationVersionId !== applicationVersionId) continue

    const field = template.byKey.get(row.fieldKey)
    if (!field) continue

    if (field.type === 'REPEAT_GROUP') {
      entryIndices.set(field.key, (entryIndices.get(field.key) ?? new Set()).add(row.entryIndex))
      continue
    }

    if (field.repeatGroupKey !== null) {
      const entries = groups.get(field.repeatGroupKey) ?? new Map()
      const entry = entries.get(row.entryIndex) ?? new Map()
      // A list, because a member may itself be a multiple choice — one row per
      // selection. Collapsing to a single value here dropped every selection
      // but the last, and returned a bare string where a list was expected.
      entry.set(row.fieldKey, [
        ...(entry.get(row.fieldKey) ?? []),
        { ordinal: row.valueOrdinal, value: row.valueText },
      ])
      entries.set(row.entryIndex, entry)
      groups.set(field.repeatGroupKey, entries)
      continue
    }
    if (field.type === 'MULTI_CHOICE') {
      multi.set(row.fieldKey, [
        ...(multi.get(row.fieldKey) ?? []),
        { ordinal: row.valueOrdinal, value: row.valueText },
      ])
      continue
    }
    scalars.set(row.fieldKey, row.valueText)
  }

  const answers: Record<string, AnswerValue | readonly AnswerEntry[]> = {}
  for (const field of template.fields) {
    if (field.repeatGroupKey !== null || field.type === 'FILE') continue

    if (field.type === 'REPEAT_GROUP') {
      const members = groups.get(field.key)
      /*
       * The entries this group has, and only then what is in each.
       *
       * `entryIndices` comes from the row written per entry; the fallback is
       * for rows stored before that row existed, where the only evidence an
       * entry was there is a member that was answered.
       */
      const indices = [...(entryIndices.get(field.key) ?? new Set(members?.keys() ?? []))]
        .sort((a, b) => a - b)
      const entries = new Map(indices.map((index) => [index, members?.get(index) ?? new Map()]))
      answers[field.key] = entries.size > 0
        ? [...entries.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, members]) => {
              const entry: Record<string, AnswerValue> = {}
              for (const member of template.fields) {
                if (member.repeatGroupKey !== field.key) continue
                const stored = [...(members.get(member.key) ?? [])]
                  .sort((a, b) => a.ordinal - b.ordinal)
                  .map((selection) => selection.value)
                entry[member.key] =
                  member.type === 'MULTI_CHOICE'
                    ? stored
                    : decodeScalar(member.type, stored[0])
              }
              return entry
            })
        : []
      continue
    }

    if (field.type === 'MULTI_CHOICE') {
      answers[field.key] = (multi.get(field.key) ?? [])
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((selection) => selection.value)
      continue
    }

    answers[field.key] = decodeScalar(field.type, scalars.get(field.key))
  }
  return answers
}

/**
 * Reading one stored value back as its declared type.
 *
 * The column is text because a template can declare any type; the field says
 * how to read it. A number that will not parse is returned as null rather than
 * as `NaN`: `NaN` propagates silently through comparisons and would make a
 * corrupt row look like a small amount.
 *
 * **Every type is named, and the default is a compile error rather than a
 * fallthrough to text.** It was a fallthrough, and `ATTESTATION` — added after
 * this was written — landed in it: the tick came back as the string `"true"`,
 * which is truthy, so nothing threw and no read looked wrong, and the
 * submission check that demands `=== true` refused a declaration the applicant
 * had accepted. A new field type must not be able to do that again silently.
 */
const decodeScalar = (
  type: ResolvedFormTemplate['fields'][number]['type'],
  stored: string | undefined,
): AnswerValue => {
  if (stored === undefined) return null
  switch (type) {
    case 'BOOLEAN':
    case 'ATTESTATION':
      return stored === 'true'
    case 'INTEGER':
    case 'MONEY_PAISE': {
      const parsed = Number(stored)
      return Number.isSafeInteger(parsed) ? parsed : null
    }
    case 'TEXT':
    case 'LONG_TEXT':
    case 'EMAIL':
    case 'PHONE':
    case 'DATE':
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE':
    case 'FILE':
    case 'REPEAT_GROUP':
      return stored
    // Never written: the engine refuses answers addressed to a statement. A
    // row here is corruption, and null is the reading that invents nothing.
    case 'STATEMENT':
      return null
    default: {
      const unreachable: never = type
      return unreachable
    }
  }
}

/** The storage shape of one answer set, ready for a single multi-row insert. */
export type AnswerRow = {
  fieldKey: string
  entryIndex: number
  valueOrdinal: number
  valueText: string
}

/**
 * Flattening an answer map into rows.
 *
 * Sparse by design: a cleared or never-given answer produces no row, so absence
 * is the single representation of "unanswered" in storage as well as in the
 * engine. A row carrying an empty string would be a second one.
 */
export const answersToRows = (
  template: ResolvedFormTemplate,
  answers: AnswerMap,
): AnswerRow[] => {
  const rows: AnswerRow[] = []
  const push = (fieldKey: string, entryIndex: number, ordinal: number, value: AnswerValue) => {
    if (value === null || value === undefined || value === '') return
    rows.push({
      fieldKey,
      entryIndex,
      valueOrdinal: ordinal,
      valueText: String(value),
    })
  }

  for (const field of template.fields) {
    if (field.repeatGroupKey !== null || field.type === 'FILE') continue
    // Never written from an answer map, wherever one came from.
    if (field.source === 'SERVER_DERIVED') continue
    const value = answers[field.key]

    if (field.type === 'REPEAT_GROUP') {
      const entries = (value ?? []) as readonly AnswerEntry[]
      entries.forEach((entry, index) => {
        /*
         * One row for the entry itself, whatever is in it.
         *
         * Storage is otherwise sparse — an unanswered question has no row — and
         * an entry is not a question. Without this, an entry whose members are
         * all blank wrote nothing at all, so the read below could not know it
         * had been there: **the entry count shrank and every entry after it
         * shifted down**, silently reassigning answers between rows. A blank
         * entry in the middle is the case; a trailing one simply vanished,
         * which is the "Add partner" card the applicant just clicked.
         *
         * Empty text rather than a value, because the row means "this entry
         * exists" and nothing more. The composite key holds: a group is a field
         * of the template like any other.
         */
        rows.push({
          fieldKey: field.key,
          entryIndex: index + 1,
          valueOrdinal: 0,
          valueText: '',
        })

        for (const member of template.fields) {
          if (member.repeatGroupKey !== field.key) continue
          if (member.source === 'SERVER_DERIVED' || member.type === 'FILE') continue
          const memberValue = entry[member.key]
          if (member.type === 'MULTI_CHOICE' && Array.isArray(memberValue)) {
            memberValue.forEach((selection, ordinal) =>
              push(member.key, index + 1, ordinal + 1, selection),
            )
            continue
          }
          push(member.key, index + 1, 0, memberValue ?? null)
        }
      })
      continue
    }

    if (field.type === 'MULTI_CHOICE') {
      const selections = (value ?? []) as readonly string[]
      selections.forEach((selection, ordinal) => push(field.key, 0, ordinal + 1, selection))
      continue
    }

    push(field.key, 0, 0, (value ?? null) as AnswerValue)
  }
  return rows
}

/**
 * Every answer stored against a set of application versions.
 *
 * **Deliberately uncapped**, and it belongs to the same family as the
 * disbursement ledger: these rows are folded back into one answer map, so
 * truncating them would not produce a short list, it would produce a form that
 * had quietly forgotten what somebody typed — with nothing downstream able to
 * tell. A cap here is either wrong or unnecessary.
 *
 * It is bounded by policy rather than by hope: the number of rows for one
 * version is the template's field count, plus its choices, plus at most twenty
 * entries per repeated group — all of which a cycle must declare before it can
 * be opened, and none of which a caller controls.
 */
export const findAnswerRows = (db: Database, applicationVersionIds: readonly string[]) =>
  applicationVersionIds.length === 0
    ? Promise.resolve([])
    : db
        .select({
          applicationVersionId: sebApplicationVersionAnswer.applicationVersionId,
          fieldKey: sebApplicationVersionAnswer.fieldKey,
          entryIndex: sebApplicationVersionAnswer.entryIndex,
          valueOrdinal: sebApplicationVersionAnswer.valueOrdinal,
          valueText: sebApplicationVersionAnswer.valueText,
        })
        .from(sebApplicationVersionAnswer)
        .where(inArray(sebApplicationVersionAnswer.applicationVersionId, applicationVersionIds))
