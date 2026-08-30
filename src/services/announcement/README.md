# Announcement service

## What this is for

The public landing page's announcement banner. Announcers author cards — a
tag chip, a headline, a sentence or two, one of eight pictograms, an optional
link, an optional end time, a hidden/draft toggle — and arrange their order;
everyone, signed in or not, reads the published result. The admin surface and
the public read live in one service so the write guards and the read
predicate cannot drift apart.

## What it assumes

- The board row exists. Migration `0002_announcement-banner` seeds it on the
  deployed database, and every path that builds a database from
  `database/schema.sql` runs the same statement from
  [`scripts/board-seed.mjs`](../../../scripts/board-seed.mjs) — reads never
  create it, because a public read must stay a read.
- Who may write is decided in
  [`auth/capabilities.ts`](../auth/capabilities.ts): the `ANNOUNCE`
  capability, held by `ANNOUNCER` and (through the spread) `SUPER_ADMIN`.
  Nothing here names a role.
- A card's `sort_order` is not unique. The reorder renumbers rows in place in
  one statement, and a unique index would refuse the transient collision of
  swapping neighbours; ties are legal (racing creates may mint the same
  number) and reads break them by `(sort_order, created_at, id)`.
- An announcer-authored link is rendered as an `href` on the public landing
  page. `validateAnnouncementLink` in [`support.ts`](support.ts) is where
  `javascript:`, `data:` and protocol-relative paths die: an external target
  must parse to `http:`/`https:` and is stored **re-serialized** by the
  parser; a site path must start with a single `/`; an anchor with `#`.

## How each operation flows

| | `public.announcementBanner` |
| --- | --- |
| **Entry** | `publicAnnouncementBanner` — the portal's one unauthenticated read besides `health`; its whole trust basis is the header of [`controllers/public.ts`](controllers/public.ts) |
| **Guard** | none, deliberately |
| **Refuses** | nothing — an empty banner is an ordinary answer |
| **Reads** | published, non-deleted rows not past `ends_at`, in display order, capped |

| | `admin.announcement.board` |
| --- | --- |
| **Entry** | `announcementBoard` |
| **Guard** | `ANNOUNCE` |
| **Refuses** | a caller without the capability |
| **Reads** | the board version and every non-deleted card, one batch |

| | `create` |
| --- | --- |
| **Entry** | `createAnnouncementController` |
| **Guard** | `ANNOUNCE`, then each field against its cap, then the link validator |
| **Refuses** | a blank or over-cap field by name; a link whose target does not fit its kind |
| **Writes** | the card (its position computed from the live maximum in the same statement), a board bump, and the audit row — one batch |
| **Guarded by** | the dependents' `EXISTS` on the row at `(version 1, updated_at = now)` |
| **Fails** | "The record changed. Reload and try again." |

| | `update` / `setPublished` |
| --- | --- |
| **Entry** | `updateAnnouncementController` / `setAnnouncementPublishedController` |
| **Guard** | `ANNOUNCE`, an integer `expectedVersion ≥ 1`, the field/link checks (`update`) or the reason cap (`setPublished`) |
| **Refuses** | a stale version, an unknown id and a removed card with one answer — distinguishing them would say which ids exist |
| **Writes** | the guarded row update and its audit row; **no board bump** — editing neither adds nor removes a card, so a concurrent reorder's list stays honest |
| **Guarded by** | `current_version = expected` in the `WHERE`; audit re-states `(expected + 1, updated_at = now)` |
| **Fails** | the stale message above |

| | `remove` |
| --- | --- |
| **Entry** | `removeAnnouncementController` |
| **Guard** | `ANNOUNCE`, integer version, a required reason |
| **Refuses** | a missing reason; a second removal as stale |
| **Writes** | the soft delete (retaining who and why), a board bump, the audit row — one batch; returns the fresh board |
| **Guarded by** | same per-row version-and-instant pair |
| **Fails** | the stale message |

| | `reorder` |
| --- | --- |
| **Entry** | `reorderAnnouncementsController` |
| **Guard** | `ANNOUNCE`, integer board version, non-empty duplicate-free id list, set-equality with the live ids |
| **Refuses** | a list that misses, repeats or invents a card ("The board changed…"); a stale `expectedBoardVersion` |
| **Writes** | the guarded board claim, then every position in one `UPDATE … FROM (VALUES …)`, then the audit row |
| **Guarded by** | the board row — two reorders touch no common card row, so a predicate over the cards would be no guard at all; creating or removing a card bumps the same row, which is what makes an outdated list refuse rather than renumber the wrong set |
| **Fails** | stale or board-mismatch, as above |

## Every export

| Symbol | File | One line |
| --- | --- | --- |
| `publicAnnouncementBanner` | `controllers/public.ts` | The unauthenticated banner read |
| `announcementBoard` | `controllers/admin.ts` | The board with its reorder version |
| `createAnnouncementController` | `controllers/admin.ts` | Authors a card at the end of the order |
| `updateAnnouncementController` | `controllers/admin.ts` | Replaces everything a card says |
| `setAnnouncementPublishedController` | `controllers/admin.ts` | The Live/Hidden quick toggle |
| `removeAnnouncementController` | `controllers/admin.ts` | Soft-deletes a card, returns the fresh board |
| `reorderAnnouncementsController` | `controllers/admin.ts` | Rewrites the whole display order |
| `currentAnnouncer` | `support.ts` | The capability gate |
| `validateAnnouncementLink` | `support.ts` | Decides whether a link may ever become an `href` |
| `announcementAudit` | `support.ts` | This service's audit-row builder |
| query functions | `queries/announcement.ts` | All SQL, and every guard repeated inside the write predicate |

## Elsewhere

- The tables and their constraints: [`db/schema/seb/announcement.ts`](../../db/schema/seb/announcement.ts)
- Who holds `ANNOUNCE`, and who may create announcers: [`docs/admin-rbac.md`](../../../docs/admin-rbac.md)
- The guarded-write shape and why guards are repeated in SQL: [`docs/rules/code.md`](../../../docs/rules/code.md)
- The client that renders the banner and the authoring screen: `dev-web/`
