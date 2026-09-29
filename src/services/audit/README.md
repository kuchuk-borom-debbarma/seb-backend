# Audit service

Reading the history of who changed what — and taking a copy of it.

Every service appends to `core_audit_event` inside the same batch as the change
it describes, which is what makes a change and its record inseparable. This
service is how that history is read: filtered, explained in plain words, and —
for a reader allowed to — exported.

**It writes exactly one kind of row: its own export.** Every other row is
written by the service whose change it records.

## What a row says

Each action declares what it records in
[`services/audit-vocabulary`](../audit-vocabulary/): a strict payload schema,
a label per field, who the event is about, whether it belongs to an
application, and a one-sentence summary. A sign-up records the address it was
for; a decision records its outcome and the approved amount; a grant records the
person, the role, the route and the operator's reason. The row builder in
[`audit-event.ts`](../audit-event.ts) parses every payload against its schema
before writing, so a row either says what its action declares or is not written
— and neither is the change it records.

Rows written before actions declared their payloads (`payload_version` 0) are
shown **exactly as they were stored**, key by key, and say so. Restating old
evidence in the new shape would be the history editing itself.

## What it assumes

- **`audit`/`read` is a permission the office grants deliberately.** This is the
  most personal read in the portal — who did what, from which address, with
  which browser, across every applicant and every member of staff.
- **`audit`/`export` is granted even more deliberately**, and only together with
  `audit`/`read`: a copy outlives every permission that allowed it.
- **The history is append-only.** Nothing is edited or removed, so a row
  outlives the account that made it.
- **An actor is optional.** Verified signup, the first-administrator bootstrap
  and the scheduled handlers have no operator at all.
- **Roles reported are the roles held now**, not at the time of the event. The
  grant history answers the other question; a column that sometimes meant one
  and sometimes the other would be worse than one that always means the same.

## How each operation flows

Every operation establishes authority first — before validating, before
reading — so a refusal never tells an unauthorized caller anything about what
they asked for.

### `auditEvents` — one page of history

| | |
| --- | --- |
| **Entry** | `audit { events(input: { first, after, order, filter }) }` |
| **Guard** | `audit` / `read` |
| **Refuses** | a cursor from another ordering or direction, an inverted date range, more than 50 people, actions or 20 entity types, an id that is not one |
| **Writes** | nothing |
| **Costs** | three statements whatever the page size: rows, total, and one folded read naming every person, role, application, enterprise and cycle on the page |

`totalCount` counts the whole matching set rather than the page, which is what
lets a screen say "1–20 of 143" and tell an empty filter from an empty history.

### `auditEvent` — one entry, with its request

The entry, and every other entry with the same request id **within ten minutes
of it**, at most fifty. The window is deliberate: where Cloudflare's `CF-Ray` is
absent the request id is the caller's own `X-Request-ID`, which anybody can
repeat, and without a bound one reused header would link somebody's event to
every other event ever sent with it.

### `auditPeople` — the person filter

One whole address, or the ids a bookmarked view already holds. Exact match
only, like `access.userByEmail`, so it cannot list accounts; it exists so a
reader who may read the history but not administer people can still filter by
somebody.

### `auditActionNames` — what a filter may offer

The action names that actually occur, each labelled and categorized from the
vocabulary. Read from the history rather than the vocabulary on purpose: the
vocabulary says what this build can write, and the history holds what *was*
written, including names since renamed — which read as category `OTHER`.

### `exportAuditEvents` — a copy, recorded

| | |
| --- | --- |
| **Entry** | `mutation { audit { exportEvents(input: { filter, purpose }) } }` |
| **Guard** | `audit` / `export` **and** `audit` / `read` |
| **Refuses** | no purpose, any filter the page would refuse |
| **Writes** | one `AUDIT.EXPORTED` row: who, the filter as applied, the row count, whether it was cut, and the purpose |
| **Limits** | 10,000 rows per file; five exports a minute per session |

**There is no export without its record.** The row is written before the file
is returned, and if it cannot be written no file is. Cells a spreadsheet would
read as a formula — anything starting `=`, `+`, `-`, `@`, tab or carriage
return — are prefixed with an apostrophe, because several cells hold text
somebody else chose: a User-Agent header, an operator's reason.

## Filtering, and the index each filter uses

| Filter | Index |
| --- | --- |
| nothing at all, newest first | `core_audit_event_created_idx` |
| `actorUserIds` | `core_audit_event_actor_idx` |
| `subjectUserIds` | `core_audit_event_subject_idx` (partial) |
| `involvingUserId` | the actor and subject indexes, or a walk of the created index for a common person — the planner chooses |
| `applicationId`, `applicationReference` | `core_audit_event_application_idx` (partial); the reference is resolved in the same statement through `seb_application_reference_search_idx` |
| `categories`, `actions` | `core_audit_event_action_idx` — a category is expanded to its actions |
| `entityTypes`, `entityId` | `core_audit_event_entity_idx` |
| `requestId` | `core_audit_event_request_idx` |
| `actorRole` | an `EXISTS` over the grant table |

`applicationId` now means **everything that happened to the application** — its
documents, review, bank referral, decision and money — because every such row
carries the application's id. `actorRole` is an `EXISTS` rather than a join,
because a join multiplies one actor's events into duplicate rows, silently, and
only for people holding more than one role.

## Measured

At 100,000 rows on PostgreSQL 16, `EXPLAIN (ANALYZE, BUFFERS)` twenty times per
query, with the actor, subject and both people's current roles resolved as the
page resolves them:

| Operation | p50 | p95 | Budget |
| --- | --- | --- | --- |
| Unfiltered page of 50 | 4.8 ms | 6.0 ms | 10 ms |
| One application's page | 4.1 ms | 4.8 ms | 5 ms |
| One person's page (as subject) | 4.1 ms | 5.2 ms | 5 ms |
| One person's whole history | 4.8 ms | 5.5 ms | 15 ms |
| One category | 4.5 ms | 5.3 ms | 10 ms |
| Total, unfiltered | 9.3 ms | 15.0 ms | 40 ms |
| Naming 50 references | 0.3 ms | 0.4 ms | 3 ms |
| The recorded action names | 1.1 ms | 2.0 ms | 3 ms |
| An export's read of 10,001 rows | 254 ms | 291 ms | 400 ms |

The subject page is 0.2 ms over its budget at p95; the cost is the two
correlated role reads per row, not the seek. The two new partial indexes add
about 0.015 ms to each audited write, measured as ten thousand inserts that fill
both columns. `test/service/audit.test.ts` holds the *plans* to this at the same
size in CI — timings on a CI fixture would pass whether or not an index is used.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `auditEvents`, `auditEvent`, `auditPeople`, `auditActionNames`, `exportAuditEvents` | `controllers/audit.ts` | Guarded, validated operations |
| `listAuditEvents`, `findAuditRow`, `listSameRequestRows`, `exportAuditRows`, `resolveReferences`, `listRecordedActions`, `findAuditPeople` | `queries/audit.ts` | The SQL, and the index choices above |
| `presentAuditEvent`, `referencesWanted`, `humanize` | `present.ts` | A row, read: labels, names, a sentence |
| `auditCsv`, `csvCell` | `csv.ts` | The file, and its formula guard |
| `AuditEvent`, `AuditFilter`, `AuditDetail`, `AuditReference`, … | `types.ts` | The shapes |

## Elsewhere

- [Audit vocabulary](../audit-vocabulary/) — what each action records
- [Schema](../../db/schema/README.md) — `core_audit_event`, its two generations and its indexes
- [Roles and permissions](../../../docs/admin-rbac.md) — `audit`/`read` and `audit`/`export`
- [Security rules](../../../docs/rules/security.md) — what a row may and may not carry
