/**
 * Pipelines: authoring them, and working a file through one.
 *
 * Authoring is about no person and no application, so those events carry
 * neither. What each records is the version it produced and the operator's
 * reason. The definition itself stays on the version row, which is the record
 * of it; a copy here would drift from it.
 *
 * A stage action is about an application and its applicant, like every other
 * casework event. It records what the action did: where the file went, which
 * flags it gained and lost, what was recorded, and what the officer entered as
 * labelled values. Long text is never copied here. A note or a message to the
 * applicant stays on its own row, which is the record of it.
 *
 * Stages, actions and flags are configured, so they are recorded as codes with
 * their labels at the time, never as a closed set. A pipeline renamed later
 * still reads the way it did when the officer acted.
 */
import { z } from 'zod'
import { auditId, code, count, label, REASON_FIELD, reasonText, version, VERSION_FIELD } from './fields'
import { defineAudit, type AuditFieldSpec } from './types'

const PIPELINE_ENTITY = ['SEB_PIPELINE'] as const

/** A pipeline named as its key and its name at the time. */
const named = { pipelineKey: code, pipelineName: label }
const namedFields = {
  pipelineKey: { label: 'Pipeline key', kind: 'ENUM' },
  pipelineName: { label: 'Pipeline', kind: 'TEXT' },
} as const

/**
 * A value as the history shows it: a label, how to read the value, and the
 * value as text. What {@link VALUES_FIELD} renders.
 */
const shownValue = z.strictObject({
  label,
  kind: z.enum(['TEXT', 'MONEY', 'DATE', 'COUNT', 'ENUM', 'BOOLEAN']),
  value: z.string().max(200),
})

/** Every label below that reads a list the same way. */
const VALUES_FIELD = (text: string): AuditFieldSpec => ({ label: text, kind: 'VALUES' })
const LIST_FIELD = (text: string): AuditFieldSpec => ({ label: text, kind: 'LIST' })

/** A spec about a pipeline itself: every authoring act. */
const authoring = { category: 'PIPELINE', writer: 'pipeline', entityTypes: PIPELINE_ENTITY, subject: 'NONE', application: 'NONE' } as const

export const pipelineVocabulary = {
  'SEB.PIPELINE_CREATED': defineAudit({
    ...authoring,
    label: 'Created a pipeline',
    payload: z.strictObject(named),
    fields: namedFields,
    summary: (p) => `Created the pipeline ${p.pipelineName}`,
    example: { pipelineKey: 'MISSION_SEP', pipelineName: 'Mission SEP' },
  }),
  'SEB.PIPELINE_DRAFT_SAVED': defineAudit({
    ...authoring,
    label: 'Saved a pipeline draft',
    // The revision the save produced: which save of the draft this was.
    payload: z.strictObject({ ...named, version, revision: version, stageCount: count }),
    fields: {
      ...namedFields,
      version: VERSION_FIELD,
      revision: { label: 'Draft revision', kind: 'COUNT' },
      stageCount: { label: 'Stages', kind: 'COUNT' },
    },
    summary: (p) => `Saved draft ${p.version} of ${p.pipelineName}`,
    example: { pipelineKey: 'MISSION_SEP', pipelineName: 'Mission SEP', version: 1, revision: 3, stageCount: 4 },
  }),
  'SEB.PIPELINE_PUBLISHED': defineAudit({
    ...authoring,
    label: 'Published a pipeline',
    payload: z.strictObject({ ...named, version, changeNote: reasonText.optional() }),
    fields: { ...namedFields, version: VERSION_FIELD, changeNote: { label: 'Change note', kind: 'REASON' } },
    summary: (p) => `Published version ${p.version} of ${p.pipelineName}`,
    example: { pipelineKey: 'MISSION_SEP', pipelineName: 'Mission SEP', version: 1, changeNote: 'First route.' },
  }),
  'SEB.PIPELINE_DRAFT_DISCARDED': defineAudit({
    ...authoring,
    label: 'Discarded a pipeline draft',
    payload: z.strictObject({ ...named, version }),
    fields: { ...namedFields, version: VERSION_FIELD },
    summary: (p) => `Discarded draft ${p.version} of ${p.pipelineName}`,
    example: { pipelineKey: 'MISSION_SEP', pipelineName: 'Mission SEP', version: 2 },
  }),
  'SEB.PIPELINE_RETIRED': defineAudit({
    ...authoring,
    label: 'Retired a pipeline',
    payload: z.strictObject({ ...named, reason: reasonText }),
    fields: { ...namedFields, reason: REASON_FIELD },
    summary: (p) => `Retired the pipeline ${p.pipelineName}`,
    example: { pipelineKey: 'MISSION_SEP', pipelineName: 'Mission SEP', reason: 'Replaced by the 2027 route.' },
  }),
  'SEB.PIPELINE_STAGE_OWNERS_CHANGED': defineAudit({
    ...authoring,
    label: 'Changed who works a stage',
    entityTypes: ['SEB_PIPELINE_STAGE'],
    /*
     * The roles as keys: a role's name is resolved when the row is read, and
     * a list of references would need a reference kind per element. The
     * previous and new lists are both kept, so the change reads without the
     * row before it.
     */
    payload: z.strictObject({
      ...named,
      stageKey: code,
      rolesAdded: z.array(code).max(64),
      rolesRemoved: z.array(code).max(64),
      reason: reasonText,
    }),
    fields: {
      ...namedFields,
      stageKey: { label: 'Stage', kind: 'ENUM' },
      rolesAdded: LIST_FIELD('Roles added'),
      rolesRemoved: LIST_FIELD('Roles removed'),
      reason: REASON_FIELD,
    },
    summary: (p) => {
      const parts = [
        p.rolesAdded.length > 0 ? `gave it to ${p.rolesAdded.join(', ')}` : '',
        p.rolesRemoved.length > 0 ? `took it from ${p.rolesRemoved.join(', ')}` : '',
      ].filter(Boolean)
      return `Changed who works ${p.stageKey} in ${p.pipelineName}: ${parts.join(' and ') || 'no change'}`
    },
    example: {
      pipelineKey: 'MISSION_SEP',
      pipelineName: 'Mission SEP',
      stageKey: 'SBI_BANK',
      rolesAdded: ['SBI_BANK'],
      rolesRemoved: [],
      reason: 'The bank named its officers.',
    },
  }),

  /* ------------------------------------------------------------ casework */
  'SEB.STAGE_ACTION_TAKEN': defineAudit({
    label: 'Took a stage action',
    category: 'STAGE',
    writer: 'pipeline',
    entityTypes: ['SEB_APPLICATION_STAGE_ACTION'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: z.strictObject({
      pipelineKey: code,
      pipelineVersion: version,
      stageKey: code,
      stageName: label,
      actionKey: code,
      actionLabel: label,
      /** Where the file went; absent when it stayed or its journey ended. */
      toStageKey: code.optional(),
      toStageName: label.optional(),
      /** The terminal flag's label, when the action ended the journey. */
      ended: label.optional(),
      flagsAdded: z.array(z.string().max(200)).max(32),
      flagsRemoved: z.array(z.string().max(200)).max(32),
      recorded: z.array(shownValue).max(16),
      inputs: z.array(shownValue).max(20),
      revisionStageCount: count,
      notified: z.boolean(),
    }),
    fields: {
      pipelineKey: { label: 'Pipeline', kind: 'ENUM' },
      pipelineVersion: VERSION_FIELD,
      stageKey: { label: 'Stage key', kind: 'ENUM' },
      stageName: { label: 'Stage', kind: 'TEXT' },
      actionKey: { label: 'Action key', kind: 'ENUM' },
      actionLabel: { label: 'Action', kind: 'TEXT' },
      toStageKey: { label: 'Sent to (key)', kind: 'ENUM' },
      toStageName: { label: 'Sent to', kind: 'TEXT' },
      ended: { label: 'Ended as', kind: 'TEXT' },
      flagsAdded: LIST_FIELD('Status added'),
      flagsRemoved: LIST_FIELD('Status removed'),
      recorded: VALUES_FIELD('Recorded'),
      inputs: VALUES_FIELD('Entered'),
      revisionStageCount: { label: 'Form stages sent back', kind: 'COUNT' },
      notified: { label: 'Applicant notified', kind: 'BOOLEAN' },
    },
    summary: (p) => {
      const done = `${p.actionLabel} at ${p.stageName}`
      if (p.ended) return `${done}, ending as ${p.ended}`
      if (p.toStageName) return `${done}, sending it to ${p.toStageName}`
      if (p.revisionStageCount > 0) return `${done}, asking the applicant for changes`
      return done
    },
    example: {
      pipelineKey: 'MISSION_SEP',
      pipelineVersion: 1,
      stageKey: 'INDUSTRIES_COMMERCE',
      stageName: 'Industries & Commerce',
      actionKey: 'APPROVE_GRANT',
      actionLabel: 'Approve the grant',
      flagsAdded: ['Grant approved'],
      flagsRemoved: [],
      recorded: [{ label: 'Approved grant', kind: 'MONEY', value: '25000000' }],
      inputs: [{ label: 'Grant amount', kind: 'MONEY', value: '25000000' }],
      revisionStageCount: 0,
      notified: true,
    },
  }),
  'SEB.STAGE_NOTIFICATION_FAILED': defineAudit({
    label: 'Could not tell the applicant about a stage action',
    category: 'STAGE',
    writer: 'pipeline',
    entityTypes: ['SEB_APPLICATION_STAGE_ACTION'],
    subject: 'APPLICANT',
    application: 'REQUIRED',
    payload: z.strictObject({ stageActionId: auditId, actionKey: code }),
    fields: { stageActionId: { label: 'Stage action', kind: 'ID' }, actionKey: { label: 'Action', kind: 'ENUM' } },
    summary: (p) => `The email about ${p.actionKey} could not be sent to the applicant`,
    example: { stageActionId: '00000000-0000-4000-8000-000000000021', actionKey: 'APPROVE_GRANT' },
  }),
} as const
