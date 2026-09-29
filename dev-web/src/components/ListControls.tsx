/**
 * The controls every list on this site needs.
 *
 * `SearchBox` is labelled "Starts with", not "Search". The API matches an
 * indexed prefix — that is what makes it a seek rather than a scan of the whole
 * table — and a box labelled "Search" that silently means "starts with" would
 * be a lie somebody discovers by typing a word from the middle of a name and
 * getting nothing.
 *
 * `Pager` reports the total, so a page says where it is in the set rather than
 * offering a Next button and no sense of how much is left.
 *
 * `MultiSelectFilter` and `ListEmpty` are the two pieces a filtered list adds:
 * choosing several values of one dimension, and saying which of two different
 * facts an empty list means.
 */
import { useEffect, useState } from 'react'
import { humanize } from '#/lib/format'
import styles from './ListControls.module.css'

/** Long enough to finish a word, short enough to feel immediate. */
const TYPING_PAUSE_MS = 300

export function SearchBox({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string
  /** What is being searched, in the words of the thing itself. */
  label: string
  placeholder?: string
  value: string | undefined
  onChange: (value: string | undefined) => void
}) {
  const [typed, setTyped] = useState(value ?? '')

  /*
   * The address is the source of truth — a searched view is bookmarkable — so
   * an external change (the back button, a cleared filter) has to reach the
   * field. Comparing before setting avoids fighting the person typing.
   */
  useEffect(() => {
    setTyped((current) => (current === (value ?? '') ? current : (value ?? '')))
  }, [value])

  /*
   * Debounced, because every keystroke is a round trip and a request per letter
   * is both wasteful and slower to settle than one request after the pause.
   */
  useEffect(() => {
    const pending = typed.trim()
    if (pending === (value ?? '')) return
    const timer = setTimeout(() => onChange(pending || undefined), TYPING_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [typed, value, onChange])

  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="search"
        value={typed}
        placeholder={placeholder}
        onChange={(event) => setTyped(event.target.value)}
      />
    </div>
  )
}

export function Pager({
  shown,
  totalCount,
  hasNextPage,
  atStart,
  onFirst,
  onNext,
  pageSize,
}: {
  /** How many rows this page is showing. */
  shown: number
  totalCount: number
  hasNextPage: boolean
  atStart: boolean
  onFirst: () => void
  onNext: () => void
  pageSize: number
}) {
  // Nothing to page through and nowhere to go back to: the count alone would
  // be noise beside a list that is entirely on screen.
  if (atStart && !hasNextPage) {
    return totalCount > 0 ? (
      <div className="pager">
        <span className="pager-count">
          {totalCount} {totalCount === 1 ? 'result' : 'results'}
        </span>
      </div>
    ) : null
  }

  return (
    <div className="pager">
      <span className="pager-count">
        {/*
          Where this page sits is only knowable from the start when paging
          forward with a cursor — there is no page number to count from — so it
          says how many of the total are on screen rather than inventing a
          position it cannot know.
        */}
        {atStart ? `1–${shown} of ${totalCount}` : `${shown} of ${totalCount}, continued`}
      </span>
      <div className="row">
        <button type="button" className="button" disabled={atStart} onClick={onFirst}>
          Start again
        </button>
        <button type="button" className="button" disabled={!hasNextPage} onClick={onNext}>
          Next {pageSize}
        </button>
      </div>
    </div>
  )
}

/**
 * One multi-value dimension as a native listbox.
 *
 * A native `<select multiple>` rather than a custom popover: it is keyboard
 * and screen-reader complete for free, and the URL — not the control — is the
 * record of what is selected. Clearing every option clears the key entirely,
 * so "nothing selected" reads as "no filter", never as "match nothing".
 */
export function MultiSelectFilter<TValue extends string>({
  id,
  label,
  options,
  selected,
  onChange,
  labelOf = humanize,
  size = 4,
}: {
  id: string
  label: string
  options: readonly TValue[]
  selected: TValue[] | undefined
  onChange: (selected: TValue[] | undefined) => void
  /** How an option reads. Defaults to the humanized value. */
  labelOf?: (value: TValue) => string
  size?: number
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {selected?.length ? ` (${selected.length})` : ''}
      </label>
      <select
        id={id}
        multiple
        size={size}
        className={styles.multiSelect}
        value={selected ?? []}
        onChange={(event) => {
          const chosen = Array.from(
            event.target.selectedOptions,
            (option) => option.value as TValue,
          )
          onChange(chosen.length > 0 ? chosen : undefined)
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labelOf(option)}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * What an empty list says.
 *
 * "Nothing matches these filters" and "nothing has happened yet" are different
 * facts with different remedies, and a list that says one when it means the
 * other sends somebody looking for a problem that is not there. The caller
 * decides which it is; offering `onClear` is what puts the one remedy that
 * exists — clearing the filters — on screen.
 */
export function ListEmpty({
  title,
  text,
  onClear,
}: {
  title: string
  text: string
  onClear?: () => void
}) {
  return (
    <div className={styles.empty}>
      <h3 className={styles.emptyTitle}>{title}</h3>
      <p className={styles.emptyText}>{text}</p>
      {onClear ? (
        <button type="button" className={styles.clear} onClick={onClear}>
          Clear the filters
        </button>
      ) : null}
    </div>
  )
}

/** The field layout a single filter uses, for filters that are not a listbox. */
export const filterFieldClass = styles.field
export const filterLabelClass = styles.label
