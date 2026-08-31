/**
 * The announcement banner, readable by anybody.
 *
 * ## The whole trust basis, stated here because nothing else stands guard
 *
 * This is the portal's one unauthenticated GraphQL read besides
 * `Query.health`. What is between it and the world:
 *
 * - **It serves only what an announcer published.** The predicate lives in
 *   SQL — not deleted, `published`, and not past its optional end time — so a
 *   draft or a withdrawn card cannot leak through a mapping bug here.
 * - **No column it returns describes a person.** Tag, title, body, icon key,
 *   a validated link, an optional free-text date label: content the office
 *   wrote for the public, and only that. Authors and lifecycle stay on the
 *   admin surface.
 * - **It takes no arguments and reads no session**, so there is nothing to
 *   enumerate, replay, or escalate; the answer is the same for every caller.
 * - **The list is capped** at `MAX_ANNOUNCEMENT_ROWS`, and the request still
 *   passes Yoga's body-size and document-cost limits like any other.
 * - **Do not lean on the per-IP request budget here.** It keys on
 *   `CF-Connecting-IP`, and the client's server-side render reaches this
 *   Worker service-to-service where that header may be absent. The landing
 *   page's caching is the volume mitigation, not the limiter.
 */
import { success } from '../../envelope'
import { readPublicAnnouncements } from '../queries/announcement'
import type {
  AnnouncementOperationContext,
  AnnouncementResult,
  PublicAnnouncement,
} from '../types'

/** No guards and no refusal branches: an empty banner is an ordinary answer. */
export const publicAnnouncementBanner = async (
  context: AnnouncementOperationContext,
): Promise<AnnouncementResult<{ announcements: PublicAnnouncement[] }>> =>
  success({ announcements: await readPublicAnnouncements(context.db, new Date()) })
