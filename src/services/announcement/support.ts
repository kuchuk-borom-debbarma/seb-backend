/**
 * This service's refusal messages, its audit-row builder, and the link
 * validator — the one place an announcer-authored href is decided safe.
 */
import { coreAuditEvent, type auditActions } from '../../db/schema'
import { authenticatedWithCapability } from '../auth'
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

/** The caller, if they may write the banner. Policy lives in capabilities.ts. */
export const currentAnnouncer = async (context: AnnouncementOperationContext) => {
  const authenticated = await authenticatedWithCapability(context, 'ANNOUNCE')
  return authenticated?.user ?? null
}

export type AnnouncementAuditAction = (typeof auditActions)[keyof typeof auditActions]

/** Audit metadata stays deliberately smaller than the business record. */
export const announcementAudit = (
  context: AnnouncementOperationContext,
  input: {
    actorUserId: string
    action: AnnouncementAuditAction
    entityType: string
    entityId: string
    now: Date
    metadata?: Record<string, string | number | boolean | null>
  },
): typeof coreAuditEvent.$inferInsert => ({
  id: crypto.randomUUID(),
  actorUserId: input.actorUserId,
  action: input.action,
  entityType: input.entityType,
  entityId: input.entityId,
  outcome: 'SUCCESS',
  requestId:
    context.requestHeaders.get('CF-Ray') ?? context.requestHeaders.get('X-Request-ID'),
  ipAddress: context.requestHeaders.get('CF-Connecting-IP'),
  userAgent: context.requestHeaders.get('User-Agent'),
  changesJson: null,
  metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  createdAt: input.now,
})

/**
 * Decides whether an announcer-authored link may ever become an `href`.
 *
 * The target is rendered on the public landing page, so this is where
 * `javascript:`, `data:` and their relatives die — refusing at render time
 * would mean every renderer repeating the decision, and the first one that
 * forgot would execute it.
 *
 * Returns the value to store: for an external address that is the URL
 * **re-serialized** by `new URL()`, because the parser's output is the one
 * form later readers cannot misread.
 */
export const validateAnnouncementLink = (
  link: AnnouncementLink | null | undefined,
):
  | { value: AnnouncementLink | null; message: null }
  | { value: null; message: string } => {
  if (link === null || link === undefined) return { value: null, message: null }
  const target = link.target.trim()
  if (link.kind === 'EXTERNAL') {
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      return { value: null, message: 'Provide a full http or https address.' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { value: null, message: 'Provide a full http or https address.' }
    }
    if (parsed.href.length > MAX_EXTERNAL_LINK_LENGTH) {
      return { value: null, message: 'That address is too long.' }
    }
    return { value: { kind: 'EXTERNAL', target: parsed.href }, message: null }
  }
  if (link.kind === 'ROUTE') {
    /*
     * A path, and only a path. The second character matters: browsers read
     * `//host` — and `/\host` — as protocol-relative addresses, which would
     * turn an in-site link into an open redirect. With character zero pinned
     * to '/', no scheme can precede a colon, so these two rules are the whole
     * of it.
     */
    if (
      !target.startsWith('/') ||
      target.startsWith('//') ||
      target.startsWith('/\\') ||
      target.length > MAX_ROUTE_LINK_LENGTH
    ) {
      return { value: null, message: 'Provide a site path starting with a single "/".' }
    }
    return { value: { kind: 'ROUTE', target }, message: null }
  }
  if (link.kind === 'ANCHOR') {
    if (!target.startsWith('#') || target.length > MAX_ANCHOR_LINK_LENGTH) {
      return { value: null, message: 'Provide an anchor starting with "#".' }
    }
    return { value: { kind: 'ANCHOR', target }, message: null }
  }
  // Unreachable through GraphQL (the enum refuses first); a direct caller with
  // an invented kind is refused rather than stored.
  return { value: null, message: 'Provide a link of a known kind.' }
}
