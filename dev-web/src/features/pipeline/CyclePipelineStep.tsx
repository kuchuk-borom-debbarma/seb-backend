/**
 * What a cycle takes from the workflow catalogue: the pipeline its
 * applications are worked in, the kinds of application it accepts with the
 * rules an enterprise must meet to start each, and the rules its form states
 * about several answers at once.
 *
 * All three are drawn from the catalogue the server publishes, never from a
 * list here, and each rule's parameters use the same controls the pipeline
 * editor uses — so a parameter kind means one thing wherever it is edited.
 *
 * Choosing a pipeline needs `pipeline:read` as well as the cycle's own
 * permission, which the server asks too; without it the picker explains why it
 * is empty instead of offering nothing.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { paiseToRupees, rupeesToPaise } from '#/features/application/money'
import type {
  ApplicationKindInput,
  EligibilityRuleType,
  FormRuleInput,
  FormRuleType,
  FormTemplateInput,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import { can, useCurrentUser } from '#/lib/session'
import { definitionFromJson, freshKey, KEY_PATTERN, toKey } from './definition'
import { moveAt, removeAt, replaceAt } from './editorState'
import { flagNames, recordedValueNames } from './names'
import { ParamFields, type Named } from './paramControls'
import {
  pipelineCatalogueQuery,
  pipelineChoicesQuery,
  pipelineQuery,
  pipelinesQuery as pipelinesListQuery,
} from './pipelineQueries'
import styles from './Pipeline.module.css'

const parsedParams = (json: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/* ---- The pipeline, and the kinds of application ------------------------- */

export function CyclePipelineStep({
  pipelineId,
  onPipelineChange,
  kinds,
  onKindsChange,
}: {
  pipelineId: string
  onPipelineChange: (pipelineId: string) => void
  kinds: ApplicationKindInput[]
  onKindsChange: (kinds: ApplicationKindInput[]) => void
}) {
  const user = useCurrentUser()
  const mayRead = can(user, 'pipeline', 'read')
  const choices = useQuery({ ...pipelineChoicesQuery, enabled: mayRead })
  const catalogue = useQuery({ ...pipelineCatalogueQuery, enabled: mayRead })
  const listed = choices.data?.response ?? []
  const chosen = listed.find((pipeline) => pipeline.id === pipelineId)
  // The chosen pipeline's flags and values, as suggestions for the rules below.
  const chosenDetail = useQuery({ ...pipelineQuery(chosen?.key ?? ''), enabled: mayRead && Boolean(chosen) })
  const publishedJson = chosenDetail.data?.response?.published?.definitionJson
  const chosenDefinition = publishedJson ? definitionFromJson(publishedJson) : null

  const kindNames: Named[] = kinds.map((kind) => ({ key: kind.kindKey, label: kind.label || kind.kindKey }))
  const pipelineNames: Named[] = listed.map((pipeline) => ({ key: pipeline.key, label: pipeline.name }))
  const rulesCatalogue = catalogue.data?.response?.eligibilityRules ?? []
  const setKind = (index: number, next: ApplicationKindInput) => onKindsChange(replaceAt(kinds, index, next))

  return (
    <div className="stack">
      <section>
        <h3 className={styles.subsectionTitle}>Pipeline</h3>
        <p className="field-hint" style={{ marginTop: 0 }}>
          The route this cycle’s applications take after submission. Its current published version is pinned when the
          cycle opens, and every application keeps it.
        </p>
        {!mayRead ? (
          <p className="field-error">
            Choosing a pipeline needs the authority to read pipelines, which you do not hold. The current choice is kept.
          </p>
        ) : choices.data && !choices.data.success ? (
          <p className="field-error">{choices.data.message}</p>
        ) : (
          <>
            <label className="visually-hidden" htmlFor="cyclePipeline">Pipeline</label>
            <select id="cyclePipeline" className="select" value={pipelineId}
              aria-invalid={pipelineId === '' || (listed.length > 0 && !chosen)}
              onChange={(event) => onPipelineChange(event.target.value)}>
              <option value="">Choose a published pipeline…</option>
              {pipelineId !== '' && !chosen && choices.data ? (
                <option value={pipelineId}>The current choice is retired or unpublished</option>
              ) : null}
              {listed.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name} ({pipeline.key}) — version {pipeline.currentPublishedVersion}
                </option>
              ))}
            </select>
            {choices.data?.success && listed.length === 0 ? (
              <p className="field-hint">
                No pipeline has been published yet.{' '}
                <Link to="/admin/pipelines">Author one on the Pipelines screen</Link>; a cycle cannot open without one.
              </p>
            ) : null}
            {chosen ? (
              <p className="field-hint">
                {chosen.description}{' '}
                <Link to="/admin/pipelines/$key" params={{ key: chosen.key }}>Open the pipeline</Link>
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className={styles.subsection}>
        <h3 className={styles.subsectionTitle}>Kinds of application</h3>
        <p className="field-hint" style={{ marginTop: 0 }}>
          What an applicant may start under this cycle, in the order offered. Every rule of a kind must hold for an
          enterprise to start one — an expansion is whatever its rules say it is.
        </p>
        <div className="stack" style={{ gap: '0.75rem' }}>
          {kinds.length === 0 ? <p className="field-error">A cycle needs at least one kind of application to open.</p> : null}
          {kinds.map((kind, index) => {
            const id = `kind-${index}`
            return (
              <div key={id} className={styles.item}>
                <div className={styles.itemHeader}>
                  <span className={styles.itemTitle}>{kind.label || 'Untitled kind'} <code className={styles.listKey}>{kind.kindKey}</code></span>
                  <span className="row" style={{ gap: '0.25rem' }}>
                    <button type="button" className={styles.iconButton} aria-label="Move up" disabled={index === 0}
                      onClick={() => onKindsChange(moveAt(kinds, index, -1))}><ArrowUp size={14} aria-hidden /></button>
                    <button type="button" className={styles.iconButton} aria-label="Move down" disabled={index === kinds.length - 1}
                      onClick={() => onKindsChange(moveAt(kinds, index, 1))}><ArrowDown size={14} aria-hidden /></button>
                    <button type="button" className={styles.iconButton} aria-label="Remove this kind"
                      onClick={() => onKindsChange(removeAt(kinds, index))}><Trash2 size={14} aria-hidden /></button>
                  </span>
                </div>
                <div className={styles.grid2}>
                  <div>
                    <label className="field-label" htmlFor={`${id}-label`}>Offered as</label>
                    <input id={`${id}-label`} className="input" value={kind.label} aria-invalid={kind.label.trim() === ''}
                      onChange={(event) => setKind(index, { ...kind, label: event.target.value })} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor={`${id}-key`}>Key</label>
                    <input id={`${id}-key`} className="input" value={kind.kindKey}
                      aria-invalid={!KEY_PATTERN.test(kind.kindKey) || kinds.some((other, at) => at !== index && other.kindKey === kind.kindKey)}
                      onChange={(event) => setKind(index, { ...kind, kindKey: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/gu, '') })} />
                  </div>
                </div>
                <div style={{ marginTop: '0.75rem' }}>
                  <label className="field-label" htmlFor={`${id}-description`}>Description</label>
                  <input id={`${id}-description`} className="input" value={kind.description ?? ''}
                    onChange={(event) => setKind(index, { ...kind, description: event.target.value || null })} />
                </div>

                <div style={{ marginTop: '0.75rem' }}>
                  <span className="field-label">Who may start one</span>
                  {kind.rules.length === 0 ? <p className="field-hint">Anybody with an enterprise.</p> : null}
                  <div className="stack" style={{ gap: '0.5rem' }}>
                    {kind.rules.map((rule, ruleIndex) => {
                      const entry = rulesCatalogue.find((each) => each.key === rule.ruleType)
                      const ruleId = `${id}-rule-${ruleIndex}`
                      return (
                        <div key={ruleId} className={styles.item} style={{ background: 'var(--surface)' }}>
                          <div className={styles.itemHeader}>
                            <span className={styles.itemTitle}>{humanize(rule.ruleType)}</span>
                            <button type="button" className={styles.iconButton} aria-label="Remove this rule"
                              onClick={() => setKind(index, { ...kind, rules: removeAt(kind.rules, ruleIndex) })}>
                              <Trash2 size={14} aria-hidden />
                            </button>
                          </div>
                          {entry ? (
                            <>
                              <p className="field-hint" style={{ marginTop: 0 }}>{entry.description}</p>
                              <ParamFields
                                idPrefix={ruleId}
                                params={entry.params}
                                values={parsedParams(rule.paramsJson)}
                                onChange={(params) => setKind(index, {
                                  ...kind,
                                  rules: replaceAt(kind.rules, ruleIndex, { ...rule, paramsJson: JSON.stringify(params) }),
                                })}
                                context={{
                                  readOnly: false,
                                  stages: [],
                                  flags: chosenDefinition ? flagNames(chosenDefinition) : [],
                                  inputs: [],
                                  recordedValues: chosenDefinition ? recordedValueNames(chosenDefinition) : [],
                                  answers: [],
                                  kinds: kindNames,
                                  pipelines: pipelineNames,
                                  openKeys: true,
                                }}
                              />
                            </>
                          ) : (
                            <p className="field-hint">Parameters: <code>{rule.paramsJson}</code></p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {rulesCatalogue.length > 0 ? (
                    <select className="select" style={{ maxWidth: '22rem', marginTop: '0.5rem' }} value="" aria-label="Add an eligibility rule"
                      onChange={(event) => {
                        const ruleType = event.target.value as EligibilityRuleType
                        if (ruleType) setKind(index, { ...kind, rules: [...kind.rules, { ruleType, paramsJson: '{}' }] })
                      }}>
                      <option value="">+ Add a rule…</option>
                      {rulesCatalogue.map((each) => <option key={each.key} value={each.key}>{humanize(each.key)}</option>)}
                    </select>
                  ) : null}
                </div>
              </div>
            )
          })}
          <div>
            <button type="button" className="button" data-variant="ghost"
              onClick={() => {
                const kindKey = freshKey('NEW_KIND', kinds.map((kind) => kind.kindKey))
                onKindsChange([...kinds, { kindKey, label: humanize(kindKey), description: null, rules: [] }])
              }}>
              <Plus size={14} aria-hidden /> Add a kind of application
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

/* ---- The form's rules about several answers ----------------------------- */

export function CycleFormRulesStep({
  template,
  onChange,
}: {
  template: FormTemplateInput
  onChange: (rules: FormRuleInput[]) => void
}) {
  const user = useCurrentUser()
  const catalogue = useQuery({ ...pipelineCatalogueQuery, enabled: can(user, 'pipeline', 'read') })
  const entries = catalogue.data?.response?.formRules ?? []
  const rules = template.rules ?? []
  const set = (index: number, next: FormRuleInput) => onChange(replaceAt(rules, index, next))
  // Only a top-level question has one answer a rule can read.
  const questions = template.fields.filter((field) => !field.parentFieldKey)

  return (
    <div className="stack" style={{ gap: '0.75rem' }}>
      <p className="field-hint" style={{ margin: 0 }}>
        Rules about several answers at once — “a grant, a loan, or both”, “two different banks”. Each is checked over the
        questions the applicant was actually asked, as they type and again on submission.
      </p>
      {catalogue.data && !catalogue.data.success ? <p className="field-error">{catalogue.data.message}</p> : null}
      {rules.length === 0 ? <p className="field-hint">No rules: every answer is judged on its own.</p> : null}
      {rules.map((rule, index) => {
        const entry = entries.find((each) => each.key === rule.ruleType)
        const eligible = questions.filter((field) => !entry || entry.operandTypes.includes(field.fieldType))
        const operandKeys = rule.operands.map((operand) => operand.fieldKey)
        const id = `formRule-${index}`
        // A limit over amounts is typed in rupees and kept in paise, like every amount.
        const inMoney = rule.operands.length > 0 && rule.operands.every((operand) => operand.fieldType === 'MONEY_PAISE')
        const operandsInvalid = entry
          ? rule.operands.length < entry.minOperands || rule.operands.length > entry.maxOperands
          : false
        return (
          <div key={id} className={styles.item}>
            <div className={styles.itemHeader}>
              <span className={styles.itemTitle}>{humanize(rule.ruleType)} <code className={styles.listKey}>{rule.ruleKey}</code></span>
              <button type="button" className={styles.iconButton} aria-label="Remove this rule" onClick={() => onChange(removeAt(rules, index))}>
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
            {entry ? <p className="field-hint" style={{ marginTop: 0 }}>{entry.description}</p> : null}
            <div className={styles.grid2}>
              <div>
                <label className="field-label" htmlFor={`${id}-key`}>Key</label>
                <input id={`${id}-key`} className="input" value={rule.ruleKey} aria-invalid={!KEY_PATTERN.test(rule.ruleKey)}
                  onChange={(event) => set(index, { ...rule, ruleKey: toKey(event.target.value) || event.target.value.toUpperCase() })} />
              </div>
              <div>
                <label className="field-label" htmlFor={`${id}-stage`}>Shown on the stage</label>
                <select id={`${id}-stage`} className="select" value={rule.stageKey} aria-invalid={!template.stages.some((stage) => stage.stageKey === rule.stageKey)}
                  onChange={(event) => set(index, { ...rule, stageKey: event.target.value })}>
                  <option value="">Choose a stage…</option>
                  {template.stages.map((stage) => <option key={stage.stageKey} value={stage.stageKey}>{stage.title}</option>)}
                </select>
              </div>
              {entry?.limit === 'REQUIRED' ? (
                <div>
                  <label className="field-label" htmlFor={`${id}-limit`}>Limit{inMoney ? ', in rupees' : ''}</label>
                  {inMoney ? (
                    <input id={`${id}-limit`} key={`limit-${rule.limitValue}`} className="input tabular" inputMode="decimal"
                      defaultValue={paiseToRupees(rule.limitValue === null || rule.limitValue === undefined ? null : Number(rule.limitValue))}
                      aria-invalid={!rule.limitValue}
                      onBlur={(event) => {
                        const paise = rupeesToPaise(event.target.value)
                        if (paise === undefined || (paise !== null && paise < 0)) return
                        set(index, { ...rule, limitValue: paise === null ? null : String(paise) })
                      }} />
                  ) : (
                    <input id={`${id}-limit`} className="input tabular" type="number" min={0} value={rule.limitValue ?? ''}
                      aria-invalid={!rule.limitValue}
                      onChange={(event) => set(index, { ...rule, limitValue: event.target.value === '' ? null : String(Math.max(0, Math.trunc(Number(event.target.value)))) })} />
                  )}
                </div>
              ) : null}
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <label className="field-label" htmlFor={`${id}-message`}>What the applicant is told when it does not hold</label>
              <input id={`${id}-message`} className="input" maxLength={300} value={rule.message} aria-invalid={rule.message.trim() === ''}
                onChange={(event) => set(index, { ...rule, message: event.target.value })} />
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <span className="field-label">
                Questions it reads{entry ? ` (${entry.minOperands === entry.maxOperands ? entry.minOperands : `${entry.minOperands}–${entry.maxOperands}`})` : ''}
              </span>
              {rule.ruleType === 'AT_MOST_FIELD' ? (
                <p className="field-hint" style={{ marginTop: 0 }}>In order: the first may not be more than the second.</p>
              ) : null}
              <div className="stack" style={{ gap: '0.375rem' }}>
                {rule.operands.map((operand, operandIndex) => (
                  <div key={`${id}-operand-${operandIndex}`} className="row" style={{ gap: '0.5rem' }}>
                    <span className="tabular muted">{operandIndex + 1}.</span>
                    <span style={{ flex: 1 }}>
                      {questions.find((field) => field.fieldKey === operand.fieldKey)?.label ?? `${operand.fieldKey} (not on this form)`}
                    </span>
                    <button type="button" className={styles.iconButton} aria-label="Move up" disabled={operandIndex === 0}
                      onClick={() => set(index, { ...rule, operands: moveAt(rule.operands, operandIndex, -1) })}><ArrowUp size={14} aria-hidden /></button>
                    <button type="button" className={styles.iconButton} aria-label="Remove this question"
                      onClick={() => set(index, { ...rule, operands: removeAt(rule.operands, operandIndex) })}><Trash2 size={14} aria-hidden /></button>
                  </div>
                ))}
                {operandsInvalid ? <p className="field-error">This rule reads between {entry!.minOperands} and {entry!.maxOperands} questions.</p> : null}
                <select className="select" style={{ maxWidth: '26rem' }} value="" aria-label="Add a question to this rule"
                  onChange={(event) => {
                    const field = eligible.find((each) => each.fieldKey === event.target.value)
                    if (field) set(index, { ...rule, operands: [...rule.operands, { fieldKey: field.fieldKey, fieldType: field.fieldType }] })
                  }}>
                  <option value="">+ Add a question…</option>
                  {eligible.filter((field) => !operandKeys.includes(field.fieldKey)).map((field) => (
                    <option key={field.fieldKey} value={field.fieldKey}>{field.label} ({humanize(field.fieldType)})</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )
      })}
      {entries.length > 0 ? (
        <select className="select" style={{ maxWidth: '22rem' }} value="" aria-label="Add a form rule"
          onChange={(event) => {
            const ruleType = event.target.value as FormRuleType
            if (!ruleType) return
            onChange([
              ...rules,
              {
                ruleKey: freshKey(ruleType, rules.map((rule) => rule.ruleKey)),
                ruleType,
                stageKey: template.stages[0]?.stageKey ?? '',
                message: '',
                limitValue: null,
                operands: [],
              },
            ])
          }}>
          <option value="">+ Add a rule…</option>
          {entries.map((entry) => <option key={entry.key} value={entry.key}>{humanize(entry.key)}</option>)}
        </select>
      ) : null}
    </div>
  )
}

/* ---- How a cycle's page reads them -------------------------------------- */

/**
 * The pipeline a cycle names, its pinned version once open, and the kinds it
 * accepts — named rather than shown as ids. The pipeline's name is looked up
 * only for somebody who may read pipelines; anybody else sees the id, which
 * is all the cycle itself carries.
 */
export function CyclePipelineSummary({
  pipelineId,
  pinnedVersion,
  kinds,
  formRuleCount,
}: {
  pipelineId: string
  pinnedVersion: number | null
  kinds: readonly { kindKey: string; label: string; rules: readonly unknown[] }[]
  formRuleCount: number
}) {
  const user = useCurrentUser()
  const mayRead = can(user, 'pipeline', 'read')
  const pipelines = useQuery({ ...pipelinesListQuery, enabled: mayRead })
  const pipeline = pipelines.data?.response?.find((each) => each.id === pipelineId)
  return (
    <div className="stack" style={{ gap: '0.25rem' }}>
      <span>
        {pipeline ? (
          <Link to="/admin/pipelines/$key" params={{ key: pipeline.key }}>{pipeline.name}</Link>
        ) : (
          <code>{pipelineId || 'No pipeline chosen'}</code>
        )}
        {pinnedVersion !== null ? ` · pinned at version ${pinnedVersion}` : ' · pinned when the cycle opens'}
      </span>
      <span className="muted">
        {kinds.length === 0
          ? 'No kind of application yet'
          : kinds.map((kind) => `${kind.label} (${kind.rules.length === 0 ? 'open to all' : `${kind.rules.length} ${kind.rules.length === 1 ? 'rule' : 'rules'}`})`).join(' · ')}
      </span>
      <span className="muted">
        {formRuleCount === 0 ? 'No rules across answers' : `${formRuleCount} ${formRuleCount === 1 ? 'rule' : 'rules'} across answers`}
      </span>
    </div>
  )
}
