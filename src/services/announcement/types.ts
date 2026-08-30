/**
 * The public announcement banner.
 *
 * Announcers author cards for the landing page's notice board; everyone —
 * signed in or not — reads the published result. The admin surface and the
 * public read share this one service so the write guards and the read
 * predicate cannot drift apart.
 */
import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'
import type {
  AnnouncementIcon,
  AnnouncementLinkKind,
  sebAnnouncement,
} from '../../db/schema'
import type { Envelope } from '../envelope'
import type { Loaders } from '../../loaders'

/*
 * Re-exported so a caller naming the aliases below can name their shapes too,
 * the same courtesy the audit service extends.
 */
export type { Envelope } from '../envelope'
export type { Loaders } from '../../loaders'
export type { AnnouncementIcon, AnnouncementLinkKind } from '../../db/schema'

export type AnnouncementOperationContext = {
  db: Database
  /** Per-request batched lookups. Never shared between requests. */
  loaders: Loaders
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type AnnouncementResult<T> = Envelope<T>

/** A link as it travels the wire: what it is decides how a renderer treats it. */
export type AnnouncementLink = {
  kind: AnnouncementLinkKind
  target: string
}

/** Everything an announcer writes on one card. */
export type AnnouncementFieldsInput = {
  tag: string
  dateLabel?: string | null
  title: string
  body: string
  icon: AnnouncementIcon
  link?: AnnouncementLink | null
  endsAt?: Date | null
  published: boolean
}

export type AnnouncementRow = typeof sebAnnouncement.$inferSelect

/** One card as the admin board reports it. */
export type AdminAnnouncement = {
  id: string
  tag: string
  dateLabel: string | null
  title: string
  body: string
  icon: AnnouncementIcon
  link: AnnouncementLink | null
  endsAt: Date | null
  published: boolean
  sortOrder: number
  currentVersion: number
  createdAt: Date
  updatedAt: Date
}

/** The whole banner as the office sees it, with its reorder guard version. */
export type AdminAnnouncementBoard = {
  boardVersion: number
  announcements: AdminAnnouncement[]
}

/** One card as the public read serves it — no lifecycle, no versions. */
export type PublicAnnouncement = {
  id: string
  tag: string
  dateLabel: string | null
  title: string
  body: string
  icon: AnnouncementIcon
  link: AnnouncementLink | null
}
