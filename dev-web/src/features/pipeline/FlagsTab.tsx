/**
 * Status flags and recorded values: what an application's status is made of,
 * and the named values actions keep on it.
 *
 * An application's status is the set of flags it holds, so these are the
 * words both the office and the applicant read it in. The two properties with
 * teeth are explained where they are set: a **terminal** flag ends the
 * journey, and an **editing** flag hands the pen back to the applicant, which
 * only a revision request may add.
 */
import { Plus, Trash2 } from 'lucide-react'
import {
  blankFlag,
  blankRecordedValue,
  freshKey,
  KEY_PATTERN,
  RECORDED_VALUE_TYPES,
  toKey,
  type PipelineRecordedValue,
  type PipelineStatusFlag, typeLabel } from './definition'
import { removeAt, renameFlag, renameRecordedValue, replaceAt } from './editorState'
import type { TabProps } from './names'
import styles from './Pipeline.module.css'

/** A key box that renames on blur, refusing a malformed or taken key by putting the old one back. */
function KeyField({ id, value, taken, readOnly, onRename }: {
  id: string
  value: string
  taken: readonly string[]
  readOnly: boolean
  onRename: (next: string) => void
}) {
  return (
    <input
      id={id}
      key={value}
      className="input"
      readOnly={readOnly}
      defaultValue={value}
      onBlur={(event) => {
        const next = toKey(event.target.value)
        if (next === value) return
        if (!KEY_PATTERN.test(next) || taken.includes(next)) {
          event.target.value = value
          return
        }
        onRename(next)
      }}
    />
  )
}

export function FlagsTab({ definition, edit, readOnly, focus }: TabProps & { focus?: number }) {
  const keys = definition.statusFlags.map((flag) => flag.key)
  const set = (index: number, next: PipelineStatusFlag) =>
    edit((current) => ({ ...current, statusFlags: replaceAt(current.statusFlags, index, next) }))

  return (
    <div className="stack">
      <section className="card card-body">
        <h2 className="section-title" style={{ marginTop: 0 }}>Added on submission</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>The flags a file gains the moment it is submitted.</p>
        {definition.statusFlags.length === 0 ? (
          <p className="field-hint">Declare a flag below first.</p>
        ) : (
          <div className={styles.chips}>
            {definition.statusFlags.map((flag) => {
              const held = definition.onSubmit.addFlags.includes(flag.key)
              return (
                <button key={flag.key} type="button" className={styles.chipToggle} aria-pressed={held}
                  disabled={readOnly}
                  onClick={() => edit((current) => ({
                    ...current,
                    onSubmit: {
                      addFlags: held
                        ? current.onSubmit.addFlags.filter((key) => key !== flag.key)
                        : [...current.onSubmit.addFlags, flag.key],
                    },
                  }))}>
                  {flag.label || flag.key}
                </button>
              )
            })}
          </div>
        )}
      </section>

      {definition.statusFlags.map((flag, index) => {
        const id = `flag-${index}`
        return (
          <section key={id} className="card card-body" id={id} data-focused={focus === index ? 'true' : undefined}
            style={focus === index ? { borderColor: 'var(--danger)' } : undefined}>
            <div className={styles.itemHeader}>
              <span className={styles.itemTitle}>
                {flag.label || 'Untitled flag'}
                {flag.terminal ? <span className="badge" data-tone="action">Ends the journey</span> : null}
                {flag.applicantEdit === 'REVISION_SCOPED' ? <span className="badge" data-tone="warn">Applicant may edit</span> : null}
              </span>
              {readOnly ? null : (
                <button type="button" className={styles.iconButton} aria-label="Remove this flag"
                  onClick={() => edit((current) => ({ ...current, statusFlags: removeAt(current.statusFlags, index) }))}>
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </div>
            <div className={styles.grid2}>
              <div>
                <label className="field-label" htmlFor={`${id}-label`}>Label, for the office</label>
                <input id={`${id}-label`} className="input" maxLength={60} readOnly={readOnly} value={flag.label}
                  aria-invalid={flag.label.trim() === ''}
                  onChange={(event) => set(index, { ...flag, label: event.target.value })} />
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-key`}>Key</label>
                <KeyField id={`${id}-key`} value={flag.key} taken={keys} readOnly={readOnly}
                  onRename={(next) => edit((current) => renameFlag(current, flag.key, next))} />
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-kind`}>Kind</label>
                <select id={`${id}-kind`} className="select" disabled={readOnly} value={flag.kind}
                  onChange={(event) => set(index, { ...flag, kind: event.target.value as PipelineStatusFlag['kind'] })}>
                  <option value="PROGRESS">Progress — where the file is</option>
                  <option value="OUTCOME">Outcome — a decision, needs stage: decide</option>
                </select>
              </div>
            </div>
            <div className={styles.grid2} style={{ marginTop: '0.75rem' }}>
              <div>
                <label className="field-label" htmlFor={`${id}-applicant`}>Label, for the applicant</label>
                <input id={`${id}-applicant`} className="input" maxLength={60} readOnly={readOnly} value={flag.applicantLabel}
                  aria-invalid={flag.applicantLabel.trim() === ''}
                  onChange={(event) => set(index, { ...flag, applicantLabel: event.target.value })} />
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-explanation`}>Explanation for the applicant</label>
                <input id={`${id}-explanation`} className="input" maxLength={300} readOnly={readOnly} value={flag.explanation ?? ''}
                  onChange={(event) => set(index, { ...flag, explanation: event.target.value || null })} />
              </div>
            </div>
            <div className="stack" style={{ gap: '0.375rem', marginTop: '0.75rem' }}>
              <label className="checkbox-row">
                <input type="checkbox" disabled={readOnly} checked={flag.applicantVisible}
                  onChange={(event) => set(index, { ...flag, applicantVisible: event.target.checked })} />
                <span>The applicant sees this flag</span>
              </label>
              <label className="checkbox-row">
                <input type="checkbox" disabled={readOnly} checked={flag.terminal}
                  onChange={(event) => set(index, { ...flag, terminal: event.target.checked })} />
                <span>Ends the journey — the file leaves every stage. Only “complete” and “close” effects may add it.</span>
              </label>
              <label className="checkbox-row">
                <input type="checkbox" disabled={readOnly} checked={flag.applicantEdit === 'REVISION_SCOPED'}
                  onChange={(event) => set(index, { ...flag, applicantEdit: event.target.checked ? 'REVISION_SCOPED' : 'NONE' })} />
                <span>Lets the applicant correct the sections a revision names. Only “request revision” may add it; resubmitting removes it.</span>
              </label>
            </div>
          </section>
        )
      })}

      {readOnly ? null : (
        <div>
          <button type="button" className="button"
            onClick={() => edit((current) => ({ ...current, statusFlags: [...current.statusFlags, blankFlag(freshKey('NEW_STATUS', keys))] }))}>
            <Plus size={14} aria-hidden /> Add a status flag
          </button>
        </div>
      )}
    </div>
  )
}

export function RecordedValuesTab({ definition, edit, readOnly, focus }: TabProps & { focus?: number }) {
  const keys = definition.recordedValues.map((value) => value.key)
  const set = (index: number, next: PipelineRecordedValue) =>
    edit((current) => ({ ...current, recordedValues: replaceAt(current.recordedValues, index, next) }))

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Named values an action keeps on the application — the grant approved, the loan sanctioned, a bank’s reference.
        Conditions, pre-filled inputs and eligibility rules can read them.
      </p>
      {definition.recordedValues.length === 0 ? <div className="card card-body"><p>None yet.</p></div> : null}
      {definition.recordedValues.map((value, index) => {
        const id = `value-${index}`
        return (
          <section key={id} className="card card-body" style={focus === index ? { borderColor: 'var(--danger)' } : undefined}>
            <div className={styles.itemHeader}>
              <span className={styles.itemTitle}>{value.label || 'Untitled value'}</span>
              {readOnly ? null : (
                <button type="button" className={styles.iconButton} aria-label="Remove this value"
                  onClick={() => edit((current) => ({ ...current, recordedValues: removeAt(current.recordedValues, index) }))}>
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </div>
            <div className={styles.grid2}>
              <div>
                <label className="field-label" htmlFor={`${id}-label`}>Label</label>
                <input id={`${id}-label`} className="input" maxLength={80} readOnly={readOnly} value={value.label}
                  aria-invalid={value.label.trim() === ''}
                  onChange={(event) => set(index, { ...value, label: event.target.value })} />
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-key`}>Key</label>
                <KeyField id={`${id}-key`} value={value.key} taken={keys} readOnly={readOnly}
                  onRename={(next) => edit((current) => renameRecordedValue(current, value.key, next))} />
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-type`}>Type</label>
                <select id={`${id}-type`} className="select" disabled={readOnly} value={value.type}
                  onChange={(event) => set(index, { ...value, type: event.target.value as PipelineRecordedValue['type'] })}>
                  {RECORDED_VALUE_TYPES.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
                </select>
              </div>
            </div>
            <label className="checkbox-row" style={{ marginTop: '0.75rem' }}>
              <input type="checkbox" disabled={readOnly} checked={value.applicantVisible}
                onChange={(event) => set(index, { ...value, applicantVisible: event.target.checked })} />
              <span>The applicant sees this value</span>
            </label>
          </section>
        )
      })}
      {readOnly ? null : (
        <div>
          <button type="button" className="button"
            onClick={() => edit((current) => ({ ...current, recordedValues: [...current.recordedValues, blankRecordedValue(freshKey('NEW_VALUE', keys))] }))}>
            <Plus size={14} aria-hidden /> Add a recorded value
          </button>
        </div>
      )}
    </div>
  )
}
