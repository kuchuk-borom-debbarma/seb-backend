/**
 * One editor control per parameter kind the workflow catalogue declares.
 *
 * An effect's or an eligibility rule's parameters are described by the
 * catalogue — a name, a kind and whether it is required — so the editor never
 * hard-codes a form per effect. It draws each parameter with the control
 * registered here for its kind, and a new effect built from existing kinds
 * needs no client change at all.
 *
 * Each control is registered with `defineParamControl('KIND', …)`, and the
 * registry is typed against the API's `PipelineParamKind` enum.
 * `check:workflow-catalog` fails the build when a kind in
 * `src/services/catalogue/workflow.json` has no control here, or when a control
 * exists for a kind the catalogue does not declare.
 *
 * Controls offer what the document already names — its stages, flags, inputs,
 * recorded values — rather than free text, so a reference the author picks is
 * one that exists. A stored value naming something since removed is still
 * shown, marked missing, instead of being silently replaced by the first
 * option: the author should see what the draft says before they change it.
 */
import type { ReactNode } from 'react'
import { paiseToRupees, rupeesToPaise } from '#/features/application/money'
import type { PipelineParamKind } from '#/graphql/generated/schema'
import type { CatalogueParam } from './pipelineQueries'

/** Something a key parameter may name: its key, and how it reads. */
export type Named = { key: string; label: string }

/** A choice input of the action, for routing by its options. */
export type NamedInput = Named & { type: string; options: { value: string; label: string }[] }

/** What a control may offer: the parts of the document and cycle in scope. */
export type ParamContext = {
  readOnly: boolean
  stages: readonly Named[]
  flags: readonly Named[]
  /** The inputs of the action being edited; empty outside an action. */
  inputs: readonly NamedInput[]
  recordedValues: readonly Named[]
  /** Questions a pipeline may read — suggestions, since the form is the cycle's. */
  answers: readonly Named[]
  /** The cycle's kinds of application; empty outside a cycle. */
  kinds: readonly Named[]
  pipelines: readonly Named[]
  /**
   * True outside a pipeline document — an eligibility rule on a cycle — where
   * a flag or a recorded value may belong to any pipeline an earlier
   * application went through. Their controls then take a typed key, with the
   * chosen pipeline's names as suggestions.
   */
  openKeys: boolean
  /** The other parameters of the same effect or rule, for controls that depend on one. */
  siblings: Readonly<Record<string, unknown>>
}

export type ParamControlProps = {
  id: string
  param: CatalogueParam
  value: unknown
  /** `undefined` removes an optional parameter rather than storing an empty one. */
  onChange: (value: unknown) => void
  context: ParamContext
}

type ParamControl = {
  readonly kind: PipelineParamKind
  readonly render: (props: ParamControlProps) => ReactNode
}

/** Registers a control. The key is the marker `check:workflow-catalog` matches. */
const defineParamControl = (
  kind: PipelineParamKind,
  render: ParamControl['render'],
): ParamControl => ({ kind, render })

/** A select over things the document names, keeping a stored value that no longer exists. */
function KeySelect({
  id,
  value,
  onChange,
  options,
  required,
  readOnly,
  none = 'Choose…',
}: {
  id: string
  value: unknown
  onChange: (value: unknown) => void
  options: readonly Named[]
  required: boolean
  readOnly: boolean
  none?: string
}) {
  const current = typeof value === 'string' ? value : ''
  const missing = current !== '' && !options.some((option) => option.key === current)
  return (
    <select
      id={id}
      className="select"
      value={current}
      disabled={readOnly}
      aria-invalid={missing || (required && current === '')}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    >
      <option value="">{required ? none : 'None'}</option>
      {missing ? <option value={current}>{current} (does not exist)</option> : null}
      {options.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label} ({option.key})
        </option>
      ))}
    </select>
  )
}

/** A free key with suggestions, for things the pipeline cannot enumerate. */
function SuggestedKey({ id, value, onChange, suggestions, readOnly }: {
  id: string
  value: unknown
  onChange: (value: unknown) => void
  suggestions: readonly Named[]
  readOnly: boolean
}) {
  const listId = `${id}-suggestions`
  return (
    <>
      <input
        id={id}
        className="input"
        list={listId}
        value={typeof value === 'string' ? value : ''}
        readOnly={readOnly}
        placeholder="KEY"
        onChange={(event) => {
          const next = event.target.value.toUpperCase()
          onChange(next === '' ? undefined : next)
        }}
      />
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion.key} value={suggestion.key}>{suggestion.label}</option>
        ))}
      </datalist>
    </>
  )
}

const wholeNumber = (text: string): number | undefined => {
  if (text.trim() === '') return undefined
  const parsed = Number(text)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

export const paramControls = {
  STAGE_KEY: defineParamControl('STAGE_KEY', ({ id, param, value, onChange, context }) => (
    <KeySelect id={id} value={value} onChange={onChange} options={context.stages} required={param.required} readOnly={context.readOnly} none="Choose a stage…" />
  )),
  STATUS_FLAG_KEY: defineParamControl('STATUS_FLAG_KEY', ({ id, param, value, onChange, context }) =>
    context.openKeys ? (
      <SuggestedKey id={id} value={value} onChange={onChange} suggestions={context.flags} readOnly={context.readOnly} />
    ) : (
      <KeySelect id={id} value={value} onChange={onChange} options={context.flags} required={param.required} readOnly={context.readOnly} none="Choose a status…" />
    ),
  ),
  INPUT_KEY: defineParamControl('INPUT_KEY', ({ id, param, value, onChange, context }) => (
    <KeySelect id={id} value={value} onChange={onChange} options={context.inputs} required={param.required} readOnly={context.readOnly} none="Choose one of this action’s inputs…" />
  )),
  ANSWER_KEY: defineParamControl('ANSWER_KEY', ({ id, value, onChange, context }) => (
    <SuggestedKey id={id} value={value} onChange={onChange} suggestions={context.answers} readOnly={context.readOnly} />
  )),
  RECORDED_VALUE_KEY: defineParamControl('RECORDED_VALUE_KEY', ({ id, param, value, onChange, context }) =>
    context.openKeys ? (
      <SuggestedKey id={id} value={value} onChange={onChange} suggestions={context.recordedValues} readOnly={context.readOnly} />
    ) : (
      <KeySelect id={id} value={value} onChange={onChange} options={context.recordedValues} required={param.required} readOnly={context.readOnly} none="Choose a recorded value…" />
    ),
  ),
  /*
   * Every option of the chosen input must be routed — the server refuses a
   * route that misses one — so the control lists the options rather than
   * letting the author type pairs.
   */
  CHOICE_ROUTES: defineParamControl('CHOICE_ROUTES', ({ id, value, onChange, context }) => {
    const routes = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {}
    const input = context.inputs.find((each) => each.key === context.siblings.input)
    if (!input) return <p className="field-hint" id={id}>Choose the input first; each of its options is then given a stage.</p>
    if (input.options.length === 0) return <p className="field-hint" id={id}>{input.label} offers no options yet.</p>
    return (
      <div className="stack" id={id} style={{ gap: '0.5rem' }}>
        {input.options.map((option) => (
          <div key={option.value} className="row">
            <span style={{ minWidth: '10rem' }}>{option.label} →</span>
            <KeySelect
              id={`${id}-${option.value}`}
              value={routes[option.value]}
              options={context.stages}
              required
              readOnly={context.readOnly}
              none="Choose a stage…"
              onChange={(stage) => {
                const next = { ...routes }
                if (typeof stage === 'string') next[option.value] = stage
                else delete next[option.value]
                onChange(next)
              }}
            />
          </div>
        ))}
      </div>
    )
  }),
  TEXT: defineParamControl('TEXT', ({ id, value, onChange, context }) => (
    <textarea
      id={id}
      className="textarea"
      maxLength={500}
      readOnly={context.readOnly}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    />
  )),
  BOOLEAN: defineParamControl('BOOLEAN', ({ id, param, value, onChange, context }) => (
    <label className="checkbox-row" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        disabled={context.readOnly}
        checked={value === true}
        // An optional switch left off is absent, which the server reads as off.
        onChange={(event) => onChange(event.target.checked ? true : param.required ? false : undefined)}
      />
      <span>Yes</span>
    </label>
  )),
  COUNT: defineParamControl('COUNT', ({ id, value, onChange, context }) => (
    <input
      id={id}
      className="input tabular"
      type="number"
      min={0}
      step={1}
      readOnly={context.readOnly}
      value={typeof value === 'number' ? String(value) : ''}
      onChange={(event) => onChange(wholeNumber(event.target.value))}
    />
  )),
  /*
   * Rupees typed, paise stored, converted textually by the same helpers the
   * applicant's money answers use. Read on blur rather than per keystroke, so a
   * half-typed "12." is not rounded away; remounted when the stored value
   * changes, so a reload shows what the draft now holds.
   */
  MONEY_PAISE: defineParamControl('MONEY_PAISE', ({ id, value, onChange, context }) => (
    <div className="affix-row">
      <span className="affix" aria-hidden>₹</span>
      <input
        key={String(value)}
        id={id}
        className="input tabular"
        inputMode="decimal"
        readOnly={context.readOnly}
        defaultValue={paiseToRupees(value)}
        onBlur={(event) => {
          const paise = rupeesToPaise(event.target.value)
          if (paise === null) onChange(undefined)
          else if (paise !== undefined && paise >= 0) onChange(paise)
        }}
      />
    </div>
  )),
  APPLICATION_KIND_KEY: defineParamControl('APPLICATION_KIND_KEY', ({ id, param, value, onChange, context }) => (
    <KeySelect id={id} value={value} onChange={onChange} options={context.kinds} required={param.required} readOnly={context.readOnly} none="Choose a kind…" />
  )),
  PIPELINE_KEY: defineParamControl('PIPELINE_KEY', ({ id, param, value, onChange, context }) => (
    <KeySelect id={id} value={value} onChange={onChange} options={context.pipelines} required={param.required} readOnly={context.readOnly} none="Any pipeline" />
  )),
} satisfies Record<PipelineParamKind, ParamControl>

/** A catalogue parameter's name as words: `atMostCycleCeiling` → "At most cycle ceiling". */
const words = (name: string): string => {
  const spaced = name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Every parameter of one effect or rule, each with its control.
 *
 * Parameters are drawn in the catalogue's order with the catalogue's words, so
 * what an author reads here is what the server will check.
 */
export function ParamFields({
  idPrefix,
  params,
  values,
  onChange,
  context,
}: {
  idPrefix: string
  params: readonly CatalogueParam[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  context: Omit<ParamContext, 'siblings'>
}) {
  if (params.length === 0) return <p className="field-hint">Nothing to set.</p>
  return (
    <div className="stack" style={{ gap: '0.75rem' }}>
      {params.map((param) => {
        const id = `${idPrefix}-${param.name}`
        return (
          <div key={param.name}>
            <label className="field-label" htmlFor={id}>
              {words(param.name)}
              {param.required ? null : <span className="muted"> (optional)</span>}
            </label>
            {paramControls[param.kind].render({
              id,
              param,
              value: values[param.name],
              context: { ...context, siblings: values },
              onChange: (next) => {
                const updated = { ...values }
                if (next === undefined) delete updated[param.name]
                else updated[param.name] = next
                onChange(updated)
              },
            })}
            <p className="field-hint">{param.description}</p>
          </div>
        )
      })}
    </div>
  )
}
