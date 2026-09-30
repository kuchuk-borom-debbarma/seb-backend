/**
 * What an action asks the officer: an amount, a bank, a note, a reference.
 *
 * Inputs are form fields — the same types, bounds and validation as an
 * applicant's answers — so this edits the parts of a field a stage action
 * uses and nothing else. Money bounds are typed in rupees and kept in paise,
 * through the same helpers the applicant's form uses.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { paiseToRupees, rupeesToPaise } from '#/features/application/money'
import type { PipelineInputFieldType } from '#/graphql/generated/schema'
import { ConditionsEditor, type ConditionScope } from './ConditionsEditor'
import { blankInput, freshKey, KEY_PATTERN, toKey, type PipelineInput, typeLabel } from './definition'
import { moveAt, removeAt, replaceAt } from './editorState'
import type { Named } from './paramControls'
import styles from './Pipeline.module.css'

const CHOICE_TYPES: readonly string[] = ['SINGLE_CHOICE', 'MULTI_CHOICE']
const LENGTH_TYPES: readonly string[] = ['TEXT', 'LONG_TEXT']

const numberOrNull = (text: string): number | null => {
  if (text.trim() === '') return null
  const parsed = Number(text)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

export function InputsEditor({
  idPrefix,
  inputs,
  onChange,
  onRename,
  types,
  scope,
  recordedValues,
  answers,
}: {
  idPrefix: string
  inputs: PipelineInput[]
  onChange: (inputs: PipelineInput[]) => void
  /** A key changed: the action's effects and conditions must follow it. */
  onRename: (from: string, to: string) => void
  types: readonly PipelineInputFieldType[]
  scope: ConditionScope
  recordedValues: readonly Named[]
  answers: readonly Named[]
}) {
  const { readOnly } = scope
  const set = (index: number, next: PipelineInput) => onChange(replaceAt(inputs, index, next))

  return (
    <div className="stack" style={{ gap: '0.75rem' }}>
      {inputs.length === 0 ? <p className="field-hint">This action asks nothing: the officer only confirms it.</p> : null}
      {inputs.map((input, index) => {
        const id = `${idPrefix}-${index}`
        return (
          <div key={id} className={styles.item}>
            <div className={styles.itemHeader}>
              <span className={styles.itemTitle}>
                {input.label || 'Untitled input'} <code className={styles.listKey}>{input.key}</code>
              </span>
              {readOnly ? null : (
                <span className="row" style={{ gap: '0.25rem' }}>
                  <button type="button" className={styles.iconButton} aria-label="Move up" disabled={index === 0} onClick={() => onChange(moveAt(inputs, index, -1))}>
                    <ArrowUp size={14} aria-hidden />
                  </button>
                  <button type="button" className={styles.iconButton} aria-label="Move down" disabled={index === inputs.length - 1} onClick={() => onChange(moveAt(inputs, index, 1))}>
                    <ArrowDown size={14} aria-hidden />
                  </button>
                  <button type="button" className={styles.iconButton} aria-label="Remove this input" onClick={() => onChange(removeAt(inputs, index))}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </span>
              )}
            </div>

            <div className={styles.grid2}>
              <div>
                <label className="field-label" htmlFor={`${id}-label`}>Label</label>
                <input id={`${id}-label`} className="input" maxLength={160} readOnly={readOnly} value={input.label}
                  aria-invalid={input.label.trim() === ''}
                  onChange={(event) => set(index, { ...input, label: event.target.value })} />
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-key`}>Key</label>
                <input id={`${id}-key`} className="input" readOnly={readOnly} defaultValue={input.key} key={input.key}
                  onBlur={(event) => {
                    const next = toKey(event.target.value)
                    if (next === input.key) return
                    if (!KEY_PATTERN.test(next) || inputs.some((other) => other.key === next)) {
                      event.target.value = input.key
                      return
                    }
                    onRename(input.key, next)
                  }} />
                <p className="field-hint">Effects name the input by this.</p>
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-type`}>Type</label>
                <select id={`${id}-type`} className="select" disabled={readOnly} value={input.type}
                  onChange={(event) => {
                    const type = event.target.value as PipelineInputFieldType
                    set(index, {
                      ...input,
                      type,
                      // Bounds and options of one type mean nothing on another.
                      minLength: null, maxLength: null, minValue: null, maxValue: null,
                      minDate: null, maxDate: null, relativeDateBound: null,
                      options: CHOICE_TYPES.includes(type) ? input.options : [],
                      requirement: type === 'STATEMENT' ? 'OPTIONAL' : input.requirement,
                    })
                  }}>
                  {types.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
                </select>
              </div>
              {input.type === 'STATEMENT' ? null : (
                <div>
                  <label className="field-label" htmlFor={`${id}-required`}>Answer</label>
                  <select id={`${id}-required`} className="select" disabled={readOnly} value={input.requirement}
                    onChange={(event) => set(index, { ...input, requirement: event.target.value as PipelineInput['requirement'] })}>
                    <option value="REQUIRED">Required</option>
                    <option value="OPTIONAL">Optional</option>
                  </select>
                </div>
              )}
            </div>

            <div style={{ marginTop: '0.75rem' }}>
              <label className="field-label" htmlFor={`${id}-help`}>{input.type === 'STATEMENT' ? 'Text shown to the officer' : 'Help text'}</label>
              <textarea id={`${id}-help`} className="textarea" maxLength={500} readOnly={readOnly} value={input.helpText ?? ''}
                style={{ minHeight: '3rem' }}
                onChange={(event) => set(index, { ...input, helpText: event.target.value || null })} />
            </div>

            <Bounds id={id} input={input} readOnly={readOnly} onChange={(next) => set(index, next)} />

            {CHOICE_TYPES.includes(input.type) ? (
              <Options id={id} input={input} readOnly={readOnly} onChange={(next) => set(index, next)} />
            ) : null}

            {input.type === 'STATEMENT' ? null : (
              <div className={styles.grid2} style={{ marginTop: '0.75rem' }}>
                <div>
                  <label className="field-label" htmlFor={`${id}-default-source`}>Starts filled with</label>
                  <select id={`${id}-default-source`} className="select" disabled={readOnly}
                    value={input.defaultFrom?.source ?? ''}
                    onChange={(event) => {
                      const source = event.target.value
                      set(index, {
                        ...input,
                        defaultFrom: source === '' ? null : { source: source as 'ANSWER' | 'RECORDED_VALUE', key: '' },
                      })
                    }}>
                    <option value="">Nothing — the officer types it</option>
                    <option value="ANSWER">An answer on the application</option>
                    <option value="RECORDED_VALUE">A value recorded earlier</option>
                  </select>
                  <p className="field-hint">The officer can change what it starts with.</p>
                </div>
                {input.defaultFrom ? (
                  <div>
                    <label className="field-label" htmlFor={`${id}-default-key`}>Which</label>
                    {input.defaultFrom.source === 'RECORDED_VALUE' ? (
                      <select id={`${id}-default-key`} className="select" disabled={readOnly} value={input.defaultFrom.key}
                        aria-invalid={input.defaultFrom.key === ''}
                        onChange={(event) => set(index, { ...input, defaultFrom: { source: 'RECORDED_VALUE', key: event.target.value } })}>
                        <option value="">Choose…</option>
                        {recordedValues.map((value) => <option key={value.key} value={value.key}>{value.label}</option>)}
                      </select>
                    ) : (
                      <>
                        <input id={`${id}-default-key`} className="input" list={`${id}-default-answers`} readOnly={readOnly}
                          value={input.defaultFrom.key} placeholder="QUESTION_KEY" aria-invalid={input.defaultFrom.key === ''}
                          onChange={(event) => set(index, { ...input, defaultFrom: { source: 'ANSWER', key: event.target.value.toUpperCase() } })} />
                        <datalist id={`${id}-default-answers`}>
                          {answers.map((answer) => <option key={answer.key} value={answer.key}>{answer.label}</option>)}
                        </datalist>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            )}

            <div style={{ marginTop: '0.75rem' }}>
              <span className="field-label">Shown when</span>
              <ConditionsEditor
                idPrefix={`${id}-visible`}
                conditions={input.visibleWhen}
                onChange={(visibleWhen) => set(index, { ...input, visibleWhen })}
                // Only an earlier input can decide whether this one is shown.
                scope={{ ...scope, inputs: scope.inputs.filter((other) => inputs.findIndex((each) => each.key === other.key) < index) }}
                allowInputs
                empty="Always shown."
              />
            </div>
          </div>
        )
      })}
      {readOnly ? null : (
        <div>
          <button type="button" className="button" data-variant="ghost"
            onClick={() => onChange([...inputs, blankInput(freshKey('NOTE', inputs.map((input) => input.key)))])}>
            <Plus size={14} aria-hidden /> Add an input
          </button>
        </div>
      )}
    </div>
  )
}

/** The bounds the input's type has, and only those. */
function Bounds({ id, input, readOnly, onChange }: {
  id: string
  input: PipelineInput
  readOnly: boolean
  onChange: (next: PipelineInput) => void
}) {
  if (LENGTH_TYPES.includes(input.type)) {
    return (
      <div className={styles.grid2} style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor={`${id}-min-length`}>Shortest, in characters</label>
          <input id={`${id}-min-length`} className="input tabular" type="number" min={0} readOnly={readOnly}
            value={input.minLength ?? ''} onChange={(event) => onChange({ ...input, minLength: numberOrNull(event.target.value) })} />
        </div>
        <div>
          <label className="field-label" htmlFor={`${id}-max-length`}>Longest, in characters</label>
          <input id={`${id}-max-length`} className="input tabular" type="number" min={1} max={10000} readOnly={readOnly}
            value={input.maxLength ?? ''} onChange={(event) => onChange({ ...input, maxLength: numberOrNull(event.target.value) })} />
        </div>
      </div>
    )
  }
  if (input.type === 'INTEGER') {
    return (
      <div className={styles.grid2} style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor={`${id}-min`}>Smallest</label>
          <input id={`${id}-min`} className="input tabular" type="number" min={0} readOnly={readOnly}
            value={input.minValue ?? ''} onChange={(event) => onChange({ ...input, minValue: numberOrNull(event.target.value) })} />
        </div>
        <div>
          <label className="field-label" htmlFor={`${id}-max`}>Largest</label>
          <input id={`${id}-max`} className="input tabular" type="number" min={0} readOnly={readOnly}
            value={input.maxValue ?? ''} onChange={(event) => onChange({ ...input, maxValue: numberOrNull(event.target.value) })} />
        </div>
      </div>
    )
  }
  if (input.type === 'MONEY_PAISE') {
    const money = (label: string, key: 'minValue' | 'maxValue') => (
      <div>
        <label className="field-label" htmlFor={`${id}-${key}`}>{label}, in rupees</label>
        <input id={`${id}-${key}`} key={`${key}-${input[key]}`} className="input tabular" inputMode="decimal" readOnly={readOnly}
          defaultValue={paiseToRupees(input[key])}
          onBlur={(event) => {
            const paise = rupeesToPaise(event.target.value)
            if (paise === undefined || (paise !== null && paise < 0)) return
            onChange({ ...input, [key]: paise })
          }} />
      </div>
    )
    return (
      <div className={styles.grid2} style={{ marginTop: '0.75rem' }}>
        {money('Smallest', 'minValue')}
        {money('Largest', 'maxValue')}
      </div>
    )
  }
  if (input.type === 'DATE') {
    return (
      <div className={styles.grid2} style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor={`${id}-relative`}>Relative to today</label>
          <select id={`${id}-relative`} className="select" disabled={readOnly} value={input.relativeDateBound ?? ''}
            onChange={(event) => onChange({ ...input, relativeDateBound: (event.target.value || null) as PipelineInput['relativeDateBound'] })}>
            <option value="">Any date</option>
            <option value="NOT_FUTURE">Not in the future</option>
            <option value="NOT_PAST">Not in the past</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor={`${id}-min-date`}>Earliest</label>
          <input id={`${id}-min-date`} className="input" type="date" readOnly={readOnly} value={input.minDate ?? ''}
            onChange={(event) => onChange({ ...input, minDate: event.target.value || null })} />
        </div>
        <div>
          <label className="field-label" htmlFor={`${id}-max-date`}>Latest</label>
          <input id={`${id}-max-date`} className="input" type="date" readOnly={readOnly} value={input.maxDate ?? ''}
            onChange={(event) => onChange({ ...input, maxDate: event.target.value || null })} />
        </div>
      </div>
    )
  }
  return null
}

/** A choice's options: a stored value and what the officer reads. */
function Options({ id, input, readOnly, onChange }: {
  id: string
  input: PipelineInput
  readOnly: boolean
  onChange: (next: PipelineInput) => void
}) {
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <span className="field-label">Options</span>
      <div className="stack" style={{ gap: '0.375rem' }}>
        {input.options.length === 0 ? <p className="field-error">A choice needs at least one option.</p> : null}
        {input.options.map((option, index) => (
          <div key={`${id}-option-${index}`} className="row" style={{ gap: '0.5rem' }}>
            <label className="visually-hidden" htmlFor={`${id}-option-${index}-value`}>Value</label>
            <input id={`${id}-option-${index}-value`} className="input" style={{ maxWidth: '10rem' }} readOnly={readOnly}
              value={option.value} placeholder="VALUE"
              onChange={(event) => onChange({ ...input, options: replaceAt(input.options, index, { ...option, value: event.target.value.toUpperCase() }) })} />
            <label className="visually-hidden" htmlFor={`${id}-option-${index}-label`}>Label</label>
            <input id={`${id}-option-${index}-label`} className="input" readOnly={readOnly} value={option.label} placeholder="What the officer reads"
              onChange={(event) => onChange({ ...input, options: replaceAt(input.options, index, { ...option, label: event.target.value }) })} />
            {readOnly ? null : (
              <button type="button" className={styles.iconButton} aria-label="Remove this option"
                onClick={() => onChange({ ...input, options: removeAt(input.options, index) })}>
                <Trash2 size={14} aria-hidden />
              </button>
            )}
          </div>
        ))}
        {readOnly ? null : (
          <div>
            <button type="button" className="button" data-variant="ghost"
              onClick={() => onChange({ ...input, options: [...input.options, { value: freshKey('OPTION', input.options.map((each) => each.value)), label: '' }] })}>
              <Plus size={14} aria-hidden /> Add an option
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
