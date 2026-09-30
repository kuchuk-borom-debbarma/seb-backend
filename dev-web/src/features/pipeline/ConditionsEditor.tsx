/**
 * A list of conditions, with the combinator the form uses: **conditions in
 * the same group must all hold, and any one group holding is enough.**
 *
 * Used three ways — whether an action is offered, whether an input is shown,
 * whether an effect applies — and the one difference is whether an action's
 * own inputs may be read. They may not decide whether the action is offered,
 * because the officer has not filled them in yet; the server refuses it, so
 * the source is simply not offered there.
 */
import { Plus, Trash2 } from 'lucide-react'
import type { PipelineConditionSource, PipelineInputFieldType } from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import {
  blankCondition,
  CONDITION_OPERATORS,
  UNARY_OPERATORS,
  type ConditionOperator,
  type PipelineCondition,
} from './definition'
import { removeAt, replaceAt } from './editorState'
import type { Named } from './paramControls'
import styles from './Pipeline.module.css'

export type ConditionScope = {
  readOnly: boolean
  sources: readonly PipelineConditionSource[]
  answerTypes: readonly PipelineInputFieldType[]
  answers: readonly Named[]
  flags: readonly Named[]
  recordedValues: readonly Named[]
  inputs: readonly Named[]
}

const OPERATOR_WORDS: Record<ConditionOperator, string> = {
  EQUALS: 'equals',
  NOT_EQUALS: 'is not',
  GREATER_THAN: 'is more than',
  GREATER_OR_EQUAL: 'is at least',
  LESS_THAN: 'is less than',
  LESS_OR_EQUAL: 'is at most',
  IS_PRESENT: 'is present',
  IS_ABSENT: 'is absent',
}

export function ConditionsEditor({
  idPrefix,
  conditions,
  onChange,
  scope,
  allowInputs,
  empty,
}: {
  idPrefix: string
  conditions: PipelineCondition[]
  onChange: (conditions: PipelineCondition[]) => void
  scope: ConditionScope
  allowInputs: boolean
  /** What having no conditions means here, in the reader's terms. */
  empty: string
}) {
  const sources = scope.sources.filter((source) => allowInputs || source !== 'INPUT')
  const set = (index: number, next: PipelineCondition) => onChange(replaceAt(conditions, index, next))

  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      {conditions.length === 0 ? <p className="field-hint">{empty}</p> : null}
      {conditions.map((condition, index) => {
        const id = `${idPrefix}-${index}`
        const keys =
          condition.source === 'STATUS_FLAG'
            ? scope.flags
            : condition.source === 'RECORDED_VALUE'
              ? scope.recordedValues
              : condition.source === 'INPUT'
                ? scope.inputs
                : null
        // A flag is held or not; comparing it with a value means nothing.
        const operators = condition.source === 'STATUS_FLAG' ? UNARY_OPERATORS : CONDITION_OPERATORS
        const unary = UNARY_OPERATORS.includes(condition.operator)
        return (
          <div key={id} className={styles.conditionRow}>
            <label className="visually-hidden" htmlFor={`${id}-group`}>Group</label>
            <input
              id={`${id}-group`}
              className="input tabular"
              type="number"
              min={1}
              max={16}
              title="Conditions in the same group must all hold; any group holding is enough."
              readOnly={scope.readOnly}
              value={condition.group}
              onChange={(event) => set(index, { ...condition, group: Math.min(16, Math.max(1, Number(event.target.value) || 1)) })}
            />
            <label className="visually-hidden" htmlFor={`${id}-source`}>Reads</label>
            <select
              id={`${id}-source`}
              className="select"
              disabled={scope.readOnly}
              value={condition.source}
              onChange={(event) => {
                const source = event.target.value as PipelineConditionSource
                set(index, { ...blankCondition(source), group: condition.group })
              }}
            >
              {sources.map((source) => (
                <option key={source} value={source}>{humanize(source)}</option>
              ))}
            </select>
            <label className="visually-hidden" htmlFor={`${id}-key`}>Which</label>
            {keys ? (
              <select
                id={`${id}-key`}
                className="select"
                disabled={scope.readOnly}
                value={condition.key}
                aria-invalid={condition.key === '' || !keys.some((named) => named.key === condition.key)}
                onChange={(event) => set(index, { ...condition, key: event.target.value })}
              >
                <option value="">Choose…</option>
                {condition.key !== '' && !keys.some((named) => named.key === condition.key) ? (
                  <option value={condition.key}>{condition.key} (does not exist)</option>
                ) : null}
                {keys.map((named) => (
                  <option key={named.key} value={named.key}>{named.label}</option>
                ))}
              </select>
            ) : (
              <>
                <input
                  id={`${id}-key`}
                  className="input"
                  list={`${id}-answers`}
                  placeholder="QUESTION_KEY"
                  readOnly={scope.readOnly}
                  value={condition.key}
                  aria-invalid={condition.key === ''}
                  onChange={(event) => set(index, { ...condition, key: event.target.value.toUpperCase() })}
                />
                <datalist id={`${id}-answers`}>
                  {scope.answers.map((named) => (
                    <option key={named.key} value={named.key}>{named.label}</option>
                  ))}
                </datalist>
              </>
            )}
            <label className="visually-hidden" htmlFor={`${id}-operator`}>Test</label>
            <select
              id={`${id}-operator`}
              className="select"
              disabled={scope.readOnly}
              value={condition.operator}
              onChange={(event) => {
                const operator = event.target.value as ConditionOperator
                set(index, { ...condition, operator, value: UNARY_OPERATORS.includes(operator) ? null : condition.value })
              }}
            >
              {operators.map((operator) => (
                <option key={operator} value={operator}>{OPERATOR_WORDS[operator]}</option>
              ))}
            </select>
            {unary ? (
              condition.source === 'ANSWER' ? (
                <AnswerType id={id} condition={condition} scope={scope} onChange={(next) => set(index, next)} />
              ) : (
                <span />
              )
            ) : (
              <div className="row" style={{ gap: '0.25rem' }}>
                <label className="visually-hidden" htmlFor={`${id}-value`}>Value</label>
                <input
                  id={`${id}-value`}
                  className="input"
                  placeholder={condition.answerType === 'BOOLEAN' ? 'true or false' : 'value'}
                  readOnly={scope.readOnly}
                  value={condition.value ?? ''}
                  onChange={(event) => set(index, { ...condition, value: event.target.value === '' ? null : event.target.value })}
                />
                {condition.source === 'ANSWER' ? (
                  <AnswerType id={id} condition={condition} scope={scope} onChange={(next) => set(index, next)} />
                ) : null}
              </div>
            )}
            <button
              type="button"
              className={styles.iconButton}
              disabled={scope.readOnly}
              aria-label="Remove this condition"
              onClick={() => onChange(removeAt(conditions, index))}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        )
      })}
      {scope.readOnly ? null : (
        <div>
          <button
            type="button"
            className="button"
            data-variant="ghost"
            onClick={() => onChange([...conditions, { ...blankCondition(sources[0] ?? 'ANSWER'), group: conditions.at(-1)?.group ?? 1 }])}
          >
            <Plus size={14} aria-hidden /> Add a condition
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The type of the answer an `ANSWER` condition reads. A pipeline is written
 * before any cycle's form, so it says what type it expects; the cycle is
 * checked against it when it opens.
 */
function AnswerType({ id, condition, scope, onChange }: {
  id: string
  condition: PipelineCondition
  scope: ConditionScope
  onChange: (next: PipelineCondition) => void
}) {
  return (
    <>
      <label className="visually-hidden" htmlFor={`${id}-type`}>Answer type</label>
      <select
        id={`${id}-type`}
        className="select"
        title="The type of answer this reads, checked against each cycle's form"
        disabled={scope.readOnly}
        value={condition.answerType ?? ''}
        aria-invalid={condition.answerType === null}
        onChange={(event) => onChange({ ...condition, answerType: (event.target.value || null) as PipelineInputFieldType | null })}
        style={{ maxWidth: '9rem' }}
      >
        <option value="">Type…</option>
        {scope.answerTypes.map((type) => (
          <option key={type} value={type}>{humanize(type)}</option>
        ))}
      </select>
    </>
  )
}
