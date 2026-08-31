/**
 * Drizzle persistence for the announcement banner.
 *
 * Every write is one guarded statement plus dependents that re-state the
 * guard. The dependents cannot read the guarded write's result, so each one
 * proves it landed with the same `(version, updated_at = now)` pair the write
 * stamped — the version alone is true whenever the row was *already* there
 * (see `services/admin/support.ts` at `headJustMovedTo` for the incident).
 *
 * The board row is the reorder's real guard: two reorders touch no common
 * announcement row, so they contend on this one row instead, and create and
 * remove bump it too — a reorder built from a list that has since gained or
 * lost a card is refused as stale rather than renumbering the wrong set.
 */
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { batch, changedExactlyOne, type Database, type Transaction } from '../../../db'
import {
  coreAuditEvent,
  sebAnnouncement,
  sebAnnouncementBoard,
} from '../../../db/schema'
import { MAX_ANNOUNCEMENT_ROWS } from '../support'
import type {
  AdminAnnouncement,
  AnnouncementFieldsInput,
  AnnouncementLink,
  AnnouncementRow,
  PublicAnnouncement,
} from '../types'

const linkOf = (row: AnnouncementRow): AnnouncementLink | null =>
  row.linkKind !== null && row.linkTarget !== null
    ? { kind: row.linkKind, target: row.linkTarget }
    : null

const toAdminAnnouncement = (row: AnnouncementRow): AdminAnnouncement => ({
  id: row.id,
  tag: row.tag,
  dateLabel: row.dateLabel,
  title: row.title,
  body: row.body,
  icon: row.icon,
  link: linkOf(row),
  endsAt: row.endsAt,
  published: row.published,
  sortOrder: row.sortOrder,
  currentVersion: row.currentVersion,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

// Ties on sort_order are legal (racing creates may mint the same number), so
// the two later keys make the display order deterministic rather than lucky.
const displayOrder = [
  asc(sebAnnouncement.sortOrder),
  asc(sebAnnouncement.createdAt),
  asc(sebAnnouncement.id),
]

/** What the landing page shows: published, not removed, not past its end. */
export const readPublicAnnouncements = async (
  db: Database,
  now: Date,
): Promise<PublicAnnouncement[]> => {
  const rows = await db
    .select()
    .from(sebAnnouncement)
    .where(and(
      isNull(sebAnnouncement.deletedAt),
      eq(sebAnnouncement.published, true),
      or(isNull(sebAnnouncement.endsAt), gt(sebAnnouncement.endsAt, now)),
    ))
    .orderBy(...displayOrder)
    .limit(MAX_ANNOUNCEMENT_ROWS)
  return rows.map((row) => ({
    id: row.id,
    tag: row.tag,
    dateLabel: row.dateLabel,
    title: row.title,
    body: row.body,
    icon: row.icon,
    link: linkOf(row),
  }))
}

/** The whole board as the office sees it, drafts and expired cards included. */
export const readBoard = async (
  db: Database,
): Promise<{ boardVersion: number; announcements: AdminAnnouncement[] }> => {
  const [boardRows, announcementRows] = await batch(db, (tx) => [
    tx.select().from(sebAnnouncementBoard).where(eq(sebAnnouncementBoard.id, 'BOARD')),
    tx
      .select()
      .from(sebAnnouncement)
      .where(isNull(sebAnnouncement.deletedAt))
      .orderBy(...displayOrder)
      .limit(MAX_ANNOUNCEMENT_ROWS),
  ])
  const board = (boardRows as (typeof sebAnnouncementBoard.$inferSelect)[])[0]
  return {
    // The row is seeded by migration and by every schema bootstrap; absence
    // would mean a database built outside those paths, and 1 is what the seed
    // says, so a read never invents state a write did not record.
    boardVersion: board?.currentVersion ?? 1,
    announcements: (announcementRows as AnnouncementRow[]).map(toAdminAnnouncement),
  }
}

export const findAnnouncement = async (
  db: Database,
  id: string,
): Promise<AdminAnnouncement | null> => {
  const [row] = await db
    .select()
    .from(sebAnnouncement)
    .where(and(eq(sebAnnouncement.id, id), isNull(sebAnnouncement.deletedAt)))
    .limit(1)
  return row ? toAdminAnnouncement(row) : null
}

/** The live ids, for the reorder's set-equality check. */
export const listLiveAnnouncementIds = async (db: Database): Promise<string[]> => {
  const rows = await db
    .select({ id: sebAnnouncement.id })
    .from(sebAnnouncement)
    .where(isNull(sebAnnouncement.deletedAt))
    .limit(MAX_ANNOUNCEMENT_ROWS)
  return rows.map((row) => row.id)
}

/** The audit insert, re-stating the caller's guard. All 12 columns, in order. */
const guardedAudit = (
  tx: Transaction,
  audit: typeof coreAuditEvent.$inferInsert,
  guard: ReturnType<typeof sql>,
) => tx.insert(coreAuditEvent).select(sql`
  SELECT ${audit.id}, ${audit.actorUserId}, ${audit.action},
    ${audit.entityType}, ${audit.entityId}, ${audit.outcome},
    ${audit.requestId ?? null}, ${audit.ipAddress ?? null},
    ${audit.userAgent ?? null}, NULL, ${audit.metadataJson ?? null},
    ${audit.createdAt}
  WHERE ${guard}
`)

/** The row the write just produced, identified by version *and* instant. */
const announcementJustMovedTo = (
  id: string,
  version: number,
  now: Date,
): ReturnType<typeof sql> => sql`EXISTS (
  SELECT 1 FROM ${sebAnnouncement}
  WHERE ${sebAnnouncement.id} = ${id}
    AND ${sebAnnouncement.currentVersion} = ${version}
    AND ${sebAnnouncement.updatedAt} = ${now}
)`

export const createAnnouncement = async (
  db: Database,
  input: {
    id: string
    fields: {
      tag: string
      dateLabel: string | null
      title: string
      body: string
      icon: AnnouncementFieldsInput['icon']
      link: AnnouncementLink | null
      endsAt: Date | null
      published: boolean
    }
    now: Date
    audit: typeof coreAuditEvent.$inferInsert
  },
): Promise<boolean> => {
  const { id, fields, now, audit } = input
  /*
   * The insert computes its own position, in the same statement that reads
   * the current maximum — a value read beforehand could be stale by the time
   * it lands. Two racing creates can still mint the same number; a tie is a
   * legal state the display order resolves, not a conflict to refuse.
   */
  const insertRow = (tx: Transaction) => tx.insert(sebAnnouncement).select(sql`
    SELECT ${id}, ${fields.tag}, ${fields.dateLabel}, ${fields.title},
      ${fields.body}, ${fields.icon}, ${fields.link?.kind ?? null},
      ${fields.link?.target ?? null}, ${fields.endsAt},
      ${fields.published}::boolean,
      COALESCE((SELECT MAX(${sebAnnouncement.sortOrder}) FROM ${sebAnnouncement}
        WHERE ${sebAnnouncement.deletedAt} IS NULL), 0) + 1,
      1, ${now}, ${now}, NULL, NULL, NULL
  `).returning({ id: sebAnnouncement.id })
  const created = announcementJustMovedTo(id, 1, now)
  // A new card changes what a reorder's id list must contain, so the board
  // moves with it and an in-flight reorder is refused as stale.
  const bumpBoard = (tx: Transaction) => tx
    .update(sebAnnouncementBoard)
    .set({
      currentVersion: sql`${sebAnnouncementBoard.currentVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(sebAnnouncementBoard.id, 'BOARD'), created))
  const [changed] = await batch(db, (tx) => [
    insertRow(tx),
    bumpBoard(tx),
    guardedAudit(tx, audit, created),
  ])
  return changedExactlyOne(changed)
}

const applyFieldUpdate = async (
  db: Database,
  input: {
    id: string
    expectedVersion: number
    set: Partial<typeof sebAnnouncement.$inferInsert>
    now: Date
    audit: typeof coreAuditEvent.$inferInsert
    /** Whether this change alters the live id set a reorder quotes. */
    bumpBoard: boolean
  },
): Promise<boolean> => {
  const { id, expectedVersion, set, now, audit } = input
  const moved = announcementJustMovedTo(id, expectedVersion + 1, now)
  const updateRow = (tx: Transaction) => tx
    .update(sebAnnouncement)
    .set({ ...set, currentVersion: expectedVersion + 1, updatedAt: now })
    .where(and(
      eq(sebAnnouncement.id, id),
      eq(sebAnnouncement.currentVersion, expectedVersion),
      isNull(sebAnnouncement.deletedAt),
    ))
    .returning({ id: sebAnnouncement.id })
  const bumpBoard = (tx: Transaction) => tx
    .update(sebAnnouncementBoard)
    .set({
      currentVersion: sql`${sebAnnouncementBoard.currentVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(sebAnnouncementBoard.id, 'BOARD'), moved))
  const [changed] = await batch(db, (tx) => [
    updateRow(tx),
    ...(input.bumpBoard ? [bumpBoard(tx)] : []),
    guardedAudit(tx, audit, moved),
  ])
  return changedExactlyOne(changed)
}

export const updateAnnouncement = (
  db: Database,
  input: {
    id: string
    expectedVersion: number
    fields: {
      tag: string
      dateLabel: string | null
      title: string
      body: string
      icon: AnnouncementFieldsInput['icon']
      link: AnnouncementLink | null
      endsAt: Date | null
      published: boolean
    }
    now: Date
    audit: typeof coreAuditEvent.$inferInsert
  },
): Promise<boolean> =>
  applyFieldUpdate(db, {
    id: input.id,
    expectedVersion: input.expectedVersion,
    set: {
      tag: input.fields.tag,
      dateLabel: input.fields.dateLabel,
      title: input.fields.title,
      body: input.fields.body,
      icon: input.fields.icon,
      linkKind: input.fields.link?.kind ?? null,
      linkTarget: input.fields.link?.target ?? null,
      endsAt: input.fields.endsAt,
      published: input.fields.published,
    },
    now: input.now,
    audit: input.audit,
    // Editing a card neither adds nor removes one, so a concurrent reorder's
    // id list is still honest and need not be invalidated.
    bumpBoard: false,
  })

export const setAnnouncementPublished = (
  db: Database,
  input: {
    id: string
    expectedVersion: number
    published: boolean
    now: Date
    audit: typeof coreAuditEvent.$inferInsert
  },
): Promise<boolean> =>
  applyFieldUpdate(db, {
    id: input.id,
    expectedVersion: input.expectedVersion,
    set: { published: input.published },
    now: input.now,
    audit: input.audit,
    bumpBoard: false,
  })

export const removeAnnouncement = (
  db: Database,
  input: {
    id: string
    expectedVersion: number
    reason: string
    actorUserId: string
    now: Date
    audit: typeof coreAuditEvent.$inferInsert
  },
): Promise<boolean> =>
  applyFieldUpdate(db, {
    id: input.id,
    expectedVersion: input.expectedVersion,
    set: {
      deletedAt: input.now,
      deletedByUserId: input.actorUserId,
      deleteReason: input.reason,
    },
    now: input.now,
    audit: input.audit,
    // Removal shrinks the live id set, so any reorder in flight quotes a list
    // that is no longer true and must go stale.
    bumpBoard: true,
  })

export const reorderAnnouncements = async (
  db: Database,
  input: {
    ids: string[]
    expectedBoardVersion: number
    now: Date
    audit: typeof coreAuditEvent.$inferInsert
  },
): Promise<boolean> => {
  const { ids, expectedBoardVersion, now, audit } = input
  const boardMoved = sql`EXISTS (
    SELECT 1 FROM ${sebAnnouncementBoard}
    WHERE ${sebAnnouncementBoard.id} = 'BOARD'
      AND ${sebAnnouncementBoard.currentVersion} = ${expectedBoardVersion + 1}
      AND ${sebAnnouncementBoard.updatedAt} = ${now}
  )`
  const claimBoard = (tx: Transaction) => tx
    .update(sebAnnouncementBoard)
    .set({ currentVersion: expectedBoardVersion + 1, updatedAt: now })
    .where(and(
      eq(sebAnnouncementBoard.id, 'BOARD'),
      eq(sebAnnouncementBoard.currentVersion, expectedBoardVersion),
    ))
    .returning({ id: sebAnnouncementBoard.id })
  /*
   * Every position lands in one statement — per-row moves would be several
   * writes that must all land or none, on rows another announcer may be
   * editing. Positions come from array order, the same contract the form
   * editor's stages use.
   */
  const positions = sql.join(
    ids.map((id, index) => sql`(${id}, ${index + 1})`),
    sql`, `,
  )
  const renumber = (tx: Transaction) => tx.execute(sql`
    UPDATE ${sebAnnouncement} SET sort_order = v.position::int, updated_at = ${now}
    FROM (VALUES ${positions}) AS v(id, position)
    WHERE ${sebAnnouncement.id} = v.id
      AND ${sebAnnouncement.deletedAt} IS NULL
      AND ${boardMoved}
  `)
  const [claimed] = await batch(db, (tx) => [
    claimBoard(tx),
    renumber(tx),
    guardedAudit(tx, audit, boardMoved),
  ])
  return changedExactlyOne(claimed)
}
