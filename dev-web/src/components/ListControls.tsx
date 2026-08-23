/**
 * The two controls every list on this site needs.
 *
 * `SearchBox` is labelled "Starts with", not "Search". The API matches an
 * indexed prefix — that is what makes it a seek rather than a scan of the whole
 * table — and a box labelled "Search" that silently means "starts with" would
 * be a lie somebody discovers by typing a word from the middle of a name and
 * getting nothing.
 *
 * `Pager` reports the total, so a page says where it is in the set rather than
 * offering a Next button and no sense of how much is left.
 */
import { useEffect, useState } from 'react'

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
