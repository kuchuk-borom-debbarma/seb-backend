# Document scanner service

Deciding whether a stored document is safe for staff to open.

The programme needs one thing from a scanner: given an object that has already
been stored, say whether it may be opened and give something a person could
quote when asking why. That is the whole interface, and it names no product.

## Why this service exists at all

Administrative download **fails closed** until an `ACCEPTED` scan result is
recorded against a document version. The mechanism was complete long before this
service: finalization writes a `PENDING` scan at sequence 1, and
`recordDocumentScanResult` appends the outcome.

What was missing was anything that produced an outcome — so **no administrator
could open any document, anywhere**, and the whole review workflow was
undemonstrable. This is the piece that closes that gap without pretending a
scanner exists.

## What it assumes

- **The object is already stored and immutable.** Nothing here uploads, moves or
  deletes anything.
- **Throwing means no conclusion was reached.** The document stays unopenable
  and the work can be retried. A scanner must never resolve `ACCEPTED` for a
  file it could not actually examine.
- **The reference is shown to staff**, so it must never carry a credential or
  an object key.

## Choosing one

`SCANNER_TRANSPORT` picks, exactly as `STORAGE_TRANSPORT` does for storage.

| `SCANNER_TRANSPORT` | Behaviour |
| --- | --- |
| `cloudmersive` | Really examines the file. Needs `CLOUDMERSIVE_API_KEY` |
| `none`, or unset | Accepts without examining, recording `NO_SCANNER_CONFIGURED` and a message saying plainly that the file was not examined |

`production` **refuses `none` at construction**. Anything else refuses too,
rather than falling back — a typo in configuration must not quietly stop
documents being examined.

## The size limit is the scanner's

Cloudmersive's free tier refuses a file over 2.5 MB, and a document the scanner
cannot examine **never becomes openable**, because download fails closed until
an `ACCEPTED` result exists. So `MAX_DOCUMENT_BYTES` in
[`application/uploads.ts`](../application/uploads.ts) is set to 2 MB — below the
provider's limit, with room for the ambiguity in "2.5 MB", so an upload the
scanner would refuse is refused up front where the applicant gets a useful
message instead of a permanently unreadable document.

The client states the same number and `npm run check:document-limit` fails when
the two stop agreeing. **Raising the limit means checking the scanner first.**

## The honesty is the point

**Recording the absence matters as much as the unblocking.** Anybody reading a
document's scan history can tell an unexamined file from a checked one. A
permissive scanner that recorded a clean-looking result would be far more
dangerous than none, because it would read as evidence that something checked.

**Refusing at construction, not at scan time.** A scanner that only failed when
asked would let a production deployment look healthy until the first document
arrived. Failing when it is built is loud and immediate.

`develop` is deliberately permissive: it is a demonstration environment holding
nobody's real evidence, and being unable to open a document there costs more
than it protects.

## How each operation flows

### `scan` — examine one object

| | |
| --- | --- |
| **Entry** | `documentScanner(env).scan(objectKey)` |
| **Refuses** | at construction: `none` in `production`, an unknown transport anywhere, or `cloudmersive` without its key |
| **Writes** | nothing; the caller records the outcome |
| **Fails** | `No malware scanner is configured for the production environment.` |

`cloudmersive` throws rather than concluding whenever it did not get a real
answer — the object could not be read, the provider refused the request, or the
body carried no boolean `CleanResult`. The document stays unopenable and the
queue message is retried. No error quotes the provider's own body, which can
contain the request, and the request carries the key.

### `scanDocumentVersion` — the queued consumer's work

| | |
| --- | --- |
| **Entry** | `scanDocumentVersion(db, env, documentVersionId)` |
| **Guard** | none; it runs from the queue, not from a request |
| **Refuses** | a document version that no longer exists — returns `false` rather than inventing a result |
| **Writes** | one appended scan row, through `recordDocumentScanResult` |

Returns whether a result was recorded. A `false` is not an error to hide: the
document stays unopenable, which is the safe direction, and the message can be
retried. Nothing here logs an object key or a document id.

## What is still missing

**The free tier is small**: roughly 600-800 scans a month, one at a time, North
America only. That is enough for a demonstration and not for an intake round.
Adding another provider means a new file in `transports/` and one line in the
factory; nothing else changes.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `documentScanner` | `index.ts` | The scanner for this environment, or a refusal |
| `NO_SCANNER_REFERENCE` | `transports/permissive.ts` | What an unexamined file is recorded as |
| `DocumentScanner`, `ScanOutcome`, `ScanVerdict` | `types.ts` | The interface and its shapes |
| `permissiveScanner` | `transports/permissive.ts` | Accepts without examining |
| `cloudmersiveScanner` | `transports/cloudmersive.ts` | Examines the bytes with Cloudmersive |
| `CLOUDMERSIVE_SCAN_REFERENCE` | `transports/cloudmersive.ts` | What a real scan is recorded as |
| `scanDocumentVersion` | `consume.ts` | Finds the object, scans it, records the verdict |

## Elsewhere

- [Queue service](../queue/README.md) — how the request arrives
- [Application service](../application/README.md) — where the `PENDING` scan is
  written, at finalization
- [Admin service](../admin/README.md) — the fail-closed download that depends on
  the result
