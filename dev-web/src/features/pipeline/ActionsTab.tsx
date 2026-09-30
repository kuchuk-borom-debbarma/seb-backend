/**
 * A stage's actions: the buttons its owners press.
 *
 * Each action is a label, what it asks the officer, when it is offered, and
 * what it does. The permission an officer needs to take it is the union of
 * its effects' permissions, shown here so the author can see which roles will
 * be able to press it before anybody tries.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import type { PipelineConditionSource, PipelineInputFieldType } from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import type { ConditionScope } from './ConditionsEditor'
import { ConditionsEditor } from './ConditionsEditor'
import { blankAction, freshKey, KEY_PATTERN, toKey, type PipelineAction } from './definition'
import { EffectsEditor } from './EffectsEditor'
import { moveAt, removeAt, renameInput, updateAction, updateStage } from './editorState'
import { InputsEditor } from './InputsEditor'
import { defaultAnswerNames, flagNames, recordedValueNames, stageNames, type TabProps } from './names'
import type { PipelineCatalogue } from './pipelineQueries'
import styles from './Pipeline.module.css'

/** The permissions an action needs, as its effects declare them. */
const permissionsOf = (action: PipelineAction, catalogue: PipelineCatalogue, definition: TabProps['definition']): string[] => {
  const pairs = new Set<string>()
  for (const effect of action.effects) {
    const entry = catalogue.effects.find((each) => each.key === effect.type)
    if (!entry?.permission) continue
    if (entry.permission === 'BY_FLAG_KIND') {
      const flag = definition.statusFlags.find((each) => each.key === effect.params.flag)
      pairs.add(flag?.kind === 'OUTCOME' ? 'stage:decide' : 'stage:advance')
    } else {
      pairs.add(entry.permission)
    }
  }
  return [...pairs].sort()
}

export function ActionsTab({
  definition,
  edit,
  readOnly,
  catalogue,
  stageIndex,
  actionIndex,
  onSelect,
}: TabProps & {
  catalogue: PipelineCatalogue
  stageIndex: number
  actionIndex: number
  onSelect: (stageIndex: number, actionIndex: number) => void
}) {
  const stage = definition.stages[stageIndex]
  const action = stage?.actions[actionIndex]

  const sources = catalogue.conditionSources.map((source) => source.key as PipelineConditionSource)
  const inputTypes = catalogue.inputFieldTypes.map((type) => type.key as PipelineInputFieldType)

  const inputNames = useMemo(
    () => (action?.inputs ?? []).map((input) => ({ key: input.key, label: input.label || input.key, type: input.type, options: input.options })),
    [action],
  )
  const scope: ConditionScope = {
    readOnly,
    sources,
    answerTypes: inputTypes,
    answers: defaultAnswerNames,
    flags: flagNames(definition),
    recordedValues: recordedValueNames(definition),
    inputs: inputNames,
  }

  if (!stage) return <div className="card card-body"><p>Add a stage first.</p></div>

  const setAction = (update: (current: PipelineAction) => PipelineAction) =>
    edit((current) => updateAction(current, stageIndex, actionIndex, update))

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field-label" htmlFor="actionsStage" style={{ margin: 0 }}>Stage</label>
        <select id="actionsStage" className="select" style={{ maxWidth: '20rem' }} value={stageIndex}
          onChange={(event) => onSelect(Number(event.target.value), 0)}>
          {definition.stages.map((each, index) => (
            <option key={`${each.key}-${index}`} value={index}>{each.name || each.key}</option>
          ))}
        </select>
      </div>

      <div className={styles.split}>
        <div className="card">
          <nav className={styles.list} aria-label={`Actions at ${stage.name}`}>
            {stage.actions.length === 0 ? <p className="field-hint" style={{ padding: '0.5rem' }}>No actions yet.</p> : null}
            {stage.actions.map((each, index) => (
              <button key={`${each.key}-${index}`} type="button" className={styles.listItem} aria-current={index === actionIndex}
                onClick={() => onSelect(stageIndex, index)}>
                <span>
                  {each.label || 'Untitled action'}
                  <br />
                  <span className={styles.listKey}>{each.key}</span>
                </span>
              </button>
            ))}
            {readOnly ? null : (
              <button type="button" className="button" data-variant="ghost"
                onClick={() => {
                  const key = freshKey('NEW_ACTION', stage.actions.map((each) => each.key))
                  edit((current) => updateStage(current, stageIndex, (each) => ({ ...each, actions: [...each.actions, blankAction(key, current, each.key)] })))
                  onSelect(stageIndex, stage.actions.length)
                }}>
                <Plus size={14} aria-hidden /> Add an action
              </button>
            )}
          </nav>
        </div>

        {action ? (
          <section className="card card-body stack" aria-label={`Action ${action.label}`}>
            <div className={styles.itemHeader}>
              <h2 className="section-title" style={{ margin: 0 }}>{action.label || 'Untitled action'}</h2>
              {readOnly ? null : (
                <span className="row" style={{ gap: '0.25rem' }}>
                  <button type="button" className={styles.iconButton} aria-label="Move up" disabled={actionIndex === 0}
                    onClick={() => { edit((current) => updateStage(current, stageIndex, (each) => ({ ...each, actions: moveAt(each.actions, actionIndex, -1) }))); onSelect(stageIndex, actionIndex - 1) }}>
                    <ArrowUp size={14} aria-hidden />
                  </button>
                  <button type="button" className={styles.iconButton} aria-label="Move down" disabled={actionIndex === stage.actions.length - 1}
                    onClick={() => { edit((current) => updateStage(current, stageIndex, (each) => ({ ...each, actions: moveAt(each.actions, actionIndex, 1) }))); onSelect(stageIndex, actionIndex + 1) }}>
                    <ArrowDown size={14} aria-hidden />
                  </button>
                  <button type="button" className={styles.iconButton} aria-label="Remove this action"
                    onClick={() => { edit((current) => updateStage(current, stageIndex, (each) => ({ ...each, actions: removeAt(each.actions, actionIndex) }))); onSelect(stageIndex, Math.max(0, actionIndex - 1)) }}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </span>
              )}
            </div>

            <p className={styles.effectPermission} style={{ margin: 0 }}>
              An officer needs to own this stage and hold:{' '}
              {permissionsOf(action, catalogue, definition).map((pair) => humanize(pair.replace(':', ': '))).join(', ') || 'nothing — the server refuses such an action'}.
            </p>

            <div className={styles.grid2}>
              <div>
                <label className="field-label" htmlFor="actionLabel">Button label</label>
                <input id="actionLabel" className="input" maxLength={60} readOnly={readOnly} value={action.label}
                  aria-invalid={action.label.trim() === ''}
                  onChange={(event) => setAction((each) => ({ ...each, label: event.target.value }))} />
              </div>
              <div>
                <label className="field-label" htmlFor="actionKey">Key</label>
                <input id="actionKey" key={action.key} className="input" readOnly={readOnly} defaultValue={action.key}
                  onBlur={(event) => {
                    const next = toKey(event.target.value)
                    if (next === action.key) return
                    if (!KEY_PATTERN.test(next) || stage.actions.some((each) => each.key === next)) {
                      event.target.value = action.key
                      return
                    }
                    setAction((each) => ({ ...each, key: next }))
                  }} />
                <p className="field-hint">The history records actions by this key.</p>
              </div>
            </div>
            <div className={styles.grid2}>
              <div>
                <label className="field-label" htmlFor="actionDescription">What it does, for the officer</label>
                <textarea id="actionDescription" className="textarea" maxLength={300} readOnly={readOnly} style={{ minHeight: '3rem' }}
                  value={action.description ?? ''}
                  onChange={(event) => setAction((each) => ({ ...each, description: event.target.value || null }))} />
              </div>
              <div>
                <label className="field-label" htmlFor="actionConfirmation">Ask before taking it</label>
                <textarea id="actionConfirmation" className="textarea" maxLength={300} readOnly={readOnly} style={{ minHeight: '3rem' }}
                  placeholder="e.g., This closes the application. It cannot be undone."
                  value={action.confirmation ?? ''}
                  onChange={(event) => setAction((each) => ({ ...each, confirmation: event.target.value || null }))} />
                <p className="field-hint">Leave empty for an action that needs no second thought.</p>
              </div>
            </div>

            <div className={styles.subsection}>
              <h3 className={styles.subsectionTitle}>What it asks the officer</h3>
              <InputsEditor
                idPrefix="actionInput"
                inputs={action.inputs}
                onChange={(inputs) => setAction((each) => ({ ...each, inputs }))}
                onRename={(from, to) => setAction((each) => renameInput(each, from, to))}
                types={inputTypes}
                scope={scope}
                recordedValues={recordedValueNames(definition)}
                answers={defaultAnswerNames}
              />
            </div>

            <div className={styles.subsection}>
              <h3 className={styles.subsectionTitle}>When it is offered</h3>
              <ConditionsEditor
                idPrefix="actionAvailable"
                conditions={action.availableWhen}
                onChange={(availableWhen) => setAction((each) => ({ ...each, availableWhen }))}
                scope={scope}
                allowInputs={false}
                empty="Always offered while the file is at this stage."
              />
            </div>

            <div className={styles.subsection}>
              <h3 className={styles.subsectionTitle}>What it does</h3>
              <EffectsEditor
                idPrefix="actionEffect"
                effects={action.effects}
                onChange={(effects) => setAction((each) => ({ ...each, effects }))}
                catalogue={catalogue.effects}
                scope={scope}
                statusFlags={definition.statusFlags}
                paramContext={{
                  readOnly,
                  stages: stageNames(definition),
                  flags: flagNames(definition),
                  inputs: inputNames,
                  recordedValues: recordedValueNames(definition),
                  answers: defaultAnswerNames,
                  kinds: [],
                  pipelines: [],
                  openKeys: false,
                }}
              />
            </div>
          </section>
        ) : (
          <div className="card card-body"><p>{stage.actions.length === 0 ? 'Add the first action for this stage.' : 'Choose an action.'}</p></div>
        )}
      </div>
    </div>
  )
}
