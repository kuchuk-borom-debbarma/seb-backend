/**
 * This service's refusal messages, its permission preamble, and the link
 * validator — the one place an announcer-authored href is decided safe.
 *
 * The audit row itself is `services/audit-event.ts`, shared by every service.
 * What stays here is which actions this one may write.
 */
import {
  auditEventRow,
  type ActionWrittenBy,
  type AuditEventInput,
  type AuditEventRecord,
} from '../audit-event'
import { authenticatedWithPermission, type ActionOf, type Resource } from '../auth'
import type {
  AnnouncementLink,
  AnnouncementOperationContext,
} from './types'

/**
 * The one refusal every insufficiently authorized request receives.
 *
 * Same wording as the admin service's, and deliberately role-blind: naming the
 * role that would have worked tells a caller which account to go looking for.
 */
export const PERMISSION_MESSAGE = 'You do not have permission to do that.'
export const STALE_MESSAGE = 'The record changed. Reload and try again.'
/** Said when a reorder's list no longer matches the board's live rows. */
export const BOARD_MISMATCH_MESSAGE = 'The board changed. Reload and try again.'

/**
 * The banner never grows without bound — an announcer authors tens of cards,
 * not thousands — and nothing sums this list, so a cap is honest here where it
 * would be a wrong number on a ledger.
 */
export const MAX_ANNOUNCEMENT_ROWS = 100

export const MAX_TAG_LENGTH = 40
export const MAX_DATE_LABEL_LENGTH = 40
export const MAX_TITLE_LENGTH = 160
export const MAX_BODY_LENGTH = 1_000
export const MAX_REASON_LENGTH = 1_000
const MAX_EXTERNAL_LINK_LENGTH = 2_000
const MAX_ROUTE_LINK_LENGTH = 500
const MAX_ANCHOR_LINK_LENGTH = 200

/**
 * The caller, if they hold the permission this operation needs.
 *
 * `currentAnnouncer` used to stand here and named `announcement`'s one
 * capability *for* its callers while serving all six operations. That is what
 * `docs/rules/code.md` forbids — reading the board and publishing to it are
 * different authorities now, and a preamble choosing between them would give
 * anybody who may read the board the power to change what the public sees.
 *
 * So the pair is required arguments, exactly as in the admin service's
 * `currentStaff`: every operation still names what it needs, and this only
 * spares each of them the `?.user ?? null` unwrapping. It is not shared with
 * that service because each service's guard takes its own operation context,
 * and a `support.ts` is per service by construction.
 */
export const currentStaff = async <R extends Resource>(
  context: AnnouncementOperationContext,
  resource: R,
  action: ActionOf<R>,
) => (await authenticatedWithPermission(context, resource, action))?.user ?? null

/** The actions the announcement service may record. */
export type AnnouncementAuditAction = ActionWrittenBy<'announcement'>

/**
 * Builds one declared audit row for a banner change.
 *
 * The row is `services/audit-event.ts`, shared with every other service. What
 * this adds is that a banner change always has an actor and is always a
 * success — an announcer's refusal never reaches a write.
 */
export const announcementAudit = <A extends AnnouncementAuditAction>(
  context: AnnouncementOperationContext,
  input: AuditEventInput<A> & { actorUserId: string; now: Date },
): AuditEventRecord => auditEventRow(context, { ...input, createdAt: input.now })

/**
 * What a validated link is worth: the value to store, or the sentence to show.
 *
 * Never both. A caller reads `message` first, and there is nothing to store
 * when it is set.
 */
type LinkVerdict =
  | { value: AnnouncementLink | null; message: null }
  | { value: null; message: string }

/** One sentence for every way an external address can be wrong except length. */
const EXTERNAL_MESSAGE = 'Provide a full http or https address.'

/**
 * An address that leaves the site.
 *
 * This is where `javascript:`, `data:` and their relatives die. The stored
 * value is the URL **re-serialized** by `new URL()`, because the parser's
 * output is the one form later readers cannot misread.
 */
const externalLink = (target: string): LinkVerdict => {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return { value: null, message: EXTERNAL_MESSAGE }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { value: null, message: EXTERNAL_MESSAGE }
  }
  if (parsed.href.length > MAX_EXTERNAL_LINK_LENGTH) {
    return { value: null, message: 'That address is too long.' }
  }
  return { value: { kind: 'EXTERNAL', target: parsed.href }, message: null }
}

/**
 * A path on this site, and only a path.
 *
 * The second character matters: browsers read `//host` — and `/\host` — as
 * protocol-relative addresses, which would turn an in-site link into an open
 * redirect. With character zero pinned to '/', no scheme can precede a colon,
 * so these two rules are the whole of it.
 */
const routeLink = (target: string): LinkVerdict =>
  !target.startsWith('/') ||
  target.startsWith('//') ||
  target.startsWith('/\\') ||
  target.length > MAX_ROUTE_LINK_LENGTH
    ? { value: null, message: 'Provide a site path starting with a single "/".' }
    : { value: { kind: 'ROUTE', target }, message: null }

/** A section of the landing page. It never leaves the document. */
const anchorLink = (target: string): LinkVerdict =>
  !target.startsWith('#') || target.length > MAX_ANCHOR_LINK_LENGTH
    ? { value: null, message: 'Provide an anchor starting with "#".' }
    : { value: { kind: 'ANCHOR', target }, message: null }

/**
 * Decides whether an announcer-authored link may ever become an `href`.
 *
 * The target is rendered on the public landing page, so this is the one place
 * that decision is made — refusing at render time would mean every renderer
 * repeating it, and the first one that forgot would execute it.
 *
 * A dispatch and nothing else. Each kind is a different question with a
 * different answer, and reading one of them should not mean reading all three.
 */
export const validateAnnouncementLink = (
  link: AnnouncementLink | null | undefined,
): LinkVerdict => {
  if (link === null || link === undefined) return { value: null, message: null }
  const target = link.target.trim()
  switch (link.kind) {
    case 'EXTERNAL':
      return externalLink(target)
    case 'ROUTE':
      return routeLink(target)
    case 'ANCHOR':
      return anchorLink(target)
    default:
      // Unreachable through GraphQL (the enum refuses first); a direct caller
      // with an invented kind is refused rather than stored.
      return { value: null, message: 'Provide a link of a known kind.' }
  }
}
