import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { instant, versionedSoftDeleteColumns } from '../shared'

/**
 * The vocabulary of the announcement card, fixed in code like every closed set.
 *
 * An icon travels as a key because a React component cannot cross the wire;
 * the client keeps the key→component map and falls back on an unknown key.
 * A link's kind is what tells the renderer how to treat the target — an
 * external address, a path on this site, or an anchor on the landing page —
 * so the target is never interpreted by guesswork.
 */
export const announcementIcons = [
  'SEEDLING',
  'FILE_TEXT',
  'SHIELD_CHECK',
  'LANDMARK',
  'HELP_CIRCLE',
  'MEGAPHONE',
  'CALENDAR',
  'INDIAN_RUPEE',
] as const
export type AnnouncementIcon = (typeof announcementIcons)[number]

export const announcementLinkKinds = ['EXTERNAL', 'ROUTE', 'ANCHOR'] as const
export type AnnouncementLinkKind = (typeof announcementLinkKinds)[number]

/**
 * One card on the public landing page's announcement banner.
 *
 * Authored by an announcer, shown to everyone: the public read serves only
 * rows that are published, not deleted, and not past their optional end time.
 * Ordering is the announcer's own (`sort_order`), rewritten as a whole list —
 * **deliberately no unique index on `sort_order`**: the reorder renumbers rows
 * in place in one statement, and a unique index would refuse the transient
 * collision of swapping two neighbours. Reads break any tie by
 * `(sort_order, created_at, id)`, so a tie is unambiguous rather than illegal.
 */
export const sebAnnouncement = pgTable(
  'seb_announcement',
  {
    id: text('id').primaryKey(),
    tag: text('tag').notNull(),
    dateLabel: text('date_label'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    icon: text('icon', { enum: announcementIcons }).notNull(),
    linkKind: text('link_kind', { enum: announcementLinkKinds }),
    linkTarget: text('link_target'),
    endsAt: instant('ends_at'),
    published: boolean('published').notNull(),
    sortOrder: integer('sort_order').notNull(),
    ...versionedSoftDeleteColumns((): AnyPgColumn => coreUser.id),
  },
  (table) => [
    check(
      'seb_announcement_icon_check',
      sql`${table.icon} IN ('SEEDLING', 'FILE_TEXT', 'SHIELD_CHECK', 'LANDMARK', 'HELP_CIRCLE', 'MEGAPHONE', 'CALENDAR', 'INDIAN_RUPEE')`,
    ),
    /*
     * Both arms name their null case explicitly: a bare `link_kind IN (…)`
     * with a NULL kind evaluates to NULL, and a CHECK passes on NULL — the
     * constraint would accept a kind with no target and a target with no kind.
     */
    check(
      'seb_announcement_link_check',
      sql`(${table.linkKind} IS NULL AND ${table.linkTarget} IS NULL)
        OR (${table.linkKind} IN ('EXTERNAL', 'ROUTE', 'ANCHOR') AND ${table.linkTarget} IS NOT NULL)`,
    ),
    check('seb_announcement_version_check', sql`${table.currentVersion} >= 1`),
    check('seb_announcement_sort_order_check', sql`${table.sortOrder} >= 1`),
    // The public read's path: live published rows in display order. The end
    // time is filtered at query time — `now` cannot live in an index predicate.
    index('seb_announcement_public_idx')
      .on(table.sortOrder, table.createdAt, table.id)
      .where(sql`deleted_at IS NULL AND published`),
  ],
)

/**
 * The banner's single contention point.
 *
 * Reordering rewrites every live row's `sort_order`, and two writers doing so
 * concurrently touch no common announcement row — a predicate over rows a
 * statement does not write is not a guard. This one row is what both contend
 * for: every reorder quotes its version, and creating or removing a card bumps
 * it too, so a reorder built from a list that has since gained or lost a row
 * is refused as stale rather than silently renumbering the wrong set.
 */
export const sebAnnouncementBoard = pgTable(
  'seb_announcement_board',
  {
    id: text('id').primaryKey(),
    currentVersion: integer('current_version').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    // A closed set of one, written literally like every other closed set.
    check('seb_announcement_board_singleton_check', sql`${table.id} = 'BOARD'`),
    check(
      'seb_announcement_board_version_check',
      sql`${table.currentVersion} >= 1`,
    ),
  ],
)
