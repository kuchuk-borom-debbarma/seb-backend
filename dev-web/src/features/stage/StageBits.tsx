/**
 * The small pieces every stage screen draws the same way: a configured value,
 * a file's status flags, and the trail of stages it came through.
 *
 * One place decides how a recorded amount or a sanction date looks, so the
 * queue, the panel and the history cannot disagree about it.
 */
import { ChevronRight } from 'lucide-react'
import { formatDate, formatMoney } from '#/lib/format'
import styles from './Stage.module.css'

/**
 * A configured value as text, read by its declared type.
 *
 * `MONEY_PAISE` arrives as a number of paise and goes through the one money
 * formatter; a choice arrives already as its option's label.
 */
export const valueText = (value: { type: string; value: string }): string => {
  if (value.type === 'MONEY_PAISE') return formatMoney(value.value)
  if (value.type === 'DATE') return formatDate(value.value)
  if (value.type === 'BOOLEAN') return value.value === 'true' ? 'Yes' : 'No'
  return value.value
}

/** Labelled values as a definition list. Nothing is drawn for none. */
export function ValueList({
  values,
}: {
  values: readonly { key: string; label: string; type: string; value: string }[]
}) {
  if (values.length === 0) return null
  return (
    <dl className={styles.valueList}>
      {values.map((value) => (
        <div key={value.key} className={styles.valueRow}>
          <dt>{value.label}</dt>
          <dd
            className={
              value.type === 'MONEY_PAISE' || value.type === 'DATE'
                ? 'tabular'
                : undefined
            }
          >
            {valueText(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Status flags as chips. A terminal flag reads as how the journey ended, so it
 * is toned apart from the ones that describe progress.
 */
export function FlagChips({
  flags,
  empty,
}: {
  flags: readonly { key: string; label: string; terminal?: boolean; kind?: string }[]
  empty?: string
}) {
  if (flags.length === 0) return empty ? <span className="muted">{empty}</span> : null
  return (
    <span className={styles.chips}>
      {flags.map((flag) => (
        <span
          key={flag.key}
          className={styles.chip}
          data-tone={
            flag.terminal ? 'end' : flag.kind === 'OUTCOME' ? 'outcome' : undefined
          }
        >
          {flag.label}
        </span>
      ))}
    </span>
  )
}

/** The stages a file came through, oldest first, ending where it is now. */
export function Trail({
  trail,
  current,
  endedAt = null,
}: {
  trail: readonly { key: string; name: string }[]
  current: string | null
  /** The stage a finished journey ended in, which no longer holds the file. */
  endedAt?: string | null
}) {
  const last = current ?? endedAt
  const steps = [...trail.map((step) => step.name), ...(last ? [last] : [])]
  if (steps.length <= 1) return null
  return (
    <ol className={styles.trail} aria-label="Stages this file came through">
      {steps.map((name, index) => (
        <li
          key={`${name}-${index}`}
          aria-current={index === steps.length - 1 && current ? 'step' : undefined}
        >
          {index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}
          <span>{name}</span>
        </li>
      ))}
    </ol>
  )
}
