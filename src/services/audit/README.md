# Audit service

Reading the history of who changed what.

The history has been written since the first release and read by nobody: every
service appends to `core_audit_event` inside the same batch as the change it
describes, and until this service existed the only way to ask was a SQL client.

**This is a read side only.** Nothing here writes an audit row. Each service
writes its own, in the batch that makes the change, which is what makes a change
and its record inseparable.

## What it assumes

- **`AUDIT_READ` is held only by `SUPER_ADMIN`.** This is the most personal read
  in the portal — who did what, from which address, with which browser, across
  every applicant and every member of staff — so the gate is deliberately narrow
  and the service checks it before describing anybody's activity.
- **The history is append-only.** Nothing is edited or removed, so a row
  outlives the account that made it.
- **An actor is optional.** Verified signup and the first-administrator
  bootstrap are trusted system transitions with no operator at all.
- **Roles reported are the roles held now**, not at the time of the event. The
  grant history could answer the second question; a column that sometimes meant
  one and sometimes the other would be worse than one that always means the
  same thing.

## How each operation flows

### `auditEvents` — one page of history

| | |
| --- | --- |
| **Entry** | `audit { events(input:) }` |
| **Guard** | `AUDIT_READ` |
| **Refuses** | a cursor from a different ordering, an inverted date range, more than 50 actors or actions, an id that is not one |
| **Writes** | nothing |
| **Fails** | `You do not have permission to do that.` or `That request could not be understood.` |

Newest first unless asked otherwise. `totalCount` counts the whole matching set
rather than the page, which is what lets a screen say "1–20 of 143" and tell an
empty filter from an empty list.

### `auditActionNames` — what a filter may offer

Reads the recorded history rather than the `auditActions` constant. The constant
says what this version of the code can write; the history holds what *was*
written, including actions from releases since renamed. A filter listing actions
that appear nowhere would be a list of dead ends.

## Scoping, and how each filter stays fast

| Filter | Index it uses |
| --- | --- |
| `actorUserIds` | `core_audit_event_actor_idx` |
| `actorRole` | `core_user_role_grant_role_idx`, through an `EXISTS` |
| `applicationId`, `entityType` | `core_audit_event_entity_idx` |
| `action` | `core_audit_event_action_idx` |
| nothing at all, newest first | `core_audit_event_created_idx` |

That last index was added with this service, and it is the one that mattered:
every other index leads with a filter column, so the unfiltered newest-first
read — the most likely query against the largest table — scanned the table and
sorted it. `(created_at, id)`, because that pair is exactly the keyset cursor,
so the seek and the ordering share one index. A test asserts the query plan
rather than a duration: a timing test on a small fixture passes either way.

`actorRole` is an `EXISTS` rather than a join, because a join multiplies one
actor's events into duplicate rows — silently, and only for people holding more
than one role.

The actor arrives resolved through a left join and a grouped subquery, so a page
of fifty is one query rather than a hundred and one. Left, because an inner join
would hide exactly the events that have no actor.

## A limit worth knowing

**`applicationId` matches events recorded against the application itself.**
Events recorded against one of its documents or submissions carry their own
entity id and will not appear. Widening that means a union over child ids; it is
not built, and this says so rather than letting somebody assume completeness.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `auditEvents` | `controllers/audit.ts` | One page of history, guarded and validated |
| `auditActionNames` | `controllers/audit.ts` | The action names that actually occur |
| `listAuditEvents`, `listAuditActions` | `queries/audit.ts` | The SQL, and the index choices above |
| `MAX_ACTOR_FILTER`, `MAX_ACTION_FILTER` | `queries/audit.ts` | What one request may name |
| `AuditEvent`, `AuditActor`, `AuditFilters`, `AuditConnection`, `AuditOrder` | `types.ts` | The shapes |
| `success`, `failure` | `support.ts` | The envelope, one copy per service |

## Elsewhere

- [Schema](../../db/schema/README.md) — `core_audit_event` and its indexes
- [Fixed-role RBAC](../../../docs/admin-rbac.md) — who holds `AUDIT_READ`
- [Security rules](../../../docs/rules/security.md) — what may never be recorded
