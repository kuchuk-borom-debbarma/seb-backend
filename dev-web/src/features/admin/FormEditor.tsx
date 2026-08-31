/**
 * The cycle editor's form-authoring screen.
 *
 * Two panes: a rail of stages (and the structures panel) on the left, the
 * selected stage's questions on the right. Every save is a cycle revision —
 * it quotes the version on screen as `expectedVersion` and carries the one
 * change reason written at the top — and the refused sentence, when there is
 * one, is the server's own, shown verbatim.
 *
 * Drafts only. The route renders a read-only note for anything else, because
 * an open cycle's questions are frozen into the applications filled under it.
 */
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  AddCycleFormQuestionDocument,
  AddCycleFormStageDocument,
  AdminCycleFormEditorDocument,
  PutCycleGroupDefinitionDocument,
  RemoveCycleFormQuestionDocument,
  RemoveCycleFormStageDocument,
  RemoveCycleGroupDefinitionDocument,
  ReplaceCycleFormTemplateDocument,
  UpdateCycleFormQuestionDocument,
  UpdateCycleFormStageDocument,
} from '#/graphql/generated/operations'
import type {
  FormFieldInput,
  FormGroupDefinitionInput,
  FormQuestionConditionInput,
  FormQuestionOptionInput,
  FormTemplateInput,
  FormTemplateScopeInput,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { useMarker } from '#/features/guide/GuideContext'
import { FieldEditor } from './FieldEditor'
import {
  blankDraft,
  draftFromField,
  draftFromMember,
  fieldInputFromDraft,
  isDerivedMember,
  memberInputFromDraft,
  questionConditionsFromDraft,
  questionOptionsFromDraft,
  STALE_MESSAGE,
  structureKeyOf,
  toTemplateInput,
  type AttributeDraft,
  type AuthoringCycle,
  type DefinitionView,
  type FieldView,
  type StageView,
  type TemplateView,
} from './formAuthoring'
import styles from './FormEditor.module.css'

export const formEditorQuery = (id: string) =>
  queryOptions({
    queryKey: ['admin-cycle-form', id],
    queryFn: async () => {
      const data = await gql(AdminCycleFormEditorDocument, { id })
      return unwrap(data.admin.programmeCycle.byId)
    },
    // Every edit quotes the version on screen, so a stale one turns every
    // save into a refusal.
    staleTime: 0,
  })

/** One of the nine template writes, named for the switch below. */
type Action =
  | { kind: 'replace'; template: FormTemplateInput }
  | {
      kind: 'addStage' | 'updateStage'
      stage: {
        stageKey: string
        title: string
        description?: string | null
      }
    }
  | { kind: 'removeStage'; stageKey: string }
  | {
      kind: 'addQuestion' | 'updateQuestion'
      field: FormFieldInput
      options: FormQuestionOptionInput[] | null
      conditions: FormQuestionConditionInput[] | null
    }
  | { kind: 'removeQuestion'; fieldKey: string }
  | { kind: 'putDefinition'; definition: FormGroupDefinitionInput }
  | { kind: 'removeDefinition'; definitionKey: string }

/** The stage editor's working copy; minutes held as text while typed. */
type StageDraft = {
  key: string
  title: string
  description: string
  iconName: string
  estimatedMinutes: string
}

const stageDraftOf = (stage?: StageView): StageDraft => ({
  key: stage?.key ?? '',
  title: stage?.title ?? '',
  description: stage?.description ?? '',
  iconName: stage?.iconName ?? '',
  estimatedMinutes:
    stage?.estimatedMinutes === null || stage === undefined
      ? ''
      : String(stage.estimatedMinutes),
})

type DefinitionDraft = {
  key: string
  label: string
  members: AttributeDraft[]
}

export function FormEditor({
  cycleId,
  cycle,
  template,
}: {
  cycleId: string
  cycle: AuthoringCycle
  template: TemplateView
}) {
  const mark = useMarker()
  const queryClient = useQueryClient()
  const definitions = cycle.groupDefinitions
  const head = cycle.head

  const [reason, setReason] = useState('')
  const [pane, setPane] = useState<string>(template.stages[0]?.key ?? 'structures')

  // At most one thing is edited at a time, so a save's refusal is never
  // ambiguous about which form it refuses.
  const [stageDraft, setStageDraft] = useState<StageDraft | null>(null)
  const [stageIsNew, setStageIsNew] = useState(false)
  const [questionDraft, setQuestionDraft] = useState<AttributeDraft | null>(null)
  const [questionPlace, setQuestionPlace] = useState<{
    existingKey: string | null
    parentFieldKey: string | null
  } | null>(null)
  const [definitionDraft, setDefinitionDraft] = useState<DefinitionDraft | null>(null)
  const [definitionIsNew, setDefinitionIsNew] = useState(false)
  const [openMember, setOpenMember] = useState<number | null>(null)

  const closeEditors = () => {
    setStageDraft(null)
    setStageIsNew(false)
    setQuestionDraft(null)
    setQuestionPlace(null)
    setDefinitionDraft(null)
    setDefinitionIsNew(false)
    setOpenMember(null)
  }

  const save = useMutation({
    mutationFn: async (action: Action) => {
      const scope: FormTemplateScopeInput = {
        programmeCycleId: cycleId,
        expectedVersion: head.currentVersion,
        reason,
      }
      switch (action.kind) {
        case 'replace': {
          const data = await gql(ReplaceCycleFormTemplateDocument, {
            input: { scope, template: action.template },
          })
          return unwrap(data.admin.formTemplate.replace)
        }
        case 'addStage': {
          const data = await gql(AddCycleFormStageDocument, {
            input: { scope, stage: action.stage },
          })
          return unwrap(data.admin.formTemplate.addStage)
        }
        case 'updateStage': {
          const data = await gql(UpdateCycleFormStageDocument, {
            input: { scope, stage: action.stage },
          })
          return unwrap(data.admin.formTemplate.updateStage)
        }
        case 'removeStage': {
          const data = await gql(RemoveCycleFormStageDocument, {
            input: { scope, stageKey: action.stageKey },
          })
          return unwrap(data.admin.formTemplate.removeStage)
        }
        case 'addQuestion': {
          const data = await gql(AddCycleFormQuestionDocument, {
            input: {
              scope,
              field: action.field,
              options: action.options,
              conditions: action.conditions,
            },
          })
          return unwrap(data.admin.formTemplate.addQuestion)
        }
        case 'updateQuestion': {
          const data = await gql(UpdateCycleFormQuestionDocument, {
            input: {
              scope,
              field: action.field,
              options: action.options,
              conditions: action.conditions,
            },
          })
          return unwrap(data.admin.formTemplate.updateQuestion)
        }
        case 'removeQuestion': {
          const data = await gql(RemoveCycleFormQuestionDocument, {
            input: { scope, fieldKey: action.fieldKey },
          })
          return unwrap(data.admin.formTemplate.removeQuestion)
        }
        case 'putDefinition': {
          const data = await gql(PutCycleGroupDefinitionDocument, {
            input: { scope, definition: action.definition },
          })
          return unwrap(data.admin.formTemplate.putGroupDefinition)
        }
        case 'removeDefinition': {
          const data = await gql(RemoveCycleGroupDefinitionDocument, {
            input: { scope, definitionKey: action.definitionKey },
          })
          return unwrap(data.admin.formTemplate.removeGroupDefinition)
        }
      }
    },
    onSuccess: async (aggregate) => {
      // The mutation returns the new head and the re-expanded template, so
      // the cache is updated from the result rather than refetched — the next
      // edit quotes the version this one produced.
      queryClient.setQueryData(formEditorQuery(cycleId).queryKey, aggregate)
      closeEditors()
      await queryClient.invalidateQueries({ queryKey: ['admin-cycle', cycleId] })
      await queryClient.invalidateQueries({ queryKey: ['admin-cycles'] })
    },
  })

  const busy = save.isPending
  const canAct = reason.trim().length > 0 && !busy
  const failure = save.error ? messageFor(save.error) : null

  /*
   * Whether a stage write can go through the dedicated stage mutations.
   *
   * `FormStageEditInput` carries no icon and no time estimate, and an update
   * through it replaces every stored value — so saving a stage that holds
   * either through `updateStage` would silently clear them. Those saves go
   * through `replace`, whose stage input carries the full set.
   */
  const stageNeedsReplace = (draft: StageDraft, existing?: StageView): boolean =>
    draft.iconName.trim() !== '' ||
    draft.estimatedMinutes.trim() !== '' ||
    Boolean(
      existing && (existing.iconName !== null || existing.estimatedMinutes !== null),
    )

  const saveStage = () => {
    if (!stageDraft) return
    const existing = template.stages.find((stage) => stage.key === stageDraft.key)
    const minutes = Number.parseInt(stageDraft.estimatedMinutes, 10)
    const full = {
      stageKey: stageDraft.key.trim(),
      title: stageDraft.title.trim(),
      description: stageDraft.description.trim() || null,
      iconName: stageDraft.iconName.trim() || null,
      estimatedMinutes: Number.isFinite(minutes) ? minutes : null,
    }
    if (stageNeedsReplace(stageDraft, existing)) {
      const current = toTemplateInput(template, definitions)
      const stages = existing
        ? current.stages.map((stage) => (stage.stageKey === full.stageKey ? full : stage))
        : [...current.stages, full]
      save.mutate({ kind: 'replace', template: { ...current, stages } })
      return
    }
    save.mutate({
      kind: stageIsNew && !existing ? 'addStage' : 'updateStage',
      stage: {
        stageKey: full.stageKey,
        title: full.title,
        description: full.description,
      },
    })
  }

  /*
   * Reordering goes through `replace` too: stage order is array order on the
   * write (the read is ordered, so the rebuilt array is faithful), and there
   * is no per-stage number to nudge.
   */
  const moveStage = (key: string, delta: -1 | 1) => {
    const current = toTemplateInput(template, definitions)
    const at = current.stages.findIndex((stage) => stage.stageKey === key)
    const to = at + delta
    if (at < 0 || to < 0 || to >= current.stages.length) return
    const stages = [...current.stages]
    const [moved] = stages.splice(at, 1)
    stages.splice(to, 0, moved!)
    save.mutate({ kind: 'replace', template: { ...current, stages } })
  }

  /*
   * Question order is array order on the write too, so a move must send the
   * whole array back through `replace` — the per-question update pins the
   * stored sortOrder on the server, so it can never renumber a neighbour.
   */
  const moveField = (fieldKey: string, delta: -1 | 1) => {
    const current = toTemplateInput(template, definitions)
    const at = current.fields.findIndex((field) => field.fieldKey === fieldKey)
    if (at < 0) return
    const moved = current.fields[at]!
    // A question only trades places with a sibling — same stage, same parent
    // (null at top level) — and the swap happens at the two absolute indices,
    // so every other stage's and group's order rides through untouched.
    const siblings = current.fields
      .map((field, index) => ({ field, index }))
      .filter(
        ({ field }) =>
          field.stageKey === moved.stageKey &&
          field.parentFieldKey === moved.parentFieldKey,
      )
    const place = siblings.findIndex(({ index }) => index === at)
    const neighbour = siblings[place + delta]
    if (!neighbour) return
    const fields = [...current.fields]
    fields[at] = neighbour.field
    fields[neighbour.index] = moved
    save.mutate({ kind: 'replace', template: { ...current, fields } })
  }

  const saveQuestion = () => {
    if (!questionDraft || !questionPlace) return
    const stageKey = pane === 'structures' ? '' : pane
    const parent = questionPlace.parentFieldKey
    const field = fieldInputFromDraft(questionDraft, {
      stageKey: parent
        ? (template.fields.find((each) => each.key === parent)?.stageKey ?? stageKey)
        : stageKey,
      parentFieldKey: parent,
    })
    save.mutate({
      kind: questionPlace.existingKey ? 'updateQuestion' : 'addQuestion',
      field,
      options: questionOptionsFromDraft(questionDraft),
      conditions: questionConditionsFromDraft(questionDraft, template),
    })
  }

  const saveDefinition = () => {
    if (!definitionDraft) return
    save.mutate({
      kind: 'putDefinition',
      definition: {
        definitionKey: definitionDraft.key.trim(),
        label: definitionDraft.label.trim(),
        members: definitionDraft.members.map(memberInputFromDraft),
      },
    })
  }

  const stage = template.stages.find((each) => each.key === pane) ?? null
  const editorBusyRow = (
    <div className="row">
      <button
        type="button"
        className="button"
        data-variant="primary"
        disabled={!canAct}
        title={canAct ? undefined : 'Write a change reason above first.'}
        onClick={stageDraft ? saveStage : definitionDraft ? saveDefinition : saveQuestion}
      >
        {busy
          ? 'Saving…'
          : stageDraft
            ? 'Save stage'
            : definitionDraft
              ? 'Save structure'
              : 'Save question'}
      </button>
      <button type="button" className="button" onClick={closeEditors} disabled={busy}>
        Cancel
      </button>
      {reason.trim() ? null : (
        <span className="field-hint">Write a change reason above first.</span>
      )}
    </div>
  )

  /*
   * The two bindings a cycle cannot open without, checked live while the
   * form is authored. Discovering them through a refusal at save or open
   * time told the officer which internal key was missing and nothing else;
   * this says it while they are still deciding what to ask. Members carry
   * roles too — an owner's date of birth usually holds the second one.
   */
  const requiredBindings = [
    {
      role: 'SEED_FUND_REQUESTED_PAISE',
      asks: 'how much seed funding is requested',
      reads: 'the queue, the decision bound and analytics',
    },
    {
      role: 'APPLICANT_DATE_OF_BIRTH',
      asks: 'an applicant or owner date of birth',
      reads: 'the age eligibility rule',
    },
  ].map((binding) => ({
    ...binding,
    holder: template.fields.find((field) => field.role === binding.role) ?? null,
  }))
  const unbound = requiredBindings.filter((binding) => binding.holder === null)

  return (
    <div className="stack" {...mark('cycle-authoring')}>
      <p className="notice" data-tone="action">
        <span className="notice-title">This cycle is still a draft</span>
        Its questions can be changed freely here. The moment it opens they freeze — every
        application is judged against the version it was filled under — so to ask
        something different after that, open a new cycle.
      </p>

      <p
        className="notice"
        data-tone={unbound.length > 0 ? 'error' : 'ok'}
        {...mark('required-bindings')}
      >
        <span className="notice-title">
          {unbound.length > 0
            ? 'This form is missing a question the programme requires'
            : 'Every question the programme requires is present'}
        </span>
        {requiredBindings.map((binding) => (
          <span key={binding.role} style={{ display: 'block' }}>
            {binding.holder
              ? `✓ ${binding.holder.label} (${binding.holder.key}) asks ${binding.asks}, `
                + `read by ${binding.reads}.`
              : `✗ No question asks ${binding.asks} — ${binding.reads} cannot read this `
                + `cycle. Add one and set its programme role to ${binding.role}.`}
          </span>
        ))}
      </p>

      <div className="card">
        <div className="card-body">
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 20rem' }}>
              <label className="field-label" htmlFor="form-reason">
                Reason for these changes
              </label>
              <input
                id="form-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Kept on every version these edits create"
              />
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Version <span className="tabular">{head.currentVersion}</span>
            </p>
          </div>
          {failure ? (
            <p
              className="notice"
              data-tone="error"
              role="alert"
              style={{ marginTop: '0.75rem' }}
            >
              {failure}
              {failure === STALE_MESSAGE ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      save.reset()
                      closeEditors()
                      void queryClient.invalidateQueries({
                        queryKey: formEditorQuery(cycleId).queryKey,
                      })
                    }}
                  >
                    Reload the cycle
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>

      <div className={styles.layout}>
        <nav className={styles.rail} aria-label="Form sections">
          {template.stages.map((each) => (
            <button
              key={each.key}
              type="button"
              className={styles.railItem}
              aria-current={pane === each.key}
              onClick={() => {
                closeEditors()
                setPane(each.key)
              }}
            >
              <span>{each.title}</span>
              <span className={styles.railCount}>
                {
                  template.fields.filter(
                    (field) =>
                      field.stageKey === each.key && field.repeatGroupKey === null,
                  ).length
                }
              </span>
            </button>
          ))}
          <button
            type="button"
            className={styles.railItem}
            onClick={() => {
              closeEditors()
              setStageDraft(stageDraftOf())
              setStageIsNew(true)
            }}
          >
            + Add a stage
          </button>
          <button
            type="button"
            className={styles.railItem}
            aria-current={pane === 'structures'}
            onClick={() => {
              closeEditors()
              setPane('structures')
            }}
          >
            <span>Structures</span>
            <span className={styles.railCount}>{definitions.length}</span>
          </button>
        </nav>

        <div className="stack">
          {stageDraft && stageIsNew ? (
            <div className="card">
              <div className="card-header">
                <p className="eyebrow">New stage</p>
              </div>
              <div className="card-body stack">
                <StageForm
                  draft={stageDraft}
                  onChange={setStageDraft}
                  keyLocked={false}
                />
                {editorBusyRow}
              </div>
            </div>
          ) : null}

          {pane === 'structures' ? (
            <StructuresPane
              definitions={definitions}
              template={template}
              canAct={canAct}
              busy={busy}
              draft={definitionDraft}
              draftIsNew={definitionIsNew}
              openMember={openMember}
              setOpenMember={setOpenMember}
              onEdit={(definition) => {
                closeEditors()
                setDefinitionDraft({
                  key: definition.definitionKey,
                  label: definition.label,
                  members: definition.members.map(draftFromMember),
                })
              }}
              onNew={() => {
                closeEditors()
                setDefinitionDraft({ key: '', label: '', members: [] })
                setDefinitionIsNew(true)
              }}
              onChange={setDefinitionDraft}
              onRemove={(definitionKey) =>
                save.mutate({ kind: 'removeDefinition', definitionKey })
              }
              editorRow={editorBusyRow}
            />
          ) : stage ? (
            <StagePane
              stage={stage}
              template={template}
              definitions={definitions}
              canAct={canAct}
              busy={busy}
              stageDraft={stageIsNew ? null : stageDraft}
              onEditStage={() => {
                closeEditors()
                setStageDraft(stageDraftOf(stage))
              }}
              onStageDraftChange={setStageDraft}
              onMoveStage={(delta) => moveStage(stage.key, delta)}
              onMoveQuestion={moveField}
              onRemoveStage={() =>
                save.mutate({ kind: 'removeStage', stageKey: stage.key })
              }
              questionDraft={questionDraft}
              questionPlace={questionPlace}
              onEditQuestion={(field) => {
                closeEditors()
                setQuestionDraft(draftFromField(field, template, definitions))
                setQuestionPlace({
                  existingKey: field.key,
                  parentFieldKey: field.repeatGroupKey,
                })
              }}
              onAddQuestion={(parentFieldKey) => {
                closeEditors()
                setQuestionDraft(blankDraft())
                setQuestionPlace({ existingKey: null, parentFieldKey })
              }}
              onQuestionDraftChange={setQuestionDraft}
              onRemoveQuestion={(fieldKey) =>
                save.mutate({ kind: 'removeQuestion', fieldKey })
              }
              editorRow={editorBusyRow}
            />
          ) : (
            <div className="card">
              <div className="empty">
                <p>Choose a stage on the left, or add the first one.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StageForm({
  draft,
  onChange,
  keyLocked,
}: {
  draft: StageDraft
  onChange: (draft: StageDraft) => void
  keyLocked: boolean
}) {
  const set = <TKey extends keyof StageDraft>(key: TKey, value: StageDraft[TKey]) =>
    onChange({ ...draft, [key]: value })
  return (
    <div className={styles.grid}>
      <div>
        <label className="field-label" htmlFor="stage-key">
          Stage key
        </label>
        <input
          id="stage-key"
          className="input tabular"
          value={draft.key}
          disabled={keyLocked}
          onChange={(event) =>
            set('key', event.target.value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_'))
          }
        />
      </div>
      <div>
        <label className="field-label" htmlFor="stage-title">
          Heading
        </label>
        <input
          id="stage-title"
          className="input"
          value={draft.title}
          onChange={(event) => set('title', event.target.value)}
        />
      </div>
      <div className={styles.wide}>
        <label className="field-label" htmlFor="stage-description">
          Introduction (optional)
        </label>
        <input
          id="stage-description"
          className="input"
          maxLength={500}
          value={draft.description}
          onChange={(event) => set('description', event.target.value)}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="stage-icon">
          Icon
        </label>
        <input
          id="stage-icon"
          className="input tabular"
          maxLength={32}
          placeholder="users"
          value={draft.iconName}
          onChange={(event) => set('iconName', event.target.value.toLowerCase())}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="stage-minutes">
          Estimated minutes (1–120)
        </label>
        <input
          id="stage-minutes"
          className="input tabular"
          type="number"
          min={1}
          max={120}
          value={draft.estimatedMinutes}
          onChange={(event) => set('estimatedMinutes', event.target.value)}
        />
      </div>
    </div>
  )
}

function StagePane({
  stage,
  template,
  definitions,
  canAct,
  busy,
  stageDraft,
  onEditStage,
  onStageDraftChange,
  onMoveStage,
  onMoveQuestion,
  onRemoveStage,
  questionDraft,
  questionPlace,
  onEditQuestion,
  onAddQuestion,
  onQuestionDraftChange,
  onRemoveQuestion,
  editorRow,
}: {
  stage: StageView
  template: TemplateView
  definitions: readonly DefinitionView[]
  canAct: boolean
  busy: boolean
  stageDraft: StageDraft | null
  onEditStage: () => void
  onStageDraftChange: (draft: StageDraft) => void
  onMoveStage: (delta: -1 | 1) => void
  onMoveQuestion: (fieldKey: string, delta: -1 | 1) => void
  onRemoveStage: () => void
  questionDraft: AttributeDraft | null
  questionPlace: { existingKey: string | null; parentFieldKey: string | null } | null
  onEditQuestion: (field: FieldView) => void
  onAddQuestion: (parentFieldKey: string | null) => void
  onQuestionDraftChange: (draft: AttributeDraft) => void
  onRemoveQuestion: (fieldKey: string) => void
  editorRow: React.ReactNode
}) {
  const topLevel = template.fields.filter(
    (field) => field.stageKey === stage.key && field.repeatGroupKey === null,
  )
  const membersOf = (groupKey: string) =>
    template.fields.filter((field) => field.repeatGroupKey === groupKey)

  const editorFor = (field: FieldView | null, parentFieldKey: string | null) =>
    questionDraft &&
    questionPlace &&
    questionPlace.existingKey === (field?.key ?? null) &&
    questionPlace.parentFieldKey === parentFieldKey ? (
      <div className={styles.editor}>
        <FieldEditor
          idPrefix={field ? `edit-${field.key}` : 'new-question'}
          draft={questionDraft}
          onChange={onQuestionDraftChange}
          variant="question"
          keyLocked={Boolean(field)}
          template={template}
          definitions={definitions}
          parentFieldKey={parentFieldKey}
        />
        {editorRow}
      </div>
    ) : null

  const questionRow = (field: FieldView, parentFieldKey: string | null) => {
    const derived = isDerivedMember(field, template, definitions)
    const structureKey = derived
      ? structureKeyOf(field.repeatGroupKey!, template, definitions)
      : null
    const structure = definitions.find((each) => each.definitionKey === structureKey)
    // Where the row sits among its siblings — the questions beside it, not
    // the whole form — so the arrows stop exactly at its list's two ends.
    const siblings = parentFieldKey ? membersOf(parentFieldKey) : topLevel
    const place = siblings.findIndex((each) => each.key === field.key)
    return (
      <div key={field.key}>
        <div
          className={[
            styles.questionRow,
            parentFieldKey ? styles.memberRow : '',
            derived ? styles.derived : '',
          ].join(' ')}
        >
          <span>{field.label}</span>
          <span className={styles.questionKey}>
            {field.key} · {humanize(field.type).toLowerCase()}
          </span>
          {field.role ? (
            /*
             * Said on the row, not discovered through a refusal: the staff
             * screens read this question across every cycle, so the form must
             * always carry a holder for its role.
             */
            <span
              className={styles.roleTag}
              title={
                'Every staff screen reads this question through the role '
                + `${field.role}, across all cycles. It can be edited freely, `
                + 'but the cycle must always carry a question bound to the role.'
              }
            >
              read by the programme as {humanize(field.role).toLowerCase()}
            </span>
          ) : null}
          {derived ? (
            /*
             * No move buttons here either: a derived member's place in its
             * group is the structure definition's order, edited there.
             */
            <span className={styles.derivedTag}>
              from structure {structure?.label ?? structureKey}
            </span>
          ) : (
            <span className={styles.questionActions}>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                aria-label={`Move ${field.label} earlier`}
                disabled={!canAct || place <= 0}
                title={canAct ? undefined : 'Write a change reason above first.'}
                onClick={() => onMoveQuestion(field.key, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                aria-label={`Move ${field.label} later`}
                disabled={!canAct || place === siblings.length - 1}
                title={canAct ? undefined : 'Write a change reason above first.'}
                onClick={() => onMoveQuestion(field.key, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                onClick={() => onEditQuestion(field)}
                disabled={busy}
              >
                Edit
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                disabled={!canAct || field.role !== null}
                title={
                  field.role !== null
                    ? 'The programme reads this question in every cycle — '
                      + 'bind another question to its role before removing it.'
                    : canAct
                      ? undefined
                      : 'Write a change reason above first.'
                }
                onClick={() => onRemoveQuestion(field.key)}
              >
                Remove
              </button>
            </span>
          )}
        </div>
        {editorFor(field, parentFieldKey)}
        {field.type === 'REPEAT_GROUP' ? (
          <>
            {membersOf(field.key).map((member) => questionRow(member, field.key))}
            {structureKeyOf(field.key, template, definitions) === null ? (
              <div className={styles.memberRow} style={{ padding: '0.25rem 0 0.5rem' }}>
                <button
                  type="button"
                  className="button"
                  data-variant="ghost"
                  disabled={busy}
                  onClick={() => onAddQuestion(field.key)}
                >
                  Add a member to {field.label}
                </button>
              </div>
            ) : null}
            {questionPlace?.parentFieldKey === field.key && !questionPlace.existingKey ? (
              <div className={styles.memberRow}>{editorFor(null, field.key)}</div>
            ) : null}
          </>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div className="label-row">
            <p className="eyebrow">{stage.title}</p>
            <span className={styles.questionActions}>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                aria-label={`Move ${stage.title} earlier`}
                disabled={!canAct || stage.position === 1}
                onClick={() => onMoveStage(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                aria-label={`Move ${stage.title} later`}
                disabled={!canAct || stage.position === template.stages.length}
                onClick={() => onMoveStage(1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                onClick={onEditStage}
                disabled={busy}
              >
                Edit stage
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                disabled={!canAct}
                title={canAct ? undefined : 'Write a change reason above first.'}
                onClick={onRemoveStage}
              >
                Remove stage
              </button>
            </span>
          </div>
        </div>
        <div className="card-body stack">
          {stage.description ? <p className="muted">{stage.description}</p> : null}
          {stageDraft && stageDraft.key === stage.key ? (
            <div className={styles.editor}>
              <StageForm draft={stageDraft} onChange={onStageDraftChange} keyLocked />
              {editorRow}
            </div>
          ) : null}

          <div>
            {topLevel.length === 0 ? (
              <p className="muted">This stage asks nothing yet.</p>
            ) : (
              topLevel.map((field) => questionRow(field, null))
            )}
          </div>

          {questionPlace && !questionPlace.existingKey && !questionPlace.parentFieldKey
            ? editorFor(null, null)
            : null}
          <div>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => onAddQuestion(null)}
            >
              Add a question
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function StructuresPane({
  definitions,
  template,
  canAct,
  busy,
  draft,
  draftIsNew,
  openMember,
  setOpenMember,
  onEdit,
  onNew,
  onChange,
  onRemove,
  editorRow,
}: {
  definitions: readonly DefinitionView[]
  template: TemplateView
  canAct: boolean
  busy: boolean
  draft: DefinitionDraft | null
  draftIsNew: boolean
  openMember: number | null
  setOpenMember: (index: number | null) => void
  onEdit: (definition: DefinitionView) => void
  onNew: () => void
  onChange: (draft: DefinitionDraft) => void
  onRemove: (definitionKey: string) => void
  editorRow: React.ReactNode
}) {
  const usersOf = (definitionKey: string) =>
    template.fields
      .filter(
        (field) =>
          field.type === 'REPEAT_GROUP' &&
          structureKeyOf(field.key, template, definitions) === definitionKey,
      )
      .map((field) => field.label)

  /*
   * Order is the draft's array order, and `putGroupDefinition` sends the
   * array — so a move only rewrites the local draft (nothing persists until
   * Save structure), keeping any open editor on the member it was opened for.
   */
  const moveMember = (index: number, delta: -1 | 1) => {
    if (!draft) return
    const to = index + delta
    if (to < 0 || to >= draft.members.length) return
    const members = [...draft.members]
    members[index] = draft.members[to]!
    members[to] = draft.members[index]!
    onChange({ ...draft, members })
    if (openMember === index) setOpenMember(to)
    else if (openMember === to) setOpenMember(index)
  }

  const editor = draft ? (
    <div className={styles.editor}>
      <div className={styles.grid}>
        <div>
          <label className="field-label" htmlFor="structure-key">
            Structure key
          </label>
          <input
            id="structure-key"
            className="input tabular"
            value={draft.key}
            disabled={!draftIsNew}
            onChange={(event) =>
              onChange({
                ...draft,
                key: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_'),
              })
            }
          />
        </div>
        <div>
          <label className="field-label" htmlFor="structure-label">
            Name
          </label>
          <input
            id="structure-label"
            className="input"
            value={draft.label}
            onChange={(event) => onChange({ ...draft, label: event.target.value })}
          />
        </div>
      </div>

      <p className={styles.subheading}>Questions each entry asks</p>
      {draft.members.map((member, index) => (
        <div key={index}>
          <div className={styles.questionRow}>
            <span>{member.label || 'Unnamed member'}</span>
            <span className={styles.questionKey}>
              {member.key} · {humanize(member.fieldType).toLowerCase()}
            </span>
            <span className={styles.questionActions}>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                aria-label={`Move ${member.label || member.key} earlier`}
                disabled={index === 0}
                onClick={() => moveMember(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                aria-label={`Move ${member.label || member.key} later`}
                disabled={index === draft.members.length - 1}
                onClick={() => moveMember(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                onClick={() => setOpenMember(openMember === index ? null : index)}
              >
                {openMember === index ? 'Close' : 'Edit'}
              </button>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                onClick={() => {
                  setOpenMember(null)
                  onChange({
                    ...draft,
                    members: draft.members.filter((_, at) => at !== index),
                  })
                }}
              >
                Remove
              </button>
            </span>
          </div>
          {openMember === index ? (
            <div className={styles.editor}>
              <FieldEditor
                idPrefix={`member-${index}`}
                draft={member}
                onChange={(changed) =>
                  onChange({
                    ...draft,
                    members: draft.members.map((each, at) =>
                      at === index ? changed : each,
                    ),
                  })
                }
                variant="member"
                keyLocked={false}
              />
            </div>
          ) : null}
        </div>
      ))}
      <div>
        <button
          type="button"
          className="button"
          onClick={() => {
            onChange({ ...draft, members: [...draft.members, blankDraft()] })
            setOpenMember(draft.members.length)
          }}
        >
          Add a member
        </button>
      </div>
      {editorRow}
    </div>
  ) : null

  return (
    <div className="card">
      <div className="card-header">
        <p className="eyebrow">Reusable structures</p>
      </div>
      <div className="card-body stack">
        <p className="muted">
          A structure is a set of questions defined once — “an owner is a name, a date of
          birth, a share” — and used by any repeated group that names it. Editing the
          structure edits every group that uses it.
        </p>
        {definitions.length === 0 && !draft ? (
          <p className="muted">This cycle defines no structures yet.</p>
        ) : null}
        {definitions.map((definition) => (
          <div key={definition.definitionKey}>
            <div className={styles.questionRow}>
              <span>{definition.label}</span>
              <span className={styles.questionKey}>
                {definition.definitionKey} · {definition.members.length}{' '}
                {definition.members.length === 1 ? 'question' : 'questions'}
                {usersOf(definition.definitionKey).length > 0
                  ? ` · used by ${usersOf(definition.definitionKey).join(', ')}`
                  : ' · unused'}
              </span>
              <span className={styles.questionActions}>
                <button
                  type="button"
                  className="button"
                  data-variant="ghost"
                  onClick={() => onEdit(definition)}
                  disabled={busy}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button"
                  data-variant="ghost"
                  disabled={!canAct}
                  title={canAct ? undefined : 'Write a change reason above first.'}
                  onClick={() => onRemove(definition.definitionKey)}
                >
                  Remove
                </button>
              </span>
            </div>
            {draft && !draftIsNew && draft.key === definition.definitionKey
              ? editor
              : null}
          </div>
        ))}
        {draft && draftIsNew ? editor : null}
        <div>
          <button type="button" className="button" onClick={onNew} disabled={busy}>
            Define a structure
          </button>
        </div>
      </div>
    </div>
  )
}
