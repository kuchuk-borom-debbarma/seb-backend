/**
 * The activity history's queries, and the address its filters live in.
 *
 * Kept apart from the screen because three screens read the same history: the
 * full view, an application's Activity section, and the entry dialog each
 * build the same request, and one mapping from the address to the API's filter
 * is what keeps an export holding exactly the rows that were on screen.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  AuditActionsDocument,
  AuditEventDocument,
  AuditPeopleDocument,
} from '#/graphql/generated/operations'
import type { AuditCategory, AuditFilterInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'
import { dayEnd, dayOf, dayStart, idOf, idsOf, manyOf, oneOf, textOf } from '#/lib/search'
import { auditEventsQuery } from './auditEvents'

export const AUDIT_PAGE_SIZE = 20

/**
 * Every category, in the order the screen offers them.
 *
 * Listed here because the generated schema carries the enum as a type only.
 * The check below makes the list exhaustive at compile time: a category added
 * to the API and regenerated fails the build until it is added here, instead of
 * silently being unfilterable.
 */
export const AUDIT_CATEGORIES = [
  'SIGN_IN',
  'ACCOUNT',
  'ACCESS',
  'ENTERPRISE',
  'APPLICATION',
  'DOCUMENT',
  'REVIEW',
  'PROGRAMME',
  'PIPELINE',
  'STAGE',
  'ANNOUNCEMENT',
  'AUDIT',
  'OTHER',
] as const satisfies readonly AuditCategory[]
type UnlistedCategory = Exclude<AuditCategory, (typeof AUDIT_CATEGORIES)[number]>
const everyCategoryListed: [UnlistedCategory] extends [never] ? true : UnlistedCategory =
  true
void everyCategoryListed

/**
 * The history's filters as the address holds them.
 *
 * Every route's search keys share one namespace in the router's types, so these
 * are named to collide with nothing: `kinds` rather than `categories`, which the
 * queue already uses for application categories; `since`/`until` rather than
 * `from`/`to`; `oldest` rather than `order`. A collision is not cosmetic — it
 * makes the other screen's own links stop type-checking.
 */
export type AuditSearch = {
  after?: string
  /** Actors holding this role now. */
  actorRole?: string
  /** What these people did. */
  actor?: string[]
  /** What was done to these people. */
  subject?: string[]
  /** One person's whole history: done by them or to them. */
  involving?: string
  kinds?: (typeof AUDIT_CATEGORIES)[number][]
  actions?: string[]
  /** Reached by a link from a record's own screen, not typed. */
  types?: string[]
  entity?: string
  /** An application's id, from its workspace; `reference` is what a person types. */
  application?: string
  reference?: string
  outcome?: 'SUCCESS' | 'FAILURE'
  /** Calendar days, widened to whole-day instants at the API boundary. */
  since?: string
  until?: string
  /** One request's events, reached from an entry. */
  request?: string
  oldest?: true
  /** The entry open in the dialog, so the back button closes it. */
  event?: string
}

/** Strings from the address, kept only while they could be real. */
const stringsOf = (value: unknown, max: number): string[] | undefined => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kept = raw
    .map((entry) => textOf(entry, max))
    .filter((entry): entry is string => entry !== undefined)
  return kept.length > 0 ? kept : undefined
}

export const validateAuditSearch = (search: Record<string, unknown>): AuditSearch => ({
  after: typeof search.after === 'string' ? search.after : undefined,
  /*
   * Any non-empty name, and unknown ones are dropped by the API rather than
   * refused here: a bookmark naming a role since retired should still render,
   * just unfiltered by it.
   */
  actorRole: textOf(search.actorRole, 64),
  actor: idsOf(search.actor),
  subject: idsOf(search.subject),
  involving: idOf(search.involving),
  kinds: manyOf(AUDIT_CATEGORIES, search.kinds),
  actions: stringsOf(search.actions, 100),
  types: stringsOf(search.types, 64),
  entity: textOf(search.entity),
  application: idOf(search.application),
  reference: textOf(search.reference, 64),
  outcome: oneOf(['SUCCESS', 'FAILURE'] as const, search.outcome),
  since: dayOf(search.since),
  until: dayOf(search.until),
  request: textOf(search.request),
  oldest: search.oldest === true ? true : undefined,
  event: textOf(search.event),
})

/** The address's filters as the API's, shared by the page and the export. */
export const filterFor = (search: AuditSearch): AuditFilterInput => ({
  actorUserIds: search.actor ?? null,
  actorRole: search.actorRole ?? null,
  subjectUserIds: search.subject ?? null,
  involvingUserId: search.involving ?? null,
  categories: search.kinds ?? null,
  actions: search.actions ?? null,
  entityTypes: search.types ?? null,
  entityId: search.entity ?? null,
  applicationId: search.application ?? null,
  applicationReference: search.reference ?? null,
  outcome: search.outcome ?? null,
  from: dayStart(search.since),
  to: dayEnd(search.until),
  requestId: search.request ?? null,
})

/** Whether anything narrows the history — what an empty page has to explain. */
export const isFiltered = (search: AuditSearch): boolean =>
  Object.values(filterFor(search)).some((value) => value !== null)

/** The page the address describes. */
export const pageQueryFor = (search: AuditSearch) =>
  auditEventsQuery({
    first: AUDIT_PAGE_SIZE,
    after: search.after ?? null,
    oldest: Boolean(search.oldest),
    filter: filterFor(search),
  })

export const auditEventQuery = (id: string) =>
  queryOptions({
    queryKey: ['audit-event', id],
    queryFn: async () => unwrap((await gql(AuditEventDocument, { id })).audit.event),
    // An entry never changes once written, so what was read stays true.
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * The action names that actually occur, labelled and categorized.
 *
 * Read from the recorded history rather than from a constant, so the picker
 * never offers a filter that matches nothing. Cached for a few minutes: the set
 * changes only when a new kind of event is recorded for the first time.
 */
export const auditActionsQuery = queryOptions({
  queryKey: ['audit-actions'],
  queryFn: async () => unwrap((await gql(AuditActionsDocument)).audit.actions),
  staleTime: 5 * 60_000,
})

/** The people a URL's ids name, so a filter shows an address, not a UUID. */
export const auditPeopleQuery = (ids: readonly string[]) =>
  queryOptions({
    queryKey: ['audit-people', [...ids].sort()],
    queryFn: async () =>
      unwrap((await gql(AuditPeopleDocument, { input: { ids: [...ids] } })).audit.people),
    enabled: ids.length > 0,
    staleTime: 60_000,
  })

/** One person by whole address — the person filter's lookup. */
export const findAuditPerson = async (email: string) =>
  (await gql(AuditPeopleDocument, { input: { email } })).audit.people
