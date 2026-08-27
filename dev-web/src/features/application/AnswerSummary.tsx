/**
 * The answers, read back.
 *
 * One component for every screen that shows a filled-in form rather than an
 * editable one: the submission acknowledgement, the review before sending, and
 * the office's own view of what was submitted. They used to be three
 * hand-written lists of the same 39 fields, which is three places for a new
 * question to be forgotten.
 *
 * Only the questions the cycle actually asked, and only the ones its own
 * conditions leave on screen — so a form reads back the way it was filled in
 * rather than as a list of blanks the applicant was never shown.
 */
import type { AnswerEntry, AnswerMap, AnswerValue } from './answers'
import { entriesOf } from './answers'
import {
  isRequiredWhenVisible,
  visibleFields,
  type FormField,
  type ResolvedTemplate,
} from './formTemplate'
import { formatDate, formatMoney } from '#/lib/format'

/**
 * One answer as a sentence.
 *
 * Money is shown in rupees and dates in the applicant's own format, because a
 * summary is read rather than parsed. An unanswered optional question says so
 * rather than showing an empty cell that reads like a defect.
 */
export const readAnswer = (field: FormField, value: AnswerValue): string => {
  if (value === null || value === undefined || value === '') return '—'
  if (field.type === 'MONEY_PAISE') return formatMoney(String(value))
  if (field.type === 'DATE') return formatDate(String(value))
  if (field.type === 'BOOLEAN') return value ? 'Yes' : 'No'
  if (field.type === 'ATTESTATION') return value ? 'Confirmed' : 'Not confirmed'
  const label = (option: string) =>
    field.options.find((each) => each.value === option)?.label ?? option
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : (value as readonly string[]).map(label).join(', ')
  }
  if (field.type === 'SINGLE_CHOICE') return label(String(value))
  return String(value)
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <span>{value}</span>
    </div>
  )
}

function GroupEntries({
  template,
  field,
  answers,
}: {
  template: ResolvedTemplate
  field: FormField
  answers: AnswerMap
}) {
  const entries = entriesOf(answers, field.key)
  if (entries.length === 0) {
    return (
      <div>
        <span className="field-label">{field.label}</span>
        <span>None</span>
      </div>
    )
  }
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <span className="field-label">{field.label}</span>
      <div className="stack">
        {entries.map((entry: AnswerEntry, index) => {
          const visible = visibleFields(template, answers, entry, field.key)
          return (
            <div className="detail-grid" key={index}>
              {template
                .membersOfGroup(field.key)
                .filter((member) => visible.has(member.key) && member.type !== 'FILE')
                .map((member) => (
                  <Fact
                    key={member.key}
                    label={member.label}
                    value={readAnswer(member, entry[member.key] ?? null)}
                  />
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Every stage the cycle asked, with what was answered in it. */
export function AnswerSummary({
  template,
  answers,
  /** Shown at the top of each stage, where a screen wants a control there. */
  stageAction,
}: {
  template: ResolvedTemplate
  answers: AnswerMap
  stageAction?: (stageKey: string) => React.ReactNode
}) {
  const visible = visibleFields(template, answers)
  return (
    <div className="stack">
      {template.stages.map((stage) => {
        const fields = template
          .fieldsOfStage(stage.key)
          .filter((field) => visible.has(field.key) && field.type !== 'FILE')
        if (fields.length === 0) return null
        return (
          <div key={stage.key}>
            <div className="label-row">
              <h3 className="eyebrow">{stage.title}</h3>
              {stageAction?.(stage.key)}
            </div>
            <div className="detail-grid">
              {fields.map((field) =>
                field.type === 'REPEAT_GROUP' ? (
                  <GroupEntries
                    key={field.key}
                    template={template}
                    field={field}
                    answers={answers}
                  />
                ) : (
                  <Fact
                    key={field.key}
                    label={
                      isRequiredWhenVisible(template, field, answers, visible)
                        ? field.label
                        : `${field.label} (optional)`
                    }
                    value={readAnswer(field, (answers[field.key] ?? null) as AnswerValue)}
                  />
                ),
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
