/**
 * The announcer's side of the banner: authoring, ordering, withdrawing.
 *
 * Every operation is capability-gated (`ANNOUNCE` — held by announcers, and by
 * super administrators through the capability spread) and every write is
 * optimistic: per-card edits quote the card's version, and the reorder quotes
 * the board's, because two reorders touch no common card row and need one row
 * they both contend for.
 */
import { auditActions } from '../../../db/schema'
import { failure, success } from '../../envelope'
import { normalizeOptionalText, normalizeRequiredText } from '../../text'
import {
  createAnnouncement,
  findAnnouncement,
  listLiveAnnouncementIds,
  readBoard,
  removeAnnouncement,
  reorderAnnouncements,
  setAnnouncementPublished,
  updateAnnouncement,
} from '../queries/announcement'
import {
  announcementAudit,
  BOARD_MISMATCH_MESSAGE,
  currentAnnouncer,
  MAX_BODY_LENGTH,
  MAX_DATE_LABEL_LENGTH,
  MAX_REASON_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  PERMISSION_MESSAGE,
  STALE_MESSAGE,
  validateAnnouncementLink,
} from '../support'
import type {
  AdminAnnouncement,
  AdminAnnouncementBoard,
  AnnouncementFieldsInput,
  AnnouncementOperationContext,
  AnnouncementResult,
} from '../types'

export const announcementBoard = async (
  context: AnnouncementOperationContext,
): Promise<AnnouncementResult<AdminAnnouncementBoard>> => {
  const announcer = await currentAnnouncer(context)
  if (!announcer) return failure(PERMISSION_MESSAGE)
  return success(await readBoard(context.db))
}

/**
 * The shared field validation, returning either the values a write may store
 * or the one refusal to show. Each field gets its own sentence — a caller told
 * "the announcement is invalid" reopens the whole form hunting for the blank.
 */
const normalizedFields = (
  input: AnnouncementFieldsInput,
):
  | { fields: NonNullable<Parameters<typeof createAnnouncement>[1]['fields']>; message: null }
  | { fields: null; message: string } => {
  const tag = normalizeRequiredText(input.tag, MAX_TAG_LENGTH)
  if (!tag) return { fields: null, message: 'Provide a tag of at most 40 characters.' }
  const dateLabel = normalizeOptionalText(input.dateLabel, MAX_DATE_LABEL_LENGTH)
  if (dateLabel === 'INVALID') {
    return { fields: null, message: 'Keep the date label to 40 characters.' }
  }
  const title = normalizeRequiredText(input.title, MAX_TITLE_LENGTH)
  if (!title) return { fields: null, message: 'Provide a title of at most 160 characters.' }
  const body = normalizeRequiredText(input.body, MAX_BODY_LENGTH)
  if (!body) {
    return { fields: null, message: 'Provide body text of at most 1,000 characters.' }
  }
  const link = validateAnnouncementLink(input.link)
  if (link.message !== null) return { fields: null, message: link.message }
  return {
    fields: {
      tag,
      dateLabel,
      title,
      body,
      // The icon needs no check here: the GraphQL enum refuses an unknown key
      // before this runs, and the SQL CHECK is the second layer beneath it.
      icon: input.icon,
      link: link.value,
      // A past end time is accepted deliberately: an already-expired card is a
      // legal draft state, and the public read is what decides visibility.
      endsAt: input.endsAt ?? null,
      published: input.published,
    },
    message: null,
  }
}

export const createAnnouncementController = async (
  input: AnnouncementFieldsInput,
  context: AnnouncementOperationContext,
): Promise<AnnouncementResult<AdminAnnouncement>> => {
  const announcer = await currentAnnouncer(context)
  if (!announcer) return failure(PERMISSION_MESSAGE)
  const normalized = normalizedFields(input)
  if (normalized.fields === null) return failure(normalized.message)
  const id = crypto.randomUUID()
  const now = new Date()
  const created = await createAnnouncement(context.db, {
    id,
    fields: normalized.fields,
    now,
    audit: announcementAudit(context, {
      actorUserId: announcer.id,
      action: auditActions.announcementCreated,
      entityType: 'SEB_ANNOUNCEMENT',
      entityId: id,
      now,
    }),
  })
  if (!created) return failure(STALE_MESSAGE)
  return success((await findAnnouncement(context.db, id))!)
}

export const updateAnnouncementController = async (
  input: AnnouncementFieldsInput & { id: string; expectedVersion: number },
  context: AnnouncementOperationContext,
): Promise<AnnouncementResult<AdminAnnouncement>> => {
  const announcer = await currentAnnouncer(context)
  if (!announcer) return failure(PERMISSION_MESSAGE)
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return failure('That update request is not valid.')
  }
  const normalized = normalizedFields(input)
  if (normalized.fields === null) return failure(normalized.message)
  const now = new Date()
  const changed = await updateAnnouncement(context.db, {
    id: input.id,
    expectedVersion: input.expectedVersion,
    fields: normalized.fields,
    now,
    audit: announcementAudit(context, {
      actorUserId: announcer.id,
      action: auditActions.announcementUpdated,
      entityType: 'SEB_ANNOUNCEMENT',
      entityId: input.id,
      now,
    }),
  })
  // One answer for a stale version, an unknown id and a removed card alike:
  // distinguishing them would say which ids exist.
  if (!changed) return failure(STALE_MESSAGE)
  return success((await findAnnouncement(context.db, input.id))!)
}

export const setAnnouncementPublishedController = async (
  input: { id: string; expectedVersion: number; published: boolean; reason?: string | null },
  context: AnnouncementOperationContext,
): Promise<AnnouncementResult<AdminAnnouncement>> => {
  const announcer = await currentAnnouncer(context)
  if (!announcer) return failure(PERMISSION_MESSAGE)
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return failure('That update request is not valid.')
  }
  const reason = normalizeOptionalText(input.reason, MAX_REASON_LENGTH)
  if (reason === 'INVALID') return failure('Keep the reason to 1,000 characters.')
  const now = new Date()
  const changed = await setAnnouncementPublished(context.db, {
    id: input.id,
    expectedVersion: input.expectedVersion,
    published: input.published,
    now,
    audit: announcementAudit(context, {
      actorUserId: announcer.id,
      action: auditActions.announcementUpdated,
      entityType: 'SEB_ANNOUNCEMENT',
      entityId: input.id,
      now,
      metadata: { published: input.published, reason },
    }),
  })
  if (!changed) return failure(STALE_MESSAGE)
  return success((await findAnnouncement(context.db, input.id))!)
}

export const removeAnnouncementController = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AnnouncementOperationContext,
): Promise<AnnouncementResult<AdminAnnouncementBoard>> => {
  const announcer = await currentAnnouncer(context)
  if (!announcer) return failure(PERMISSION_MESSAGE)
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return failure('That update request is not valid.')
  }
  const reason = normalizeRequiredText(input.reason, MAX_REASON_LENGTH)
  if (!reason) return failure('Provide a reason of at most 1,000 characters.')
  const now = new Date()
  const changed = await removeAnnouncement(context.db, {
    id: input.id,
    expectedVersion: input.expectedVersion,
    reason,
    actorUserId: announcer.id,
    now,
    audit: announcementAudit(context, {
      actorUserId: announcer.id,
      action: auditActions.announcementRemoved,
      entityType: 'SEB_ANNOUNCEMENT',
      entityId: input.id,
      now,
      metadata: { reason },
    }),
  })
  if (!changed) return failure(STALE_MESSAGE)
  // The board back, not a bare flag: removal bumped its version and shrank
  // its list, and the screen repaints from one answer.
  return success(await readBoard(context.db))
}

export const reorderAnnouncementsController = async (
  input: { ids: string[]; expectedBoardVersion: number },
  context: AnnouncementOperationContext,
): Promise<AnnouncementResult<AdminAnnouncementBoard>> => {
  const announcer = await currentAnnouncer(context)
  if (!announcer) return failure(PERMISSION_MESSAGE)
  if (!Number.isInteger(input.expectedBoardVersion) || input.expectedBoardVersion < 1) {
    return failure('That reorder request is not valid.')
  }
  if (input.ids.length === 0) return failure('There is nothing to reorder.')
  if (new Set(input.ids).size !== input.ids.length) {
    return failure(BOARD_MISMATCH_MESSAGE)
  }
  /*
   * The friendly half of the id-set check: this read can race a concurrent
   * create or remove, and the write below is what actually decides — either
   * of those bumps the board, so the guarded claim refuses a list built
   * against a set that has since changed.
   */
  const live = await listLiveAnnouncementIds(context.db)
  if (
    live.length !== input.ids.length ||
    !input.ids.every((id) => live.includes(id))
  ) {
    return failure(BOARD_MISMATCH_MESSAGE)
  }
  const now = new Date()
  const changed = await reorderAnnouncements(context.db, {
    ids: input.ids,
    expectedBoardVersion: input.expectedBoardVersion,
    now,
    audit: announcementAudit(context, {
      actorUserId: announcer.id,
      action: auditActions.announcementReordered,
      entityType: 'SEB_ANNOUNCEMENT_BOARD',
      entityId: 'BOARD',
      now,
      metadata: { count: input.ids.length },
    }),
  })
  if (!changed) return failure(STALE_MESSAGE)
  return success(await readBoard(context.db))
}
