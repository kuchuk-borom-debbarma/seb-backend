/**
 * The activity history's filters.
 *
 * Every control here is one the API accepts, and every choice lands in the URL
 * — so a view can be bookmarked or sent on, and the export takes exactly the
 * rows on screen. Three filters are about people and ask different questions,
 * so a person is added *as* one of them: what they did, what was done to them,
 * or their whole history.
 *
 * Some filters arrive only by link — one record's history from its own screen,
 * one request's events from an entry. There is no box to type a record id into,
 * because nobody has one to type; those show as chips that can be removed.
 */
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import {
  MultiSelectFilter,
  filterFieldClass,
  filterLabelClass,
} from '#/components/ListControls'
import { rolesQuery } from '#/features/roles/roleQueries'
import { humanize } from '#/lib/format'
import { messageFor } from '#/lib/result'
import {
  AUDIT_CATEGORIES,
  auditActionsQuery,
  auditPeopleQuery,
  findAuditPerson,
  type AuditSearch,
} from './auditQueries'
import styles from './Audit.module.css'

/**
 * The one authority filtered by name rather than by row.
 *
 * Everything else the office holds is a role somebody composed, read live from
 * the API. A list written here would go stale the moment one was added, and a
 * filter that silently offered the wrong names is worse than none.
 */
const SUPER_ADMINISTRATOR = 'SUPER_ADMIN'

type PersonRole = 'actor' | 'subject' | 'involving'

const PERSON_ROLES: { value: PersonRole; label: string }[] = [
  { value: 'actor', label: 'What they did' },
  { value: 'subject', label: 'What was done to them' },
  { value: 'involving', label: 'Their whole history' },
]

/** A removable chip for a filter that is on but has no control of its own. */
function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className={styles.chip}>
      {label}
      <button type="button" aria-label={`Remove: ${label}`} onClick={onRemove}>
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  )
}

/** Adds a person by whole address, resolved to the id the filter holds. */
function PersonPicker({ onAdd }: { onAdd: (role: PersonRole, id: string) => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<PersonRole>('involving')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className={styles.personFilters}
      onSubmit={async (submitted) => {
        submitted.preventDefault()
        setBusy(true)
        setProblem(null)
        try {
          const found = await findAuditPerson(email.trim())
          const person = found.success ? found.response?.[0] : undefined
          // One sentence for "no such account" and for a refusal alike: this
          // is a lookup by whole address, and it either names somebody or not.
          if (!person) setProblem(found.message ?? 'No account has that address.')
          else {
            onAdd(role, person.id)
            setEmail('')
          }
        } catch (error) {
          setProblem(messageFor(error))
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className={filterFieldClass}>
        <label className={filterLabelClass} htmlFor="audit-person">
          Person (whole email address)
        </label>
        <input
          id="audit-person"
          className="input"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className={filterFieldClass}>
        <label className={filterLabelClass} htmlFor="audit-person-role">
          Show
        </label>
        <select
          id="audit-person-role"
          className="select"
          value={role}
          onChange={(event) => setRole(event.target.value as PersonRole)}
        >
          {PERSON_ROLES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="button" disabled={busy}>
        {busy ? 'Finding…' : 'Add person'}
      </button>
      {problem ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  )
}

export function AuditFilters({
  search,
  filter,
  onClear,
}: {
  search: AuditSearch
  /** Applies a change; the caller also drops the cursor. */
  filter: (change: Partial<AuditSearch>) => void
  onClear?: () => void
}) {
  const { data: actions } = useQuery(auditActionsQuery)
  const composedRoles = useQuery(rolesQuery)
  const peopleIds = [
    ...(search.actor ?? []),
    ...(search.subject ?? []),
    ...(search.involving ? [search.involving] : []),
  ]
  const { data: people } = useQuery(auditPeopleQuery(peopleIds))
  const emailOf = (id: string) =>
    people?.find((person) => person.id === id)?.email ?? 'An account'

  // The recorded actions, grouped under the categories they belong to.
  const grouped = AUDIT_CATEGORIES.map((category) => ({
    category,
    actions: (actions ?? []).filter((action) => action.category === category),
  })).filter((group) => group.actions.length > 0)

  const chosenAction = search.actions?.length === 1 ? search.actions[0] : ''

  return (
    <div className="stack">
      <PersonPicker
        onAdd={(role, id) =>
          role === 'involving'
            ? filter({ involving: id })
            : filter({ [role]: [...new Set([...(search[role] ?? []), id])] })
        }
      />

      <div
        className={styles.chips}
        aria-label="People and records this view is narrowed to"
      >
        {(search.actor ?? []).map((id) => (
          <Chip
            key={`actor-${id}`}
            label={`Done by ${emailOf(id)}`}
            onRemove={() =>
              filter({ actor: search.actor?.filter((other) => other !== id) })
            }
          />
        ))}
        {(search.subject ?? []).map((id) => (
          <Chip
            key={`subject-${id}`}
            label={`Done to ${emailOf(id)}`}
            onRemove={() =>
              filter({ subject: search.subject?.filter((other) => other !== id) })
            }
          />
        ))}
        {search.involving ? (
          <Chip
            label={`Everything about ${emailOf(search.involving)}`}
            onRemove={() => filter({ involving: undefined })}
          />
        ) : null}
        {search.application ? (
          <Chip
            label="One application"
            onRemove={() => filter({ application: undefined })}
          />
        ) : null}
        {search.types || search.entity ? (
          <Chip
            label={`${(search.types ?? []).map(humanize).join(', ') || 'A record'}${search.entity ? ' · one record' : ''}`}
            onRemove={() => filter({ types: undefined, entity: undefined })}
          />
        ) : null}
        {search.request ? (
          <Chip label="One request" onRemove={() => filter({ request: undefined })} />
        ) : null}
      </div>

      <div className="filters">
        <MultiSelectFilter
          id="audit-kinds"
          label="Kind of activity"
          options={AUDIT_CATEGORIES}
          selected={search.kinds}
          onChange={(kinds) => filter({ kinds })}
        />

        <div>
          <label className="field-label" htmlFor="audit-action">
            Action
          </label>
          <select
            id="audit-action"
            className="select"
            value={chosenAction}
            onChange={(event) =>
              filter({ actions: event.target.value ? [event.target.value] : undefined })
            }
          >
            <option value="">
              {(search.actions?.length ?? 0) > 1
                ? `${search.actions?.length} actions`
                : 'Any action'}
            </option>
            {grouped.map((group) => (
              <optgroup key={group.category} label={humanize(group.category)}>
                {group.actions.map((action) => (
                  <option key={action.action} value={action.action}>
                    {action.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="audit-role">
            Done by
          </label>
          <select
            id="audit-role"
            className="select"
            value={search.actorRole ?? ''}
            onChange={(event) => filter({ actorRole: event.target.value || undefined })}
          >
            <option value="">Anybody</option>
            <option value={SUPER_ADMINISTRATOR}>
              Anybody who is a super administrator
            </option>
            {(composedRoles.data?.response ?? []).map((role) => (
              <option key={role.key} value={role.key}>
                Anybody holding {role.name}
              </option>
            ))}
          </select>
          {/*
            Reading the history and reading the roles are separate permissions,
            so this list can legitimately be refused to somebody who may read
            everything here. Said out loud, because the alternative is a filter
            that quietly offers two options and looks complete.
          */}
          {composedRoles.data && !composedRoles.data.success ? (
            <span className="field-hint">
              The roles the office composed are not listed here — that needs permission to
              read them.
            </span>
          ) : null}
        </div>

        <div>
          <label className="field-label" htmlFor="audit-reference">
            Application reference
          </label>
          {/* Exact, not a prefix: applied when the whole reference is typed. */}
          <input
            id="audit-reference"
            className="input"
            key={`reference-${search.reference ?? ''}`}
            defaultValue={search.reference ?? ''}
            placeholder="Whole reference"
            onBlur={(event) =>
              filter({ reference: event.target.value.trim() || undefined })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter')
                filter({ reference: event.currentTarget.value.trim() || undefined })
            }}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="audit-since">
            From
          </label>
          <input
            id="audit-since"
            className="input"
            type="date"
            value={search.since ?? ''}
            onChange={(event) => filter({ since: event.target.value || undefined })}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="audit-until">
            To
          </label>
          <input
            id="audit-until"
            className="input"
            type="date"
            value={search.until ?? ''}
            onChange={(event) => filter({ until: event.target.value || undefined })}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="audit-outcome">
            Outcome
          </label>
          <select
            id="audit-outcome"
            className="select"
            value={search.outcome ?? ''}
            onChange={(event) =>
              filter({
                outcome: (event.target.value || undefined) as AuditSearch['outcome'],
              })
            }
          >
            <option value="">Any outcome</option>
            <option value="SUCCESS">Succeeded</option>
            <option value="FAILURE">Failed</option>
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="audit-order">
            Order
          </label>
          <select
            id="audit-order"
            className="select"
            value={search.oldest ? 'oldest' : 'newest'}
            onChange={(event) =>
              filter({ oldest: event.target.value === 'oldest' ? true : undefined })
            }
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      {onClear ? (
        <div>
          <button type="button" className="button" data-variant="ghost" onClick={onClear}>
            Clear the filters
          </button>
        </div>
      ) : null}
    </div>
  )
}
