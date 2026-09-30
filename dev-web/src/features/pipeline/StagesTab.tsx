/**
 * The stages: what the office calls each, what the applicant reads while their
 * file is there, and which flags mark a file as being there.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { blankStage, freshKey, KEY_PATTERN, toKey, isOrdinaryFlag } from './definition'
import { moveAt, removeAt, renameStage, updateStage } from './editorState'
import type { TabProps } from './names'
import styles from './Pipeline.module.css'

export function StagesTab({
  definition,
  edit,
  readOnly,
  selected,
  onSelect,
  onOpenActions,
}: TabProps & {
  selected: number
  onSelect: (index: number) => void
  onOpenActions: (stageIndex: number) => void
}) {
  const stage = definition.stages[selected]
  const keys = definition.stages.map((each) => each.key)

  return (
    <div className={styles.split}>
      <div className="card">
        <nav className={styles.list} aria-label="Stages">
          {definition.stages.map((each, index) => (
            <button
              key={`${each.key}-${index}`}
              type="button"
              className={styles.listItem}
              aria-current={index === selected}
              onClick={() => onSelect(index)}
            >
              <span>
                {each.name || 'Untitled stage'}
                <br />
                <span className={styles.listKey}>{each.key}</span>
              </span>
              {each.key === definition.initialStageKey ? <span className="badge" data-tone="blue">Entry</span> : null}
            </button>
          ))}
          {readOnly ? null : (
            <button
              type="button"
              className="button"
              data-variant="ghost"
              onClick={() => {
                const key = freshKey('NEW_STAGE', keys)
                edit((current) => ({ ...current, stages: [...current.stages, blankStage(key, 'New stage')] }))
                onSelect(definition.stages.length)
              }}
            >
              <Plus size={14} aria-hidden /> Add a stage
            </button>
          )}
        </nav>
      </div>

      {stage ? (
        <section className={`card card-body stack ${styles.underToolbar}`} aria-label={`Stage ${stage.name}`}>
          <div className={styles.itemHeader}>
            <h2 className="section-title" style={{ margin: 0 }}>{stage.name || 'Untitled stage'}</h2>
            {readOnly ? null : (
              <span className="row" style={{ gap: '0.25rem' }}>
                <button type="button" className={styles.iconButton} aria-label="Move up" disabled={selected === 0}
                  onClick={() => { edit((current) => ({ ...current, stages: moveAt(current.stages, selected, -1) })); onSelect(selected - 1) }}>
                  <ArrowUp size={14} aria-hidden />
                </button>
                <button type="button" className={styles.iconButton} aria-label="Move down" disabled={selected === definition.stages.length - 1}
                  onClick={() => { edit((current) => ({ ...current, stages: moveAt(current.stages, selected, 1) })); onSelect(selected + 1) }}>
                  <ArrowDown size={14} aria-hidden />
                </button>
                <button type="button" className={styles.iconButton} aria-label="Remove this stage" disabled={definition.stages.length === 1}
                  title={definition.stages.length === 1 ? 'A pipeline needs at least one stage.' : undefined}
                  onClick={() => { edit((current) => ({ ...current, stages: removeAt(current.stages, selected) })); onSelect(Math.max(0, selected - 1)) }}>
                  <Trash2 size={14} aria-hidden />
                </button>
              </span>
            )}
          </div>

          <div className={styles.grid2}>
            <div>
              <label className="field-label" htmlFor="stageName">Name, for the office</label>
              <input id="stageName" className="input" maxLength={80} readOnly={readOnly} value={stage.name}
                aria-invalid={stage.name.trim() === ''}
                onChange={(event) => edit((current) => updateStage(current, selected, (each) => ({ ...each, name: event.target.value })))} />
            </div>
            <div>
              <label className="field-label" htmlFor="stageKey">Key</label>
              <input id="stageKey" key={stage.key} className="input" readOnly={readOnly} defaultValue={stage.key}
                onBlur={(event) => {
                  const next = toKey(event.target.value)
                  if (next === stage.key) return
                  if (!KEY_PATTERN.test(next) || keys.includes(next)) {
                    event.target.value = stage.key
                    return
                  }
                  edit((current) => renameStage(current, stage.key, next))
                }} />
              <p className="field-hint">
                Owners are attached to the key: a renamed stage is a new stage, with nobody working it until owners are set.
              </p>
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="stageDescription">Description, for the office</label>
            <textarea id="stageDescription" className="textarea" maxLength={500} readOnly={readOnly} value={stage.description ?? ''}
              onChange={(event) => edit((current) => updateStage(current, selected, (each) => ({ ...each, description: event.target.value || null })))} />
          </div>

          <div className={styles.grid2}>
            <div>
              <label className="field-label" htmlFor="stageApplicantLabel">What the applicant sees</label>
              <input id="stageApplicantLabel" className="input" maxLength={80} readOnly={readOnly} value={stage.applicantLabel}
                aria-invalid={stage.applicantLabel.trim() === ''}
                placeholder="e.g., Under first review"
                onChange={(event) => edit((current) => updateStage(current, selected, (each) => ({ ...each, applicantLabel: event.target.value })))} />
            </div>
            <div>
              <label className="field-label" htmlFor="stageApplicantExplanation">And the sentence under it</label>
              <textarea id="stageApplicantExplanation" className="textarea" maxLength={400} readOnly={readOnly}
                style={{ minHeight: '2.5rem' }} value={stage.applicantExplanation ?? ''}
                onChange={(event) => edit((current) => updateStage(current, selected, (each) => ({ ...each, applicantExplanation: event.target.value || null })))} />
            </div>
          </div>

          <label className="checkbox-row">
            <input type="radio" name="initialStage" disabled={readOnly} checked={definition.initialStageKey === stage.key}
              onChange={() => edit((current) => ({ ...current, initialStageKey: stage.key }))} />
            <span>Submitted applications enter the pipeline here</span>
          </label>

          <div>
            <span className="field-label">Presence flags</span>
            <p className="field-hint" style={{ marginTop: 0 }}>
              Added when a file arrives here and removed when it leaves, so a flag like “with the bank” can never outlive the file being there.
              At most four.
            </p>
            {definition.statusFlags.length === 0 ? (
              <p className="field-hint">Declare status flags first, on the Status flags tab.</p>
            ) : (
              <div className={styles.chips}>
                {definition.statusFlags.map((flag) => {
                  const held = stage.presenceFlags.includes(flag.key)
                  // A held flag stays offered even if it stopped being
                  // ordinary, so it can be taken off again.
                  if (!held && !isOrdinaryFlag(flag)) return null
                  return (
                    <button key={flag.key} type="button" className={styles.chipToggle} aria-pressed={held}
                      disabled={readOnly || (!held && stage.presenceFlags.length >= 4)}
                      onClick={() => edit((current) => updateStage(current, selected, (each) => ({
                        ...each,
                        presenceFlags: held ? each.presenceFlags.filter((key) => key !== flag.key) : [...each.presenceFlags, flag.key],
                      })))}>
                      {flag.label || flag.key}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionHeader}>
              <h3 className={styles.subsectionTitle}>Actions ({stage.actions.length})</h3>
              <button type="button" className="button" onClick={() => onOpenActions(selected)}>
                {readOnly ? 'View its actions' : 'Edit its actions'}
              </button>
            </div>
            {stage.actions.length === 0 ? (
              <p className="field-error">A stage with no action is a place a file can never leave.</p>
            ) : (
              <ul className={styles.tagList}>
                {stage.actions.map((action) => <li key={action.key} className={styles.tag}>{action.label || action.key}</li>)}
              </ul>
            )}
          </div>
        </section>
      ) : (
        <div className="card card-body"><p>Choose a stage.</p></div>
      )}
    </div>
  )
}
