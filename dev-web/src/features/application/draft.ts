/**
 * Naming the parts of the form, when the template is not to hand.
 *
 * Almost every screen that shows a stage or a field now has the template and
 * reads the label straight off it — which is the point of the change: a label
 * for a question that lives in data cannot be written in code at all.
 *
 * What is left here is the fallback for the places that legitimately have only
 * a key: a timeline event naming a stage, a revision request in a list, an
 * issue the server reports against a field this client did not draw. Showing a
 * humanised key is more use than showing nothing, and it is honest about being
 * a guess.
 */
import { humanize } from '#/lib/format'

/**
 * A stage's name, from the template where there is one.
 *
 * The template is optional because the administrative queue lists applications
 * from many cycles at once and has no single template to read.
 */
export const stageTitle = (
  stageKey: string,
  stages?: readonly { key: string; title: string }[],
): string => stages?.find((stage) => stage.key === stageKey)?.title ?? humanize(stageKey)

/**
 * A field's name, from the template where there is one.
 *
 * Accepts an issue path — `GROUP[0].MEMBER` — and names the member, because
 * that is the string the server reports an issue against.
 */
export const fieldLabel = (
  field: string,
  fields?: readonly { key: string; label: string }[],
): string => {
  const key = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field
  return fields?.find((each) => each.key === key)?.label ?? humanize(key)
}
