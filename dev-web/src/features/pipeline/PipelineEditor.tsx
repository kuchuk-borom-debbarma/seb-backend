/**
 * One pipeline, as its author edits it.
 *
 * The working copy is a typed document held in one reducer and sent whole: a
 * draft is replaced as a unit, guarded by its revision, so two authors cannot
 * interleave half-edits and the second save is told the draft changed. What
 * the server refuses comes back as problems at a path, and each problem here
 * is a link to the place it is about.
 *
 * Publishing publishes what is **saved**, not what is on screen — so it is not
 * offered while there are unsaved changes, rather than silently publishing an
 * older revision than the one the author is looking at.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, CheckCircle2, Save, Send, Trash2, X } from 'lucide-react'
import { useEffect, useReducer, useState } from 'react'
import { Dialog } from '#/components/Dialog'
import modal from '#/features/admin/CycleDetails.module.css'
import {
  DiscardPipelineDraftDocument,
  PublishPipelineDocument,
  RetirePipelineDocument,
  SavePipelineDraftDocument,
  ValidatePipelineDraftDocument,
} from '#/graphql/generated/operations'
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { can, useCurrentUser } from '#/lib/session'
import { ActionsTab } from './ActionsTab'
import { definitionFromJson, definitionToJson } from './definition'
import {
  describePath,
  editorReducer,
  initialEditorState,
  isDirty,
  locationOf,
  type EditorTab,
} from './editorState'
import { FlagsTab, RecordedValuesTab } from './FlagsTab'
import { FlowDiagram } from './FlowDiagram'
import { OwnersTab } from './OwnersTab'
import type { TabProps } from './names'
import { pipelineQuery, type PipelineCatalogue, type PipelineDetail } from './pipelineQueries'
import styles from './Pipeline.module.css'
import { StagesTab } from './StagesTab'
import { VersionsTab } from './VersionsTab'

type Problem = { path: string; message: string }

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'flow', label: 'Flow' },
  { id: 'stages', label: 'Stages' },
  { id: 'flags', label: 'Status flags' },
  { id: 'values', label: 'Recorded values' },
  { id: 'actions', label: 'Actions' },
  { id: 'owners', label: 'Owners' },
  { id: 'versions', label: 'Versions' },
]

/** The API's refusal for a guarded write that lost a race. */
const isStale = (error: unknown) => /changed/iu.test(messageFor(error))

export function PipelineEditor({
  detail,
  catalogue,
}: {
  detail: PipelineDetail
  catalogue: PipelineCatalogue
}) {
  const queryClient = useQueryClient()
  const user = useCurrentUser()
  // Each control asks for the act its own mutation needs, nothing broader.
  const authority = {
    update: can(user, 'pipeline', 'update'),
    publish: can(user, 'pipeline', 'publish'),
    retire: can(user, 'pipeline', 'retire'),
    assign: can(user, 'pipeline', 'assign'),
  }
  const retired = detail.retiredAt !== null
  const draft = detail.draft
  // What the screen shows: the draft when there is one, else what cycles pin.
  const sourceJson = draft?.definitionJson ?? detail.published?.definitionJson ?? null
  const editable = Boolean(draft) && authority.update && !retired

  const [state, dispatch] = useReducer(editorReducer, sourceJson, (json) =>
    initialEditorState(definitionFromJson(json ?? '{"stages":[]}')),
  )
  const definition = state.definition
  const dirty = editable && isDirty(state)

  const [tab, setTab] = useState<EditorTab>('flow')
  const [stageIndex, setStageIndex] = useState(0)
  const [actionIndex, setActionIndex] = useState(0)
  const [focus, setFocus] = useState<number | undefined>(undefined)
  const [problems, setProblems] = useState<Problem[] | null>(draft ? draft.problems : null)
  /*
   * The document the problems describe. Compared by reference: every edit
   * makes a new one, so "the list is out of date" is exactly "the document
   * changed since it was checked" — not "since it was saved", which would
   * call a check of these very edits stale.
   */
  const [checked, setChecked] = useState(definition)
  const outOfDate = checked !== definition
  const [dialog, setDialog] = useState<'publish' | 'discard' | 'retire' | null>(null)

  /*
   * Unsaved work is not lost silently: the browser asks before the page is
   * closed or reloaded, as the applicant's form does.
   */
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const edit: TabProps['edit'] = (update) => dispatch({ type: 'edit', update })

  /** Puts the detail the server returned in the cache, and the editor on its draft. */
  const settle = async (next: PipelineDetail) => {
    queryClient.setQueryData(['pipelines', 'detail', next.key], { success: true, message: null, response: next })
    // Lists this editor does not show: stale, not waited on.
    void queryClient.invalidateQueries({ queryKey: ['pipelines'], exact: true })
    void queryClient.invalidateQueries({ queryKey: ['pipelines', 'choices'] })
    const json = next.draft?.definitionJson ?? next.published?.definitionJson
    if (json) {
      const loaded = definitionFromJson(json)
      dispatch({ type: 'load', definition: loaded })
      setChecked(loaded)
    }
    setProblems(next.draft ? next.draft.problems : null)
  }

  const validate = useMutation({
    mutationFn: async (checking: typeof definition) => ({
      checking,
      result: unwrap((await gql(ValidatePipelineDraftDocument, { definition: definitionToJson(checking) })).admin.pipeline.validateDraft),
    }),
    onSuccess: ({ checking, result }) => {
      setProblems(result.problems)
      setChecked(checking)
    },
  })

  const save = useMutation({
    mutationFn: async (startNext: boolean) =>
      unwrap(
        (
          await gql(SavePipelineDraftDocument, {
            input: {
              pipelineId: detail.id,
              // 0 starts the next draft: from what is published, or — when a
              // first draft was discarded before any publish — from the example.
              expectedRevision: startNext ? 0 : draft!.revision,
              definition: startNext
                ? detail.published?.definitionJson ?? catalogue.exampleDefinitionJson
                : definitionToJson(definition),
            },
          })
        ).admin.pipeline.saveDraft,
      ),
    onSuccess: settle,
  })

  const reload = async () => {
    const fresh = await queryClient.fetchQuery(pipelineQuery(detail.key))
    if (fresh.response) await settle(fresh.response)
    save.reset()
  }

  const goTo = (path: string) => {
    const location = locationOf(path)
    setTab(location.tab)
    if (location.stageIndex !== undefined) setStageIndex(location.stageIndex)
    setActionIndex(location.actionIndex ?? 0)
    setFocus(location.index)
  }

  const readOnly = !editable

  return (
    <div className="stack">
      <div className={styles.toolbar}>
        <div className={styles.toolbarState}>
          {retired ? <span className="badge" data-tone="error">Retired</span> : null}
          {draft ? (
            <span className="badge" data-tone="warn">Draft v{draft.version} · revision {draft.revision}</span>
          ) : detail.published ? (
            <span className="badge" data-tone="ok">Published v{detail.published.version}</span>
          ) : null}
          {detail.currentPublishedVersion !== null && draft ? (
            <span className="muted">Cycles pin v{detail.currentPublishedVersion}</span>
          ) : null}
          {dirty ? <span className="badge" data-tone="action">Unsaved changes</span> : null}
          {draft && !dirty ? <span className="muted">Saved {formatDateTime(draft.updatedAt)}</span> : null}
          {readOnly && !retired && draft ? <span className="muted">Read-only: you may not edit pipelines</span> : null}
        </div>
        <div className={styles.toolbarActions}>
          <button type="button" className="button" disabled={validate.isPending} onClick={() => validate.mutate(definition)}>
            <CheckCircle2 size={16} aria-hidden /> {validate.isPending ? 'Checking…' : 'Check'}
          </button>
          {editable ? (
            <button type="button" className="button" data-variant="primary" disabled={!dirty || save.isPending}
              onClick={() => save.mutate(false)}>
              <Save size={16} aria-hidden /> {save.isPending ? 'Saving…' : 'Save draft'}
            </button>
          ) : null}
          {!draft && authority.update && !retired ? (
            <button type="button" className="button" data-variant="primary" disabled={save.isPending} onClick={() => save.mutate(true)}
              title={detail.published ? 'Starts from the published version' : 'Nothing is published, so it starts from the example'}>
              Start a new draft
            </button>
          ) : null}
          {draft && authority.publish && !retired ? (
            <button type="button" className="button" disabled={dirty} title={dirty ? 'Save first: publishing publishes the saved draft.' : undefined}
              onClick={() => setDialog('publish')}>
              <Send size={16} aria-hidden /> Publish
            </button>
          ) : null}
          {draft && authority.update && !retired ? (
            <button type="button" className="button" onClick={() => setDialog('discard')}>
              <Trash2 size={16} aria-hidden /> Discard draft
            </button>
          ) : null}
          {authority.retire && !retired ? (
            <button type="button" className="button" data-variant="danger" onClick={() => setDialog('retire')}>
              Retire
            </button>
          ) : null}
        </div>
      </div>

      {sourceJson === null ? (
        <div className="notice" role="status">
          This pipeline has no document: its first draft was discarded before anything was published.
          {authority.update && !retired ? ' Start a new draft to author it again.' : ''}
        </div>
      ) : !draft && !retired && authority.update ? (
        <div className="notice" role="status">
          You are looking at the published version, which never changes. Start a new draft to edit it; cycles keep the
          version they pinned until the new one is published.
        </div>
      ) : null}

      {save.error ? (
        <div className="notice" data-tone="error" role="alert">
          <p style={{ margin: 0 }}>{messageFor(save.error)}</p>
          {isStale(save.error) ? (
            <button type="button" className="button" style={{ marginTop: '0.5rem' }} onClick={() => void reload()}>
              Load the saved draft (your unsaved changes are discarded)
            </button>
          ) : null}
        </div>
      ) : null}
      {validate.error ? <p className="field-error" role="alert">{messageFor(validate.error)}</p> : null}

      {problems !== null ? (
        problems.length === 0 ? (
          <div className="notice" data-tone="ok" role="status">
            <Check size={16} aria-hidden /> {outOfDate
              ? 'The last check found nothing wrong — check again after your changes.'
              : dirty
                ? 'Nothing wrong with these changes. Save them, then publish.'
                : 'Nothing stops this draft from being published.'}
          </div>
        ) : (
          <div className="card card-body" role="alert">
            <p className={`field-label ${styles.problemsTitle}`}>
              <AlertTriangle size={16} aria-hidden /> {problems.length === 1 ? 'One problem stops' : `${problems.length} problems stop`} this draft from being published
            </p>
            {/* The list is the last check's. After an edit it may name
                something already fixed, and saying so stops it reading as
                though the edit did not take. */}
            {outOfDate ? (
              <p className="field-hint" style={{ marginTop: 0 }}>
                As of the last check — press Check or save to see where your changes leave it.
              </p>
            ) : null}
            <ol className={styles.problems}>
              {problems.map((problem, index) => (
                <li key={`${problem.path}-${index}`}>
                  <button type="button" className={styles.problemLink} onClick={() => goTo(problem.path)}>
                    {problem.message}
                  </button>
                  <span className={styles.problemPath}>{describePath(problem.path, definition)}</span>
                </li>
              ))}
            </ol>
          </div>
        )
      ) : null}

      <div className="tabs" role="tablist" aria-label="Pipeline editor">
        {TABS.map((each) => (
          <button key={each.id} type="button" role="tab" className={`tab ${styles.tabButton}`} aria-selected={tab === each.id}
            onClick={() => setTab(each.id)}>
            {each.label}
            {each.id === 'stages' ? <span className="tab-count">{definition.stages.length}</span> : null}
            {each.id === 'flags' ? <span className="tab-count">{definition.statusFlags.length}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'flow' ? (
          <div className="card card-body">
            <FlowDiagram definition={definition} onSelectStage={(key) => {
              setStageIndex(Math.max(0, definition.stages.findIndex((stage) => stage.key === key)))
              setTab('stages')
            }} />
          </div>
        ) : null}
        {tab === 'stages' ? (
          <StagesTab definition={definition} edit={edit} readOnly={readOnly} selected={Math.min(stageIndex, definition.stages.length - 1)}
            onSelect={setStageIndex}
            onOpenActions={(index) => { setStageIndex(index); setActionIndex(0); setTab('actions') }} />
        ) : null}
        {tab === 'flags' ? <FlagsTab definition={definition} edit={edit} readOnly={readOnly} focus={focus} /> : null}
        {tab === 'values' ? <RecordedValuesTab definition={definition} edit={edit} readOnly={readOnly} focus={focus} /> : null}
        {tab === 'actions' ? (
          <ActionsTab definition={definition} edit={edit} readOnly={readOnly} catalogue={catalogue}
            stageIndex={Math.min(stageIndex, Math.max(0, definition.stages.length - 1))}
            actionIndex={actionIndex}
            onSelect={(stage, action) => { setStageIndex(stage); setActionIndex(action) }} />
        ) : null}
        {tab === 'owners' ? <OwnersTab detail={detail} definition={definition} mayAssign={authority.assign && !retired} /> : null}
        {tab === 'versions' ? <VersionsTab detail={detail} /> : null}
      </div>

      {dialog === 'publish' && draft ? (
        <PublishDialog detail={detail} problemCount={problems?.length ?? null} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog === 'discard' && draft ? (
        <DiscardDialog detail={detail} dirty={dirty} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog === 'retire' ? <RetireDialog detail={detail} onClose={() => setDialog(null)} onDone={settle} /> : null}
    </div>
  )
}

/** The frame the three confirmation dialogs share. */
function Confirm({ title, children, footer, onClose }: {
  title: string
  children: React.ReactNode
  footer: React.ReactNode
  onClose: () => void
}) {
  return (
    <Dialog open onClose={onClose}>
      <div className={modal.modalOverlay} role="dialog" aria-modal="true" aria-label={title}>
        <div className={modal.modalDialog}>
          <div className={modal.modalHeader}>
            <h3 className={modal.modalTitle}>{title}</h3>
            <button type="button" className={modal.modalCloseButton} onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className={modal.modalBody}>{children}</div>
          <div className={modal.modalFooter}>{footer}</div>
        </div>
      </div>
    </Dialog>
  )
}

function PublishDialog({ detail, problemCount, onClose, onDone }: {
  detail: PipelineDetail
  problemCount: number | null
  onClose: () => void
  onDone: (detail: PipelineDetail) => Promise<void>
}) {
  const draft = detail.draft!
  const [note, setNote] = useState('')
  const publish = useMutation({
    mutationFn: async () =>
      unwrap(
        (
          await gql(PublishPipelineDocument, {
            input: { pipelineId: detail.id, expectedRevision: draft.revision, changeNote: note.trim() || null },
          })
        ).admin.pipeline.publish,
      ),
    onSuccess: async (next) => {
      await onDone(next)
      onClose()
    },
  })
  return (
    <Confirm
      title={`Publish version ${draft.version}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="button" className="button" data-variant="primary" disabled={publish.isPending} onClick={() => publish.mutate()}>
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        Version {draft.version} becomes what new cycles pin when they open. Cycles already open keep the version they
        opened with. A published version never changes; later edits start a new draft.
      </p>
      {problemCount !== null && problemCount > 0 ? (
        <p className="field-error">The last check found {problemCount} {problemCount === 1 ? 'problem' : 'problems'}; publishing will be refused until they are fixed.</p>
      ) : null}
      <div>
        <label className="field-label" htmlFor="changeNote">What changed</label>
        <textarea id="changeNote" className="textarea" maxLength={500} value={note} placeholder="Kept with the version"
          onChange={(event) => setNote(event.target.value)} />
      </div>
      {publish.error ? <p className="field-error" role="alert" style={{ whiteSpace: 'pre-line' }}>{messageFor(publish.error)}</p> : null}
    </Confirm>
  )
}

function DiscardDialog({ detail, dirty, onClose, onDone }: {
  detail: PipelineDetail
  dirty: boolean
  onClose: () => void
  onDone: (detail: PipelineDetail) => Promise<void>
}) {
  const draft = detail.draft!
  const discard = useMutation({
    mutationFn: async () =>
      unwrap(
        (await gql(DiscardPipelineDraftDocument, { input: { pipelineId: detail.id, expectedRevision: draft.revision } }))
          .admin.pipeline.discardDraft,
      ),
    onSuccess: async (next) => {
      await onDone(next)
      onClose()
    },
  })
  return (
    <Confirm
      title={`Discard draft ${draft.version}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>Keep it</button>
          <button type="button" className="button" data-variant="danger" disabled={discard.isPending} onClick={() => discard.mutate()}>
            {discard.isPending ? 'Discarding…' : 'Discard the draft'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        The draft is thrown away{dirty ? ', with your unsaved changes' : ''}. What is published is unaffected
        {detail.currentPublishedVersion === null ? ' — but nothing is published yet, so the pipeline will have no document until a new draft is started.' : '.'}
      </p>
      {discard.error ? <p className="field-error" role="alert">{messageFor(discard.error)}</p> : null}
    </Confirm>
  )
}

function RetireDialog({ detail, onClose, onDone }: {
  detail: PipelineDetail
  onClose: () => void
  onDone: (detail: PipelineDetail) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const retire = useMutation({
    mutationFn: async () =>
      unwrap((await gql(RetirePipelineDocument, { input: { pipelineId: detail.id, reason: reason.trim() } })).admin.pipeline.retire),
    onSuccess: async (next) => {
      await onDone(next)
      onClose()
    },
  })
  return (
    <Confirm
      title={`Retire ${detail.name}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="button" className="button" data-variant="danger" disabled={!reason.trim() || retire.isPending} onClick={() => retire.mutate()}>
            {retire.isPending ? 'Retiring…' : 'Retire the pipeline'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        No new cycle can choose it. Cycles already using it keep working their applications through it. This cannot be undone.
      </p>
      <div>
        <label className="field-label" htmlFor="retireReason">Why</label>
        <textarea id="retireReason" className="textarea" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      {retire.error ? <p className="field-error" role="alert">{messageFor(retire.error)}</p> : null}
    </Confirm>
  )
}
