/**
 * The per-type question form, shared between the stage editor (questions) and
 * the structures panel (members).
 *
 * It shows only the attributes the chosen type can carry, mirroring the
 * server's own refusal matrix (`formAuthoring.ts` holds the sets) — so an
 * officer is never offered a placeholder on a yes/no question only to have the
 * save refused. A member is the same form minus what a member cannot have: a
 * stage, a parent, conditions, a document size, and the group settings.
 */
import type {
  FieldConditionEffect,
  FieldConditionOperator,
  FormFieldRequirement,
  FormFieldType,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import {
  AFFIX_TYPES,
  AUTOCOMPLETE_HINTS,
  AUTOCOMPLETE_TYPES,
  CHAR_COUNT_TYPES,
  CHOICE_TYPES,
  CONDITION_EFFECTS,
  CONDITION_OPERATORS,
  DATE_TYPES,
  FIELD_TYPES,
  LENGTH_TYPES,
  MEMBER_TYPES,
  MULTI_CHOICE_STYLES,
  NUMBER_TYPES,
  PLACEHOLDER_TYPES,
  SINGLE_CHOICE_STYLES,
  TONES,
  VALUELESS_OPERATORS,
  WIDTH_HINTS,
  type AttributeDraft,
  type ConditionDraft,
  type DefinitionView,
  type OptionDraft,
  type TemplateView,
} from './formAuthoring'
import styles from './FormEditor.module.css'

export function FieldEditor({
  idPrefix,
  draft,
  onChange,
  variant,
  keyLocked,
  template,
  definitions,
  parentFieldKey = null,
}: {
  /** Prefix for control ids, so two open editors never share a label target. */
  idPrefix: string
  draft: AttributeDraft
  onChange: (draft: AttributeDraft) => void
  variant: 'question' | 'member'
  /** A key names the question everywhere, so it is fixed once it exists. */
  keyLocked: boolean
  /** The expanded template, for condition sources. Questions only. */
  template?: TemplateView
  /** The structures a repeated group may expand from. Questions only. */
  definitions?: readonly DefinitionView[]
  /** The group this question sits in, which scopes what its rules may read. */
  parentFieldKey?: string | null
}) {
  const set = <TKey extends keyof AttributeDraft>(
    key: TKey,
    value: AttributeDraft[TKey],
  ) => onChange({ ...draft, [key]: value })

  const type = draft.fieldType
  const types = variant === 'member' ? MEMBER_TYPES : FIELD_TYPES
  const isChoice = CHOICE_TYPES.has(type)
  // The one role each type may carry; every other type plays none.
  const roleOffered =
    type === 'MONEY_PAISE' && variant === 'question'
      ? 'SEED_FUND_REQUESTED_PAISE'
      : type === 'DATE'
        ? 'APPLICANT_DATE_OF_BIRTH'
        : null

  /*
   * What a rule on this question may read: its own group's members when it is
   * inside one, otherwise only top-level questions — a top-level rule reading
   * a group member would read a key that never has a value there, which the
   * server refuses in as many words.
   */
  const sources = (template?.fields ?? []).filter(
    (field) =>
      field.key !== draft.key &&
      field.type !== 'STATEMENT' &&
      field.type !== 'REPEAT_GROUP' &&
      (field.repeatGroupKey ?? null) === parentFieldKey,
  )

  return (
    <div className="stack" style={{ gap: '0.75rem' }}>
      <div className={styles.grid}>
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-key`}>
            {variant === 'member' ? 'Member key' : 'Question key'}
          </label>
          <input
            id={`${idPrefix}-key`}
            className="input tabular"
            value={draft.key}
            disabled={keyLocked}
            // Coerced to the key grammar as it is typed, as the cycle code is.
            onChange={(event) =>
              set('key', event.target.value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_'))
            }
          />
          {keyLocked ? null : (
            <span className="field-hint">
              Capitals and underscores. Fixed once saved.
            </span>
          )}
        </div>
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-type`}>
            Type of answer
          </label>
          <select
            id={`${idPrefix}-type`}
            className="select"
            value={type}
            onChange={(event) => {
              const next = event.target.value as FormFieldType
              onChange({
                ...draft,
                fieldType: next,
                // The style vocabularies do not overlap, so a kept one is a
                // guaranteed refusal.
                choiceStyle: '',
                requirement: next === 'STATEMENT' ? 'OPTIONAL' : draft.requirement,
              })
            }}
          >
            {types.map((each) => (
              <option key={each} value={each}>
                {humanize(each)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-requirement`}>
            Needed?
          </label>
          <select
            id={`${idPrefix}-requirement`}
            className="select"
            value={draft.requirement}
            // A statement is read, not answered: nothing can be required of it.
            disabled={type === 'STATEMENT'}
            onChange={(event) =>
              set('requirement', event.target.value as FormFieldRequirement)
            }
          >
            <option value="REQUIRED">Required</option>
            <option value="OPTIONAL">Optional</option>
            {/* A member carries no rules, so nothing could ever make it
                required "when". */}
            {variant === 'question' ? (
              <option value="CONDITIONAL">Required on a condition</option>
            ) : null}
          </select>
        </div>
        {roleOffered ? (
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-role`}>
              Programme role
            </label>
            <select
              id={`${idPrefix}-role`}
              className="select"
              value={draft.role}
              onChange={(event) => set('role', event.target.value)}
            >
              <option value="">None</option>
              <option value={roleOffered}>{humanize(roleOffered)}</option>
            </select>
            <span className="field-hint">
              A role is how the programme finds this answer across cycles.
            </span>
          </div>
        ) : null}
      </div>

      <div>
        <label className="field-label" htmlFor={`${idPrefix}-label`}>
          {type === 'STATEMENT' ? 'The statement' : 'Label the applicant reads'}
        </label>
        <input
          id={`${idPrefix}-label`}
          className="input"
          value={draft.label}
          onChange={(event) => set('label', event.target.value)}
        />
      </div>
      <div>
        <label className="field-label" htmlFor={`${idPrefix}-help`}>
          Guidance under the control (optional)
        </label>
        <input
          id={`${idPrefix}-help`}
          className="input"
          value={draft.helpText}
          onChange={(event) => set('helpText', event.target.value)}
        />
      </div>

      {type === 'REPEAT_GROUP' ? (
        <div className={styles.grid}>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-repeat-min`}>
              Fewest entries
            </label>
            <input
              id={`${idPrefix}-repeat-min`}
              className="input tabular"
              type="number"
              min={0}
              max={20}
              value={draft.repeatMin}
              onChange={(event) => set('repeatMin', event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-repeat-max`}>
              Most entries (up to 20)
            </label>
            <input
              id={`${idPrefix}-repeat-max`}
              className="input tabular"
              type="number"
              min={1}
              max={20}
              value={draft.repeatMax}
              onChange={(event) => set('repeatMax', event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-structure`}>
              Structure
            </label>
            <select
              id={`${idPrefix}-structure`}
              className="select"
              value={draft.groupDefinitionKey}
              onChange={(event) => set('groupDefinitionKey', event.target.value)}
            >
              <option value="">None — author its members here</option>
              {(definitions ?? []).map((definition) => (
                <option key={definition.definitionKey} value={definition.definitionKey}>
                  {definition.label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Using a structure takes its questions from the definition; the group may not
              declare its own.
            </span>
          </div>
        </div>
      ) : null}

      {LENGTH_TYPES.has(type) ? (
        <div className={styles.grid}>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-min-length`}>
              Fewest characters
            </label>
            <input
              id={`${idPrefix}-min-length`}
              className="input tabular"
              type="number"
              min={0}
              value={draft.minLength}
              onChange={(event) => set('minLength', event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-max-length`}>
              Most characters
            </label>
            <input
              id={`${idPrefix}-max-length`}
              className="input tabular"
              type="number"
              min={1}
              value={draft.maxLength}
              onChange={(event) => set('maxLength', event.target.value)}
            />
          </div>
          <div className={styles.wide}>
            <label className="field-label" htmlFor={`${idPrefix}-pattern`}>
              Format rule (a regular expression, optional)
            </label>
            <input
              id={`${idPrefix}-pattern`}
              className="input tabular"
              value={draft.pattern}
              onChange={(event) => set('pattern', event.target.value)}
            />
            <span className="field-hint">
              Needs a most-characters bound, so a hostile answer is bounded before the
              rule runs.
            </span>
          </div>
          {draft.pattern.trim() ? (
            <div className={styles.wide}>
              <label className="field-label" htmlFor={`${idPrefix}-pattern-message`}>
                What to say when it does not match
              </label>
              <input
                id={`${idPrefix}-pattern-message`}
                className="input"
                value={draft.patternMessage}
                onChange={(event) => set('patternMessage', event.target.value)}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {NUMBER_TYPES.has(type) ? (
        <div className={styles.grid}>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-min-value`}>
              {type === 'MONEY_PAISE' ? 'Smallest amount (paise)' : 'Smallest number'}
            </label>
            <input
              id={`${idPrefix}-min-value`}
              className="input tabular"
              value={draft.minValue}
              onChange={(event) => set('minValue', event.target.value)}
            />
            {type === 'MONEY_PAISE' ? (
              <span className="field-hint">Required for an amount. ₹1 is 100.</span>
            ) : null}
          </div>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-max-value`}>
              {type === 'MONEY_PAISE' ? 'Largest amount (paise)' : 'Largest number'}
            </label>
            <input
              id={`${idPrefix}-max-value`}
              className="input tabular"
              value={draft.maxValue}
              onChange={(event) => set('maxValue', event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {DATE_TYPES.has(type) ? (
        <div className={styles.grid}>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-min-date`}>
              Earliest day
            </label>
            <input
              id={`${idPrefix}-min-date`}
              className="input"
              type="date"
              value={draft.minDate}
              onChange={(event) => set('minDate', event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-max-date`}>
              Latest day
            </label>
            <input
              id={`${idPrefix}-max-date`}
              className="input"
              type="date"
              value={draft.maxDate}
              onChange={(event) => set('maxDate', event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-relative-bound`}>
              Relative bound
            </label>
            <select
              id={`${idPrefix}-relative-bound`}
              className="select"
              value={draft.relativeDateBound}
              onChange={(event) => set('relativeDateBound', event.target.value)}
            >
              <option value="">None</option>
              <option value="NOT_FUTURE">Not in the future</option>
              <option value="NOT_PAST">Not in the past</option>
            </select>
          </div>
        </div>
      ) : null}

      {type === 'FILE' && variant === 'question' ? (
        <div className={styles.grid}>
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-max-bytes`}>
              Largest upload (bytes)
            </label>
            <input
              id={`${idPrefix}-max-bytes`}
              className="input tabular"
              type="number"
              min={1}
              value={draft.maxFileBytes}
              onChange={(event) => set('maxFileBytes', event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {isChoice ? (
        <OptionsEditor
          idPrefix={idPrefix}
          options={draft.options}
          onChange={(options) => set('options', options)}
        />
      ) : null}

      <p className={styles.subheading}>Presentation</p>
      <div className={styles.grid}>
        {PLACEHOLDER_TYPES.has(type) ? (
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-placeholder`}>
              Ghost text in the empty control
            </label>
            <input
              id={`${idPrefix}-placeholder`}
              className="input"
              maxLength={200}
              value={draft.placeholder}
              onChange={(event) => set('placeholder', event.target.value)}
            />
          </div>
        ) : null}
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-width`}>
            Width
          </label>
          <select
            id={`${idPrefix}-width`}
            className="select"
            value={draft.widthHint}
            onChange={(event) => set('widthHint', event.target.value)}
          >
            <option value="">Full (default)</option>
            {WIDTH_HINTS.map((width) => (
              <option key={width} value={width}>
                {humanize(width)}
              </option>
            ))}
          </select>
        </div>
        {AFFIX_TYPES.has(type) ? (
          <>
            <div>
              <label className="field-label" htmlFor={`${idPrefix}-prefix`}>
                Before the value
              </label>
              <input
                id={`${idPrefix}-prefix`}
                className="input"
                maxLength={8}
                placeholder="₹"
                value={draft.prefixText}
                onChange={(event) => set('prefixText', event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor={`${idPrefix}-suffix`}>
                After the value
              </label>
              <input
                id={`${idPrefix}-suffix`}
                className="input"
                maxLength={8}
                placeholder="yrs"
                value={draft.suffixText}
                onChange={(event) => set('suffixText', event.target.value)}
              />
            </div>
          </>
        ) : null}
        {AUTOCOMPLETE_TYPES.has(type) ? (
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-autocomplete`}>
              Browser autofill
            </label>
            <select
              id={`${idPrefix}-autocomplete`}
              className="select"
              value={draft.autocompleteHint}
              onChange={(event) => set('autocompleteHint', event.target.value)}
            >
              <option value="">No hint</option>
              {AUTOCOMPLETE_HINTS.map((hint) => (
                <option key={hint} value={hint}>
                  {hint}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {type === 'LONG_TEXT' ? (
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-rows`}>
              Rows the control opens with (2–20)
            </label>
            <input
              id={`${idPrefix}-rows`}
              className="input tabular"
              type="number"
              min={2}
              max={20}
              value={draft.textareaRows}
              onChange={(event) => set('textareaRows', event.target.value)}
            />
          </div>
        ) : null}
        {isChoice ? (
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-choice-style`}>
              Drawn as
            </label>
            <select
              id={`${idPrefix}-choice-style`}
              className="select"
              value={draft.choiceStyle}
              onChange={(event) => set('choiceStyle', event.target.value)}
            >
              <option value="">Default</option>
              {(type === 'SINGLE_CHOICE'
                ? SINGLE_CHOICE_STYLES
                : MULTI_CHOICE_STYLES
              ).map((style) => (
                <option key={style} value={style}>
                  {humanize(style)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {CHAR_COUNT_TYPES.has(type) ? (
          <label
            className="checkbox-row"
            style={{ alignSelf: 'end' }}
            htmlFor={`${idPrefix}-char-count`}
          >
            <input
              id={`${idPrefix}-char-count`}
              type="checkbox"
              checked={draft.showCharCount}
              onChange={(event) => set('showCharCount', event.target.checked)}
            />
            Show characters remaining
            {draft.maxLength.trim() === '' ? ' (needs a most-characters bound)' : ''}
          </label>
        ) : null}
      </div>
      <div className={styles.grid}>
        <div className={styles.wide}>
          <label className="field-label" htmlFor={`${idPrefix}-note`}>
            Inline note under the control (optional)
          </label>
          <input
            id={`${idPrefix}-note`}
            className="input"
            maxLength={500}
            value={draft.note}
            onChange={(event) => set('note', event.target.value)}
          />
        </div>
        {draft.note.trim() ? (
          <div>
            <label className="field-label" htmlFor={`${idPrefix}-tone`}>
              Note tone
            </label>
            <select
              id={`${idPrefix}-tone`}
              className="select"
              value={draft.tone}
              onChange={(event) => set('tone', event.target.value)}
            >
              <option value="">Neutral</option>
              {TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {humanize(tone)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {variant === 'question' ? (
        <ConditionsEditor
          idPrefix={idPrefix}
          conditions={draft.conditions}
          sources={sources}
          requirement={draft.requirement}
          onChange={(conditions) => set('conditions', conditions)}
        />
      ) : null}
    </div>
  )
}

function OptionsEditor({
  idPrefix,
  options,
  onChange,
}: {
  idPrefix: string
  options: OptionDraft[]
  onChange: (options: OptionDraft[]) => void
}) {
  const update = (index: number, patch: Partial<OptionDraft>) =>
    onChange(
      options.map((option, at) => (at === index ? { ...option, ...patch } : option)),
    )
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <p className={styles.subheading}>Choices offered</p>
      {options.map((option, index) => (
        <div className={styles.row} key={index}>
          <input
            className="input tabular"
            aria-label={`Stored value of choice ${index + 1}`}
            placeholder="VALUE"
            value={option.value}
            onChange={(event) =>
              update(index, {
                value: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_'),
              })
            }
          />
          <input
            className="input"
            aria-label={`Label of choice ${index + 1}`}
            placeholder="What the applicant reads"
            value={option.label}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <input
            className="input"
            aria-label={`Description of choice ${index + 1}`}
            placeholder="Sentence on the card (optional)"
            maxLength={200}
            value={option.description}
            onChange={(event) => update(index, { description: event.target.value })}
          />
          <input
            className="input tabular"
            aria-label={`Icon of choice ${index + 1}`}
            placeholder="icon-name"
            maxLength={32}
            value={option.iconName}
            onChange={(event) =>
              update(index, { iconName: event.target.value.toLowerCase() })
            }
          />
          <button
            type="button"
            className="button"
            data-variant="ghost"
            onClick={() => onChange(options.filter((_, at) => at !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="button"
          id={`${idPrefix}-add-option`}
          onClick={() =>
            onChange([
              ...options,
              { value: '', label: '', description: '', iconName: '' },
            ])
          }
        >
          Add a choice
        </button>
      </div>
    </div>
  )
}

function ConditionsEditor({
  idPrefix,
  conditions,
  sources,
  requirement,
  onChange,
}: {
  idPrefix: string
  conditions: ConditionDraft[]
  sources: TemplateView['fields']
  requirement: FormFieldRequirement
  onChange: (conditions: ConditionDraft[]) => void
}) {
  const update = (index: number, patch: Partial<ConditionDraft>) =>
    onChange(
      conditions.map((condition, at) =>
        at === index ? { ...condition, ...patch } : condition,
      ),
    )
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <p className={styles.subheading}>When it is shown, and when it becomes required</p>
      {requirement === 'CONDITIONAL' &&
      !conditions.some((condition) => condition.effect === 'REQUIRED_WHEN') ? (
        <p className="field-hint">
          Required on a condition needs at least one “required when” rule saying when.
        </p>
      ) : null}
      {conditions.map((condition, index) => (
        <div className={styles.row} key={index}>
          <select
            className="select"
            aria-label={`Effect of rule ${index + 1}`}
            value={condition.effect}
            onChange={(event) =>
              update(index, { effect: event.target.value as FieldConditionEffect })
            }
          >
            {CONDITION_EFFECTS.map((effect) => (
              <option key={effect} value={effect}>
                {effect === 'VISIBLE_WHEN' ? 'Shown when' : 'Required when'}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label={`Question rule ${index + 1} reads`}
            value={condition.sourceFieldKey}
            onChange={(event) => update(index, { sourceFieldKey: event.target.value })}
          >
            <option value="">Choose a question</option>
            {sources.map((source) => (
              <option key={source.key} value={source.key}>
                {source.label}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label={`Comparison of rule ${index + 1}`}
            value={condition.operator}
            onChange={(event) =>
              update(index, { operator: event.target.value as FieldConditionOperator })
            }
          >
            {CONDITION_OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {humanize(operator)}
              </option>
            ))}
          </select>
          {VALUELESS_OPERATORS.has(condition.operator) ? null : (
            <input
              className="input"
              aria-label={`Value rule ${index + 1} compares against`}
              placeholder="true"
              value={condition.comparisonValue}
              onChange={(event) => update(index, { comparisonValue: event.target.value })}
            />
          )}
          <button
            type="button"
            className="button"
            data-variant="ghost"
            onClick={() => onChange(conditions.filter((_, at) => at !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="button"
          id={`${idPrefix}-add-condition`}
          disabled={sources.length === 0}
          onClick={() =>
            onChange([
              ...conditions,
              {
                effect: 'VISIBLE_WHEN',
                sourceFieldKey: sources[0]?.key ?? '',
                operator: 'EQUALS',
                comparisonValue: '',
              },
            ])
          }
        >
          Add a rule
        </button>
      </div>
    </div>
  )
}
