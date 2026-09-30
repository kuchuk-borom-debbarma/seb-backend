/**
 * What an action does, as a list of effects from the catalogue.
 *
 * An author combines effects; they cannot invent one. Each effect shows what
 * it does and the permission an officer needs for it, because that permission
 * comes from the effect and not from the action's name — an approval cannot be
 * made cheaper by calling it something else, and the author should see why a
 * role cannot take the action they built.
 */
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import type { PipelineEffectType } from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import { ConditionsEditor, type ConditionScope } from './ConditionsEditor'
import type { PipelineEffect } from './definition'
import { moveAt, removeAt, replaceAt } from './editorState'
import { ParamFields, type ParamContext } from './paramControls'
import type { CatalogueEffect } from './pipelineQueries'
import styles from './Pipeline.module.css'
import { isOrdinaryFlag } from './definition'

/** How an effect's permission reads: `stage:decide` → "Stage: decide". */
const permissionWords = (entry: CatalogueEffect): string => {
  if (entry.permission === null) return 'Needs no permission of its own.'
  if (entry.permission === 'BY_FLAG_KIND') return 'Needs stage: decide for an outcome flag, stage: advance for a progress flag.'
  const [resource, action] = entry.permission.split(':')
  return `Needs ${humanize(resource ?? '')}: ${humanize(action ?? '').toLowerCase()}.`
}

type FlagTraits = { key: string; terminal: boolean; applicantEdit: string }

/**
 * Which flags an effect's flag parameter may name — the rules the server
 * enforces, applied where the author chooses, so the list offers no refusal.
 * An ending names an ending flag; a revision names a flag that hands the
 * applicant the pen; adding or removing a status names an ordinary one.
 */
const flagFits = (effectType: string, flag: FlagTraits): boolean => {
  if (effectType === 'COMPLETE_PIPELINE' || effectType === 'CLOSE_APPLICATION') return flag.terminal
  if (effectType === 'REQUEST_REVISION') return flag.applicantEdit === 'REVISION_SCOPED'
  if (effectType === 'ADD_STATUS' || effectType === 'REMOVE_STATUS') return isOrdinaryFlag(flag)
  return true
}

export function EffectsEditor({
  idPrefix,
  effects,
  onChange,
  catalogue,
  paramContext,
  statusFlags,
  scope,
}: {
  idPrefix: string
  effects: PipelineEffect[]
  onChange: (effects: PipelineEffect[]) => void
  catalogue: readonly CatalogueEffect[]
  paramContext: Omit<ParamContext, 'siblings'>
  /** The pipeline's flags with the traits that decide which effect may name each. */
  statusFlags: readonly FlagTraits[]
  scope: ConditionScope
}) {
  const { readOnly } = scope
  const entryOf = (type: string) => catalogue.find((entry) => entry.key === type)
  const set = (index: number, next: PipelineEffect) => onChange(replaceAt(effects, index, next))
  const groups = [...new Set(catalogue.map((entry) => entry.group))]
  const moves = effects.filter((effect) => entryOf(effect.type)?.exclusive === 'STAGE').length

  return (
    <div className="stack" style={{ gap: '0.75rem' }}>
      {effects.length === 0 ? <p className="field-error">An action must do at least one thing.</p> : null}
      {moves > 1 ? <p className="field-error">An action can move the application to one place at most.</p> : null}
      {effects.map((effect, index) => {
        const id = `${idPrefix}-${index}`
        const entry = entryOf(effect.type)
        return (
          <div key={id} className={styles.item}>
            <div className={styles.itemHeader}>
              <span className={styles.itemTitle}>
                {index + 1}. {humanize(effect.type)}
                {entry?.terminal ? <span className="badge" data-tone="action">Ends the journey</span> : null}
              </span>
              {readOnly ? null : (
                <span className="row" style={{ gap: '0.25rem' }}>
                  <button type="button" className={styles.iconButton} aria-label="Move up" disabled={index === 0} onClick={() => onChange(moveAt(effects, index, -1))}>
                    <ArrowUp size={14} aria-hidden />
                  </button>
                  <button type="button" className={styles.iconButton} aria-label="Move down" disabled={index === effects.length - 1} onClick={() => onChange(moveAt(effects, index, 1))}>
                    <ArrowDown size={14} aria-hidden />
                  </button>
                  <button type="button" className={styles.iconButton} aria-label="Remove this effect" onClick={() => onChange(removeAt(effects, index))}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </span>
              )}
            </div>
            {entry ? (
              <>
                <p className="field-hint" style={{ marginTop: 0 }}>{entry.description}</p>
                <p className={styles.effectPermission}>{permissionWords(entry)}</p>
                <ParamFields
                  idPrefix={id}
                  params={entry.params}
                  values={effect.params}
                  onChange={(params) => set(index, { ...effect, params })}
                  context={{
                    ...paramContext,
                    // The chosen flag stays listed even if it no longer fits,
                    // so the author sees what is set and can change it.
                    flags: paramContext.flags.filter((named) => {
                      const flag = statusFlags.find((each) => each.key === named.key)
                      return !flag || flagFits(effect.type, flag) || effect.params.flag === named.key
                    }),
                  }}
                />
              </>
            ) : (
              <p className="field-error">This build does not know the effect {effect.type}; remove it.</p>
            )}
            <details style={{ marginTop: '0.75rem' }} open={effect.when.length > 0}>
              <summary className="field-label" style={{ cursor: 'pointer' }}>
                Only when… {effect.when.length > 0 ? `(${effect.when.length})` : ''}
              </summary>
              <ConditionsEditor
                idPrefix={`${id}-when`}
                conditions={effect.when}
                onChange={(when) => set(index, { ...effect, when })}
                scope={scope}
                allowInputs
                empty="Always applies when the action is taken."
              />
            </details>
          </div>
        )
      })}
      {readOnly ? null : (
        <div>
          <label className="visually-hidden" htmlFor={`${idPrefix}-add`}>Add an effect</label>
          <select
            id={`${idPrefix}-add`}
            className="select"
            style={{ maxWidth: '22rem' }}
            value=""
            onChange={(event) => {
              const type = event.target.value as PipelineEffectType
              if (type) onChange([...effects, { type, params: {}, when: [] }])
            }}
          >
            <option value="">+ Add an effect…</option>
            {groups.map((group) => (
              <optgroup key={group} label={humanize(group)}>
                {catalogue.filter((entry) => entry.group === group).map((entry) => (
                  <option key={entry.key} value={entry.key}>{humanize(entry.key)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
