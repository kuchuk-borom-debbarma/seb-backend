/**
 * The questions a programme cycle asks, frozen into one cycle version.
 *
 * The application form is configuration, not code. A cycle declares its stages,
 * the fields in each, the choices they offer and the conditions that decide
 * whether they are asked at all — and an application pins the cycle version it
 * started against, so a submission stays permanently readable against the exact
 * form it was filled on.
 *
 * ## Children name their parent by key, never by row id
 *
 * Every cycle version bump copies these rows forward with `INSERT … SELECT`,
 * minting fresh ids as it goes. A copy that mints ids cannot rewrite id-based
 * child pointers in the same statement, so keying children on
 * `(programme_cycle_id, programme_cycle_version, field_key)` is what makes the
 * copy-forward four plain statements instead of an id-remapping exercise.
 *
 * ## Validation rules are columns; conditions are rows
 *
 * There is at most one length range, one pattern, one numeric range and one
 * date range per field, so a child table would model a cardinality that does
 * not exist. It matters more than tidiness: `max_length >= min_length` and
 * "a pattern only belongs to a text field" are **single-row** CHECKs as columns.
 * Split across rows they become cross-row invariants Postgres cannot express
 * without a trigger, and a template saying `min = 10, max = 3` would be accepted
 * and then refuse every answer at render time with nothing to point at.
 *
 * Conditions genuinely repeat, so they are rows.
 *
 * ## What no CHECK here can enforce
 *
 * Three rules are cross-row and belong to `formTemplateProblem` in
 * `services/admin/form-template-input.ts`, which every authoring write runs
 * so they are refused when a template is authored rather than when a form is
 * rendered:
 *
 * - `requirement = 'CONDITIONAL'` implies at least one `REQUIRED_WHEN` row.
 * - The visibility graph is acyclic. A cycle deadlocks a form permanently.
 * - A condition's source is reachable from the dependent field's own group.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { dateOnly, instant } from '../shared'
import { sebProgrammeCycleVersion } from './programme'

/**
 * The one spelling of a template key.
 *
 * Stage keys, field keys and choice values share a vocabulary because they are
 * the same identifier in several places: these tables, the answer rows, the
 * document slot, and the `id` the client puts on the control so a validation
 * issue can link straight to the answer that is wrong. One spelling means there
 * is no mapping anywhere that can drift.
 *
 * This CHECK is what stops "the enum is gone" becoming "the column is a free
 * string".
 */
export const TEMPLATE_KEY_PATTERN = '^[A-Z][A-Z0-9_]{1,63}$'

export const formFieldTypes = [
  'TEXT',
  'LONG_TEXT',
  'EMAIL',
  'PHONE',
  'DATE',
  'INTEGER',
  'MONEY_PAISE',
  'BOOLEAN',
  /*
   * A statement the applicant confirms, as distinct from a question they
   * answer.
   *
   * `BOOLEAN` has three states an applicant can be in — yes, no, and not yet
   * asked — and "no" is a complete answer to it. An attestation has one
   * acceptable answer, and leaving it unticked is a refusal rather than a gap.
   * Conflating them meant a required yes/no question could not be answered "no"
   * at all, and left the client guessing which control to draw from the
   * requirement flag. The template says which now.
   */
  'ATTESTATION',
  /*
   * A block of prose the applicant reads, as distinct from anything they
   * answer. Disclaimers and legal notices belong to the template like every
   * other part of the form, and without a display-only type they end up
   * hardcoded in the client — the exact thing the template exists to avoid.
   * It takes no answer at all: the engine skips it and refuses answers
   * addressed to it.
   */
  'STATEMENT',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'FILE',
  'REPEAT_GROUP',
] as const
export type FormFieldType = (typeof formFieldTypes)[number]

export const formFieldRequirements = ['REQUIRED', 'OPTIONAL', 'CONDITIONAL'] as const

/**
 * Who may write the answer.
 *
 * The expansion facts are computed by the server from the qualifying award and
 * the ledger, and an applicant must never be able to assert them. They stay
 * typed columns on the version row rather than becoming answers, but a template
 * could still declare a field with a colliding key, so the template has to be
 * able to say what is server-owned and the write path has to refuse the rest.
 */
export const formFieldSources = ['APPLICANT', 'SERVER_DERIVED'] as const

/**
 * The fields that code which is not template-aware still has to find.
 *
 * The administrative queue filters across many cycles at once, so there is no
 * single pinned template to resolve a key from; the amount a decision is
 * bounded by, and the three policy rules that read cycle scalars, have the same
 * problem. A role is
 * how they find their input, and the CHECK below pins each role to a canonical
 * key so the path is a literal in SQL.
 *
 * The cost, stated plainly: **a role-bound field cannot be renamed** where a
 * canonical key pins it. There are two roles now, down from six: the business
 * name, sector, establishment date and category stopped being answers at all —
 * they are read live from the enterprise entity, and the category is computed
 * by the server at submission — so the questions that duplicated them left the
 * template, and their roles left with them.
 */
export const formFieldRoles = [
  /*
   * Deliberately un-pinned: the date of birth lives inside the cycle's owners
   * group under whatever key the cycle gave the member, so the engine resolves
   * it per template. No SQL path reads it, which is what a pin is for.
   */
  'APPLICANT_DATE_OF_BIRTH',
  'SEED_FUND_REQUESTED_PAISE',
] as const
export type FormFieldRole = (typeof formFieldRoles)[number]

/**
 * The canonical key a role must use, for the roles SQL reads literally.
 * Only the requested amount is left: the queue's cross-cycle filter and the
 * decision's bound name it as a string in a query.
 */
export const ROLE_CANONICAL_KEY: Readonly<
  Partial<Record<FormFieldRole, string>> & { SEED_FUND_REQUESTED_PAISE: string }
> = {
  SEED_FUND_REQUESTED_PAISE: 'SEED_FUND_REQUESTED_PAISE',
}

export const formFieldDateBounds = ['NOT_FUTURE', 'NOT_PAST'] as const
/*
 * Presentation vocabulary. Closed sets, because the renderer maps each value
 * to a style it actually has — an unrecognised tone would fall back silently,
 * and a silent fallback is a typo nobody finds. Widths are GOV.UK's set:
 * fluid spans for the two-column grid plus character-sized inputs for
 * answers whose length is known (PIN codes, years).
 */
export const formFieldTones = ['INFO', 'WARNING', 'SUCCESS', 'DANGER'] as const
export type FormFieldTone = (typeof formFieldTones)[number]
export const formFieldWidths = [
  'FULL',
  'TWO_THIRDS',
  'ONE_HALF',
  'ONE_THIRD',
  'CHAR_2',
  'CHAR_4',
  'CHAR_10',
  'CHAR_20',
] as const
export type FormFieldWidth = (typeof formFieldWidths)[number]
/*
 * The HTML autofill tokens a question may claim (WCAG 1.3.5). A subset rather
 * than the whole standard list: only tokens a grant application plausibly
 * asks for, so a typo cannot hide among two hundred valid values.
 */
export const formFieldAutocompleteHints = [
  'name',
  'given-name',
  'family-name',
  'email',
  'tel',
  'postal-code',
  'street-address',
  'address-line1',
  'address-line2',
  'address-level1',
  'address-level2',
  'bday',
  'organization',
  'off',
] as const
export type FormFieldAutocompleteHint = (typeof formFieldAutocompleteHints)[number]
/* Which control draws a choice question. The first four fit SINGLE_CHOICE,
   the last two MULTI_CHOICE; null means the renderer's default. */
export const formFieldChoiceStyles = [
  'RADIO',
  'DROPDOWN',
  'SEGMENTED',
  'CARD',
  'CHECKBOX_LIST',
  'MULTISELECT',
] as const
export type FormFieldChoiceStyle = (typeof formFieldChoiceStyles)[number]
/* Kebab-case token into the client's whitelisted icon registry — a name, never
   markup, so the template cannot inject anything drawable. */
export const ICON_NAME_PATTERN = '^[a-z0-9-]{1,32}$'
export const formConditionEffects = ['VISIBLE_WHEN', 'REQUIRED_WHEN'] as const
export const formConditionOperators = [
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'GREATER_OR_EQUAL',
  'LESS_THAN',
  'LESS_OR_EQUAL',
  'IS_PRESENT',
  'IS_ABSENT',
] as const

/** One step of the form, headed once and unlocked as a unit. */
export const sebProgrammeCycleFormStage = pgTable(
  'seb_programme_cycle_form_stage',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    stageKey: text('stage_key').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /* Stepper affordances: rail icon and a "before you start" time
       expectation. Bounded like everything else an author types. */
    iconName: text('icon_name'),
    estimatedMinutes: integer('estimated_minutes'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_form_stage_version_fk',
    }).onDelete('restrict'),
    // A table constraint rather than a unique index, because fields and
    // revision requests reference this triple. A composite foreign key needs a
    // target that exists by the time the key is declared, and generated DDL
    // creates constraints before indexes.
    unique('seb_programme_cycle_form_stage_key_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.stageKey,
    ),
    uniqueIndex('seb_programme_cycle_form_stage_order_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.sortOrder,
    ),
    check(
      'seb_programme_cycle_form_stage_key_check',
      sql`${table.stageKey} ~ ${sql.raw(`'${TEMPLATE_KEY_PATTERN}'`)}`,
    ),
    check('seb_programme_cycle_form_stage_order_check', sql`${table.sortOrder} >= 1`),
    /* Bounded prose and tokens, because `text(col)` alone accepts a novel. */
    check(
      'seb_programme_cycle_form_stage_description_check',
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 500`,
    ),
    check(
      'seb_programme_cycle_form_stage_icon_check',
      sql`${table.iconName} IS NULL OR ${table.iconName} ~ ${sql.raw(`'${ICON_NAME_PATTERN}'`)}`,
    ),
    check(
      'seb_programme_cycle_form_stage_minutes_check',
      sql`${table.estimatedMinutes} IS NULL
        OR (${table.estimatedMinutes} >= 1 AND ${table.estimatedMinutes} <= 120)`,
    ),
  ],
)

/** One question, and everything needed to draw it and to know when it applies. */
export const sebProgrammeCycleFormField = pgTable(
  'seb_programme_cycle_form_field',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    stageKey: text('stage_key').notNull(),
    fieldKey: text('field_key').notNull(),
    fieldType: text('field_type', { enum: formFieldTypes }).notNull(),
    role: text('role', { enum: formFieldRoles }),

    /* Repeatable groups. A member names its group; a group names nobody. */
    parentFieldKey: text('parent_field_key'),
    /* Denormalized so "a parent is a REPEAT_GROUP" is a foreign key, not a hope.
       It cannot drift: the key below targets (cycle, version, key, type). */
    parentFieldType: text('parent_field_type'),
    /*
     * The reusable structure this group was expanded from, where it was.
     * Provenance, not behaviour: the members were materialised into ordinary
     * rows at authoring time, and the engine never reads this. What it buys is
     * the round trip — the authoring read strips the derived members and shows
     * the definition instead, so an officer edits the structure, never its
     * expansion. Declared here so the positional copy-forward's column order
     * matches: parent pair first, then provenance.
     */
    groupDefinitionKey: text('group_definition_key'),

    sortOrder: integer('sort_order').notNull(),
    label: text('label').notNull(),
    helpText: text('help_text'),

    /*
     * How the question is drawn, as distinct from what an answer must satisfy.
     *
     * `help_text` is spoken for — the client renders it as the "Why X is
     * asked" popover beside the label. `note` is the inline hint under the
     * control; `placeholder` is ghost text inside it; the rest are closed
     * style tokens. Columns rather than a JSON blob for the same reason the
     * validation rules are: a closed set can carry a CHECK, and a CHECK turns
     * a typo into a refusal instead of a silently ignored style.
     */
    placeholder: text('placeholder'),
    note: text('note'),
    tone: text('tone', { enum: formFieldTones }),
    widthHint: text('width_hint', { enum: formFieldWidths }),
    prefixText: text('prefix_text'),
    suffixText: text('suffix_text'),
    autocompleteHint: text('autocomplete_hint', { enum: formFieldAutocompleteHints }),
    showCharCount: boolean('show_char_count').notNull().default(false),
    textareaRows: integer('textarea_rows'),
    choiceStyle: text('choice_style', { enum: formFieldChoiceStyles }),

    requirement: text('requirement', { enum: formFieldRequirements }).notNull(),
    source: text('source', { enum: formFieldSources }).notNull().default('APPLICANT'),

    repeatMin: integer('repeat_min'),
    repeatMax: integer('repeat_max'),
    minLength: integer('min_length'),
    maxLength: integer('max_length'),
    pattern: text('pattern'),
    patternMessage: text('pattern_message'),
    minValue: bigint('min_value', { mode: 'number' }),
    maxValue: bigint('max_value', { mode: 'number' }),
    minDate: dateOnly('min_date'),
    maxDate: dateOnly('max_date'),
    relativeDateBound: text('relative_date_bound', { enum: formFieldDateBounds }),
    maxFileBytes: integer('max_file_bytes'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_form_field_version_fk',
    }).onDelete('restrict'),
    /* A field cannot be orphaned into a stage that does not exist. */
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion, table.stageKey],
      foreignColumns: [
        sebProgrammeCycleFormStage.programmeCycleId,
        sebProgrammeCycleFormStage.programmeCycleVersion,
        sebProgrammeCycleFormStage.stageKey,
      ],
      name: 'seb_programme_cycle_form_field_stage_fk',
    }).onDelete('restrict'),

    unique('seb_programme_cycle_form_field_key_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.fieldKey,
    ),
    /* Backs the parent and child keys: both target all four columns. */
    unique('seb_programme_cycle_form_field_typed_key_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.fieldKey,
      table.fieldType,
    ),
    /*
     * `coalesce` rather than the bare column, because a top-level field has a
     * NULL parent and NULLs are distinct in a unique index — so without it two
     * top-level fields in one stage could both claim position 1 and the form
     * would render in an order nobody chose.
     *
     * `NULLS NOT DISTINCT` would say this more directly but needs PG15 and a
     * Drizzle that emits it; an empty string cannot collide with a real key,
     * which must match `^[A-Z]...`, so this holds on any version.
     */
    uniqueIndex('seb_programme_cycle_form_field_order_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.stageKey,
      sql`coalesce(${table.parentFieldKey}, '')`,
      table.sortOrder,
    ),
    /* One field per role per cycle version. Partial, so the many unbound
       fields do not collide with each other on NULL. */
    uniqueIndex('seb_programme_cycle_form_field_role_uq')
      .on(table.programmeCycleId, table.programmeCycleVersion, table.role)
      .where(sql`${table.role} IS NOT NULL`),

    check(
      'seb_programme_cycle_form_field_key_check',
      sql`${table.fieldKey} ~ ${sql.raw(`'${TEMPLATE_KEY_PATTERN}'`)}`,
    ),
    check(
      'seb_programme_cycle_form_field_type_check',
      sql`${table.fieldType} IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER', 'MONEY_PAISE', 'BOOLEAN', 'ATTESTATION', 'STATEMENT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'FILE', 'REPEAT_GROUP')`,
    ),
    check(
      'seb_programme_cycle_form_field_requirement_check',
      sql`${table.requirement} IN ('REQUIRED', 'OPTIONAL', 'CONDITIONAL')`,
    ),
    /*
     * A server-derived field, and a role-bound one, must stand alone.
     *
     * Both are read by code that only ever looks at the top level: the engine
     * strips server-derived answers there, and the requested-amount role is
     * resolved to `answers[key]`. Inside a repeated group neither is
     * reachable, so a template that put one there would silently turn a
     * programme-derived fact into an applicant claim, or a policy rule into a
     * no-op. Refused here so it cannot be authored rather than guarded at each
     * of the places that would have to remember. The one carve-out is the date
     * of birth: the age rule reads it *per entry* of the owners group, which
     * is the only role the engine walks entries for.
     */
    check(
      'seb_programme_cycle_form_field_source_check',
      sql`${table.source} IN ('APPLICANT', 'SERVER_DERIVED')
        AND (${table.source} = 'APPLICANT' OR ${table.parentFieldKey} IS NULL)
        AND (${table.role} IS NULL OR ${table.parentFieldKey} IS NULL
          OR ${table.role} = 'APPLICANT_DATE_OF_BIRTH')`,
    ),
    check('seb_programme_cycle_form_field_order_check', sql`${table.sortOrder} >= 1`),
    /*
     * A role pins both the key and the type, so the queue's `field_key = 'X'`
     * is a literal across every cycle and the decision's bound is always an
     * amount.
     */
    check(
      'seb_programme_cycle_form_field_role_check',
      sql`${table.role} IS NULL
        OR (${table.role} = 'APPLICANT_DATE_OF_BIRTH' AND ${table.fieldType} = 'DATE')
        OR (${table.role} = 'SEED_FUND_REQUESTED_PAISE' AND ${table.fieldKey} = 'SEED_FUND_REQUESTED_PAISE' AND ${table.fieldType} = 'MONEY_PAISE')`,
    ),
    /*
     * A parent reference is a complete pair or absent, and the pair only ever
     * names a group. Without the second half `parent_field_type` could be set
     * to anything and the key would point at an arbitrary field.
     */
    check(
      'seb_programme_cycle_form_field_parent_check',
      sql`(${table.parentFieldKey} IS NULL AND ${table.parentFieldType} IS NULL)
        OR (${table.parentFieldKey} IS NOT NULL AND ${table.parentFieldType} = 'REPEAT_GROUP')`,
    ),
    check(
      'seb_programme_cycle_form_field_definition_use_check',
      sql`${table.groupDefinitionKey} IS NULL OR ${table.fieldType} = 'REPEAT_GROUP'`,
    ),
    /* Groups do not nest. One level is what the form needs and what a renderer
       can be proven correct against; nesting makes the issue path, the diff and
       the payload size all unbounded. */
    check(
      'seb_programme_cycle_form_field_nesting_check',
      sql`${table.fieldType} <> 'REPEAT_GROUP' OR ${table.parentFieldKey} IS NULL`,
    ),
    /*
     * The `IS NOT NULL` pair is load-bearing, and its absence was demonstrated
     * rather than suspected — the same three-valued-logic hole the money floor
     * already carries a scar for. With `repeat_min` null the second disjunct
     * evaluates to NULL, the first is false, `false OR NULL` is NULL, and **a
     * CHECK passes when its result is NULL**. So a repeated group with no
     * bounds was accepted, and `greatest(NULL, 1)` returning 1 hid it further
     * by keeping the neighbouring comparison true.
     */
    check(
      'seb_programme_cycle_form_field_repeat_check',
      sql`(${table.fieldType} <> 'REPEAT_GROUP'
          AND ${table.repeatMin} IS NULL AND ${table.repeatMax} IS NULL)
        OR (${table.fieldType} = 'REPEAT_GROUP'
          AND ${table.repeatMin} IS NOT NULL AND ${table.repeatMax} IS NOT NULL
          AND ${table.repeatMin} >= 0
          AND ${table.repeatMax} >= greatest(${table.repeatMin}, 1)
          AND ${table.repeatMax} <= 20)`,
    ),
    /*
     * The length pair counts characters on a text question and *selections* on
     * a multiple choice — "choose no more than three sectors" is the same
     * bound expressed against a list.
     *
     * `MULTI_CHOICE` was excluded, which made `TOO_FEW_SELECTED` and
     * `TOO_MANY_SELECTED` unreachable: the engine has implemented both since
     * the closed code set was written, and no cycle could declare a field they
     * could fire on. Widening this is what connects the two.
     */
    check(
      'seb_programme_cycle_form_field_length_check',
      sql`(${table.fieldType} NOT IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'MULTI_CHOICE')
          AND ${table.minLength} IS NULL AND ${table.maxLength} IS NULL)
        OR (${table.fieldType} IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'MULTI_CHOICE')
          AND (${table.minLength} IS NULL OR ${table.minLength} >= 0)
          AND (${table.maxLength} IS NULL OR ${table.maxLength} >= 1)
          AND (${table.minLength} IS NULL OR ${table.maxLength} IS NULL
               OR ${table.maxLength} >= ${table.minLength}))`,
    ),
    /*
     * A pattern stays text-only, and still demands a length cap: it is
     * authored by a programme officer and runs on a Worker CPU budget, so the
     * string it runs against has to be bounded first. There is nothing for a
     * regular expression to match on a list of choices the cycle itself
     * enumerated.
     */
    check(
      'seb_programme_cycle_form_field_pattern_check',
      sql`(${table.fieldType} NOT IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE')
          AND ${table.pattern} IS NULL AND ${table.patternMessage} IS NULL)
        OR (${table.fieldType} IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE')
          AND (${table.pattern} IS NOT NULL OR ${table.patternMessage} IS NULL)
          AND (${table.pattern} IS NULL OR ${table.maxLength} IS NOT NULL))`,
    ),
    /*
     * Every money field carries a floor, and a patterned field carries a length
     * cap. Both are recoveries of guarantees the old typed columns gave for
     * free: there is no longer a per-column CHECK refusing a negative award,
     * and a regular expression supplied by a template author runs on a Worker
     * CPU budget, so the input it runs against has to be bounded first.
     */
    /*
     * Note the explicit `IS NOT NULL` on the money floor.
     *
     * A CHECK passes when its result is NULL, not only when it is true. Without
     * that clause a money field with no floor makes every branch of this
     * disjunction false-or-NULL, the whole expression evaluates to NULL, and
     * the row is accepted — which is the same three-valued-logic trap the
     * award closure check in `funding.ts` records. It was demonstrated here
     * before it was fixed.
     */
    check(
      'seb_programme_cycle_form_field_numeric_check',
      sql`(${table.fieldType} NOT IN ('INTEGER', 'MONEY_PAISE')
          AND ${table.minValue} IS NULL AND ${table.maxValue} IS NULL)
        OR (${table.fieldType} = 'INTEGER'
          AND (${table.minValue} IS NULL OR ${table.maxValue} IS NULL
               OR ${table.maxValue} >= ${table.minValue}))
        OR (${table.fieldType} = 'MONEY_PAISE'
          AND ${table.minValue} IS NOT NULL AND ${table.minValue} >= 0
          AND (${table.maxValue} IS NULL
               OR (${table.maxValue} >= ${table.minValue}
                   AND ${table.maxValue} <= 9007199254740991)))`,
    ),
    check(
      'seb_programme_cycle_form_field_date_check',
      sql`(${table.fieldType} <> 'DATE'
          AND ${table.minDate} IS NULL AND ${table.maxDate} IS NULL
          AND ${table.relativeDateBound} IS NULL)
        OR (${table.fieldType} = 'DATE'
          AND (${table.minDate} IS NULL OR ${table.maxDate} IS NULL
               OR ${table.maxDate} >= ${table.minDate}))`,
    ),
    /*
     * The bound's own values. `text(..., { enum })` is a TypeScript union and
     * nothing more — it emits no constraint — so every other closed set on this
     * table states its members here, and this one did not. An unrecognised
     * bound is not refused by the engine either: it reads as "no relative
     * bound", so a date question authored with a typo silently stops enforcing
     * the rule it was written to enforce.
     */
    check(
      'seb_programme_cycle_form_field_relative_date_check',
      sql`${table.relativeDateBound} IS NULL
        OR ${table.relativeDateBound} IN ('NOT_FUTURE', 'NOT_PAST')`,
    ),
    /*
     * A document slot may say nothing about size, and then the programme's own
     * limit applies — `MAX_DOCUMENT_BYTES`, which every upload is measured
     * against regardless. A cycle can only make its slot *smaller*.
     *
     * The null case is spelled out rather than left to fall through. It used to
     * be reached by accident: with `max_file_bytes` null the second disjunct
     * evaluated to NULL, the first was false, and a CHECK passes on NULL — so
     * the constraint permitted the right thing for no reason, and would have
     * permitted a zero or a value past the ceiling the same way if the column
     * had been null there too.
     */
    check(
      'seb_programme_cycle_form_field_file_check',
      sql`(${table.fieldType} <> 'FILE' AND ${table.maxFileBytes} IS NULL)
        OR (${table.fieldType} = 'FILE'
          AND (${table.maxFileBytes} IS NULL
               OR (${table.maxFileBytes} > 0 AND ${table.maxFileBytes} <= 5242880)))`,
    ),
    /*
     * The presentation vocabulary, written out because `text(col, { enum })`
     * emits no constraint at all — the rule every closed set on this table
     * keeps. Ghost text and autofill only where a typing control exists;
     * a counter only where there is a limit for it to count against.
     */
    check(
      'seb_programme_cycle_form_field_placeholder_check',
      sql`${table.placeholder} IS NULL
        OR (char_length(${table.placeholder}) <= 200
          AND ${table.fieldType} IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER', 'MONEY_PAISE'))`,
    ),
    check(
      'seb_programme_cycle_form_field_note_check',
      sql`${table.note} IS NULL OR char_length(${table.note}) <= 500`,
    ),
    check(
      'seb_programme_cycle_form_field_tone_check',
      sql`${table.tone} IS NULL
        OR ${table.tone} IN ('INFO', 'WARNING', 'SUCCESS', 'DANGER')`,
    ),
    check(
      'seb_programme_cycle_form_field_width_check',
      sql`${table.widthHint} IS NULL
        OR ${table.widthHint} IN ('FULL', 'TWO_THIRDS', 'ONE_HALF', 'ONE_THIRD', 'CHAR_2', 'CHAR_4', 'CHAR_10', 'CHAR_20')`,
    ),
    /* An affix is decoration beside a value-bearing control: '₹' before an
       amount, 'yrs' after a count. Eight characters is room for a unit, not
       for prose. */
    check(
      'seb_programme_cycle_form_field_affix_check',
      sql`(${table.prefixText} IS NULL
          OR (char_length(${table.prefixText}) BETWEEN 1 AND 8
            AND ${table.fieldType} IN ('TEXT', 'INTEGER', 'MONEY_PAISE')))
        AND (${table.suffixText} IS NULL
          OR (char_length(${table.suffixText}) BETWEEN 1 AND 8
            AND ${table.fieldType} IN ('TEXT', 'INTEGER', 'MONEY_PAISE')))`,
    ),
    check(
      'seb_programme_cycle_form_field_autocomplete_check',
      sql`${table.autocompleteHint} IS NULL
        OR (${table.autocompleteHint} IN ('name', 'given-name', 'family-name', 'email', 'tel', 'postal-code', 'street-address', 'address-line1', 'address-line2', 'address-level1', 'address-level2', 'bday', 'organization', 'off')
          AND ${table.fieldType} IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER'))`,
    ),
    check(
      'seb_programme_cycle_form_field_char_count_check',
      sql`NOT ${table.showCharCount}
        OR (${table.fieldType} IN ('TEXT', 'LONG_TEXT') AND ${table.maxLength} IS NOT NULL)`,
    ),
    check(
      'seb_programme_cycle_form_field_rows_check',
      sql`${table.textareaRows} IS NULL
        OR (${table.fieldType} = 'LONG_TEXT'
          AND ${table.textareaRows} >= 2 AND ${table.textareaRows} <= 20)`,
    ),
    check(
      'seb_programme_cycle_form_field_choice_style_check',
      sql`${table.choiceStyle} IS NULL
        OR (${table.fieldType} = 'SINGLE_CHOICE'
          AND ${table.choiceStyle} IN ('RADIO', 'DROPDOWN', 'SEGMENTED', 'CARD'))
        OR (${table.fieldType} = 'MULTI_CHOICE'
          AND ${table.choiceStyle} IN ('CHECKBOX_LIST', 'MULTISELECT'))`,
    ),
    /*
     * A statement is read, never answered: it cannot be required (there is
     * nothing to give), cannot carry a role (a role resolves to an answer),
     * and cannot sit inside a repeated group (the same prose n times over is
     * noise, not data). Its validation columns are already forced null by the
     * typed CHECKs above, which all place STATEMENT in their "must be null"
     * branch.
     */
    check(
      'seb_programme_cycle_form_field_statement_check',
      sql`${table.fieldType} <> 'STATEMENT'
        OR (${table.requirement} = 'OPTIONAL'
          AND ${table.role} IS NULL
          AND ${table.parentFieldKey} IS NULL)`,
    ),
    index('seb_programme_cycle_form_field_stage_idx').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.stageKey,
      table.sortOrder,
    ),
  ],
)

/**
 * One value a field will accept.
 *
 * For a choice field that is a template key; for a FILE field it is an accepted
 * content type. Same meaning, same table — and pairing each row with the
 * parent's `field_type` is what makes "options belong only to fields that have
 * a value set" a database rule rather than a service convention.
 */
export const sebProgrammeCycleFormFieldOption = pgTable(
  'seb_programme_cycle_form_field_option',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    fieldKey: text('field_key').notNull(),
    fieldType: text('field_type', { enum: formFieldTypes }).notNull(),
    optionValue: text('option_value').notNull(),
    optionLabel: text('option_label').notNull(),
    /* For the choice-card rendering: a sentence under the title and an icon
       badge beside it. Meaningless on a FILE row, refused there. */
    optionDescription: text('option_description'),
    iconName: text('icon_name'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_form_field_option_version_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.programmeCycleId,
        table.programmeCycleVersion,
        table.fieldKey,
        table.fieldType,
      ],
      foreignColumns: [
        sebProgrammeCycleFormField.programmeCycleId,
        sebProgrammeCycleFormField.programmeCycleVersion,
        sebProgrammeCycleFormField.fieldKey,
        sebProgrammeCycleFormField.fieldType,
      ],
      name: 'seb_programme_cycle_form_field_option_field_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_form_field_option_value_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.fieldKey,
      table.optionValue,
    ),
    uniqueIndex('seb_programme_cycle_form_field_option_order_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.fieldKey,
      table.sortOrder,
    ),
    check(
      'seb_programme_cycle_form_field_option_order_check',
      sql`${table.sortOrder} >= 1`,
    ),
    check(
      'seb_programme_cycle_form_field_option_presentation_check',
      sql`(${table.optionDescription} IS NULL
          OR (char_length(${table.optionDescription}) <= 200
            AND ${table.fieldType} IN ('SINGLE_CHOICE', 'MULTI_CHOICE')))
        AND (${table.iconName} IS NULL
          OR (${table.iconName} ~ ${sql.raw(`'${ICON_NAME_PATTERN}'`)}
            AND ${table.fieldType} IN ('SINGLE_CHOICE', 'MULTI_CHOICE')))`,
    ),
    check(
      'seb_programme_cycle_form_field_option_value_check',
      sql`(${table.fieldType} IN ('SINGLE_CHOICE', 'MULTI_CHOICE')
          AND ${table.optionValue} ~ ${sql.raw(`'${TEMPLATE_KEY_PATTERN}'`)})
        OR (${table.fieldType} = 'FILE'
          AND ${table.optionValue} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$')`,
    ),
  ],
)

/**
 * One comparison deciding whether a field is asked, or whether it is required.
 *
 * Rows sharing a `group_number` are ANDed; separate groups are ORed. Two
 * integers rather than an expression string, because an expression string is
 * the opaque blob these tables exist to avoid, and because an unstated
 * combinator is exactly the thing the server and the client would each guess
 * differently.
 *
 * There is deliberately no `IN` operator: it needs a list, a list in one column
 * is a miniature JSON document, and two rows in different groups say the same
 * thing in the vocabulary already here.
 */
export const sebProgrammeCycleFormFieldCondition = pgTable(
  'seb_programme_cycle_form_field_condition',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    /** The field this rule governs. */
    fieldKey: text('field_key').notNull(),
    effect: text('effect', { enum: formConditionEffects }).notNull(),
    groupNumber: integer('group_number').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    sourceFieldKey: text('source_field_key').notNull(),
    sourceFieldType: text('source_field_type', { enum: formFieldTypes }).notNull(),
    operator: text('operator', { enum: formConditionOperators }).notNull(),
    comparisonValue: text('comparison_value'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_form_field_condition_version_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion, table.fieldKey],
      foreignColumns: [
        sebProgrammeCycleFormField.programmeCycleId,
        sebProgrammeCycleFormField.programmeCycleVersion,
        sebProgrammeCycleFormField.fieldKey,
      ],
      name: 'seb_programme_cycle_form_field_condition_field_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.programmeCycleId,
        table.programmeCycleVersion,
        table.sourceFieldKey,
        table.sourceFieldType,
      ],
      foreignColumns: [
        sebProgrammeCycleFormField.programmeCycleId,
        sebProgrammeCycleFormField.programmeCycleVersion,
        sebProgrammeCycleFormField.fieldKey,
        sebProgrammeCycleFormField.fieldType,
      ],
      name: 'seb_programme_cycle_form_field_condition_source_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_form_field_condition_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.fieldKey,
      table.effect,
      table.groupNumber,
      table.sequenceNumber,
    ),
    check(
      'seb_programme_cycle_form_field_condition_effect_check',
      sql`${table.effect} IN ('VISIBLE_WHEN', 'REQUIRED_WHEN')`,
    ),
    check(
      'seb_programme_cycle_form_field_condition_operator_check',
      sql`${table.operator} IN ('EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'GREATER_OR_EQUAL', 'LESS_THAN', 'LESS_OR_EQUAL', 'IS_PRESENT', 'IS_ABSENT')`,
    ),
    check(
      'seb_programme_cycle_form_field_condition_group_check',
      sql`${table.groupNumber} >= 1 AND ${table.sequenceNumber} >= 1`,
    ),
    /* A field that depends on itself is never satisfiable and never renders. */
    check(
      'seb_programme_cycle_form_field_condition_self_check',
      sql`${table.sourceFieldKey} <> ${table.fieldKey}`,
    ),
    /* A presence test has nothing to compare against; every other operator must. */
    check(
      'seb_programme_cycle_form_field_condition_value_check',
      sql`(${table.operator} IN ('IS_PRESENT', 'IS_ABSENT') AND ${table.comparisonValue} IS NULL)
        OR (${table.operator} NOT IN ('IS_PRESENT', 'IS_ABSENT') AND ${table.comparisonValue} IS NOT NULL)`,
    ),
    /*
     * What may be asked of what. A group has no value of its own, a file has
     * only presence, and ordering a text answer is a comparison nobody meant
     * to write.
     */
    check(
      'seb_programme_cycle_form_field_condition_source_check',
      sql`${table.sourceFieldType} <> 'REPEAT_GROUP'
        AND (${table.sourceFieldType} <> 'FILE' OR ${table.operator} IN ('IS_PRESENT', 'IS_ABSENT'))
        AND (${table.operator} NOT IN ('GREATER_THAN', 'GREATER_OR_EQUAL', 'LESS_THAN', 'LESS_OR_EQUAL')
             OR ${table.sourceFieldType} IN ('INTEGER', 'MONEY_PAISE', 'DATE'))`,
    ),
    index('seb_programme_cycle_form_field_condition_field_idx').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.fieldKey,
    ),
  ],
)

/**
 * A reusable structure a cycle defines once and uses as a repeated group.
 *
 * The definition is the authoritative, editable thing; a use is an ordinary
 * `REPEAT_GROUP` field carrying `group_definition_key`, and its members are
 * **materialised** into ordinary field rows at authoring time under qualified
 * keys (`USE__MEMBER`). The engine, storage and the applicant's renderer never
 * read these tables — which is what keeps the whole downstream proof surface
 * (issue paths, answers-as-rows, parity tests) untouched by the feature.
 *
 * Versioned and copied forward with every other rule table: a definition that
 * silently emptied on a version bump would strand every use's provenance.
 */
export const sebProgrammeCycleFormGroupDefinition = pgTable(
  'seb_programme_cycle_form_group_definition',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    definitionKey: text('definition_key').notNull(),
    label: text('label').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_form_group_definition_version_fk',
    }).onDelete('restrict'),
    unique('seb_programme_cycle_form_group_definition_key_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.definitionKey,
    ),
    check(
      'seb_programme_cycle_form_group_definition_key_check',
      sql`${table.definitionKey} ~ ${sql.raw(`'${TEMPLATE_KEY_PATTERN}'`)}`,
    ),
  ],
)

/**
 * One member of a reusable structure: a question shape without a stage.
 *
 * Carries the same rule and presentation columns as a field, because it
 * becomes one on expansion. No conditions in this version — a definition is a
 * set of questions, not a flow — and the authoring check says so in words.
 */
export const sebProgrammeCycleFormGroupDefinitionMember = pgTable(
  'seb_programme_cycle_form_group_definition_member',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    definitionKey: text('definition_key').notNull(),
    memberKey: text('member_key').notNull(),
    fieldType: text('field_type', { enum: formFieldTypes }).notNull(),
    role: text('role', { enum: formFieldRoles }),
    sortOrder: integer('sort_order').notNull(),
    label: text('label').notNull(),
    helpText: text('help_text'),
    placeholder: text('placeholder'),
    note: text('note'),
    tone: text('tone', { enum: formFieldTones }),
    widthHint: text('width_hint', { enum: formFieldWidths }),
    prefixText: text('prefix_text'),
    suffixText: text('suffix_text'),
    autocompleteHint: text('autocomplete_hint', { enum: formFieldAutocompleteHints }),
    showCharCount: boolean('show_char_count').notNull().default(false),
    textareaRows: integer('textarea_rows'),
    choiceStyle: text('choice_style', { enum: formFieldChoiceStyles }),
    requirement: text('requirement', { enum: formFieldRequirements }).notNull(),
    minLength: integer('min_length'),
    maxLength: integer('max_length'),
    pattern: text('pattern'),
    patternMessage: text('pattern_message'),
    minValue: bigint('min_value', { mode: 'number' }),
    maxValue: bigint('max_value', { mode: 'number' }),
    minDate: dateOnly('min_date'),
    maxDate: dateOnly('max_date'),
    relativeDateBound: text('relative_date_bound', { enum: formFieldDateBounds }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion, table.definitionKey],
      foreignColumns: [
        sebProgrammeCycleFormGroupDefinition.programmeCycleId,
        sebProgrammeCycleFormGroupDefinition.programmeCycleVersion,
        sebProgrammeCycleFormGroupDefinition.definitionKey,
      ],
      name: 'seb_programme_cycle_form_group_definition_member_definition_fk',
    }).onDelete('restrict'),
    unique('seb_programme_cycle_form_group_definition_member_key_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.definitionKey,
      table.memberKey,
    ),
    uniqueIndex('seb_programme_cycle_form_group_definition_member_order_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.definitionKey,
      table.sortOrder,
    ),
    check(
      'seb_programme_cycle_form_group_definition_member_key_check',
      sql`${table.memberKey} ~ ${sql.raw(`'${TEMPLATE_KEY_PATTERN}'`)}`,
    ),
    check(
      'seb_programme_cycle_form_group_definition_member_order_check',
      sql`${table.sortOrder} >= 1`,
    ),
    /*
     * What a member may be. A group inside a group is the nesting the whole
     * model refuses; a document has its own versioned row and cannot repeat
     * per entry; a statement repeated per entry is the same prose n times.
     */
    check(
      'seb_programme_cycle_form_group_definition_member_type_check',
      sql`${table.fieldType} NOT IN ('REPEAT_GROUP', 'FILE', 'STATEMENT')
        AND ${table.fieldType} IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER', 'MONEY_PAISE', 'BOOLEAN', 'ATTESTATION', 'SINGLE_CHOICE', 'MULTI_CHOICE')`,
    ),
    /* The one role that may live inside a group, on the one type it fits. */
    check(
      'seb_programme_cycle_form_group_definition_member_role_check',
      sql`${table.role} IS NULL
        OR (${table.role} = 'APPLICANT_DATE_OF_BIRTH' AND ${table.fieldType} = 'DATE')`,
    ),
    check(
      'seb_programme_cycle_form_group_definition_member_requirement_check',
      sql`${table.requirement} IN ('REQUIRED', 'OPTIONAL', 'CONDITIONAL')`,
    ),
  ],
)

/**
 * The choices a structure's member offers, mirrored from the field options.
 * Materialised into ordinary option rows on expansion, like the member itself.
 */
export const sebProgrammeCycleFormGroupDefinitionMemberOption = pgTable(
  'seb_programme_cycle_form_group_definition_member_option',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    definitionKey: text('definition_key').notNull(),
    memberKey: text('member_key').notNull(),
    optionValue: text('option_value').notNull(),
    optionLabel: text('option_label').notNull(),
    optionDescription: text('option_description'),
    iconName: text('icon_name'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.programmeCycleId,
        table.programmeCycleVersion,
        table.definitionKey,
        table.memberKey,
      ],
      foreignColumns: [
        sebProgrammeCycleFormGroupDefinitionMember.programmeCycleId,
        sebProgrammeCycleFormGroupDefinitionMember.programmeCycleVersion,
        sebProgrammeCycleFormGroupDefinitionMember.definitionKey,
        sebProgrammeCycleFormGroupDefinitionMember.memberKey,
      ],
      name: 'seb_programme_cycle_form_group_definition_member_option_member_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_form_group_definition_member_option_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.definitionKey,
      table.memberKey,
      table.optionValue,
    ),
    check(
      'seb_programme_cycle_form_group_definition_member_option_order_check',
      sql`${table.sortOrder} >= 1`,
    ),
    check(
      'seb_programme_cycle_form_group_definition_member_option_value_check',
      sql`${table.optionValue} ~ ${sql.raw(`'${TEMPLATE_KEY_PATTERN}'`)}`,
    ),
  ],
)
