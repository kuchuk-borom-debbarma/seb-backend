/**
 * The signed-in identity, loaded once per navigation and shared by every route.
 *
 * Roles are read live from the API on each request rather than cached in a
 * token, which mirrors how the Worker authorizes: revoking a role takes effect
 * on the very next action. The client must never assume a role it saw earlier
 * is still held.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { CurrentSessionDocument } from '#/graphql/generated/operations'
import type { CurrentSessionQuery } from '#/graphql/generated/operations'

import { gql } from './graphql'

export type SignedInUser = NonNullable<
  CurrentSessionQuery['auth']['currentSession']['response']
>['user']

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async () => {
    const data = await gql(CurrentSessionDocument)
    // A signed-out visitor is a successful response with a null payload, not an
    // error — the Worker deliberately keeps expected failures inside the
    // envelope.
    return data.auth.currentSession.response
  },
  /*
   * Short, because this only decides what the interface renders — the Worker
   * authorizes every request independently and joins roles live. Long enough
   * that clicking between screens does not refetch the identity each time.
   */
  staleTime: 10_000,
})

/**
 * Resolves the current identity for a route guard.
 *
 * `revalidateIfStale` is the important part. Route guards read this through
 * `ensureQueryData`, which otherwise returns whatever is cached — including a
 * `null` cached while signed out. Without it, signing in and navigating would
 * be turned away by a guard still holding the signed-out answer.
 */
export const ensureSession = (queryClient: QueryClient) =>
  queryClient.ensureQueryData({ ...sessionQuery, revalidateIfStale: true })

/**
 * Discards the cached identity after it has deliberately changed.
 *
 * Signing in or out changes the session cookie, so anything cached about the
 * old identity is wrong rather than merely stale. `resetQueries` clears it so
 * the next guard must ask the API again; `invalidateQueries` would not, because
 * this query has no observers to refetch.
 */
export const forgetSession = (queryClient: QueryClient) =>
  queryClient.resetQueries({ queryKey: sessionQuery.queryKey })

/**
 * These read nothing but the role names, so they ask for nothing but the names.
 *
 * The sign-in response carries a narrower user than the session query does;
 * demanding the full record here would have forced a cast at the one call site
 * that decides which portal to open.
 *
 * A name is a `string` rather than a closed union, because a role is a row the
 * office composed. Only the two the server decides for itself can be matched by
 * name at all, and the helpers below are the only places that do.
 */
type RoleBearer = { roles: readonly string[] }

/** One thing somebody may do, as the API publishes it. */
export type Permission = { readonly resource: string; readonly action: string }

/**
 * What the signed-in person is allowed to do.
 *
 * The API resolves this from the roles held and publishes it, so the interface
 * asks "may they?" rather than matching role names. That matters more than it
 * used to: a role is data now, so a screen that named one would be asserting
 * something no file decides, and would go on looking right after that role was
 * retired or its permissions changed.
 *
 * **It decides what to draw, never what is permitted.** Every operation is
 * re-checked by the API, which is what actually refuses.
 */
type PermissionBearer = { permissions: readonly Permission[] }

export const can = (
  user: PermissionBearer | undefined,
  resource: string,
  action: string,
): boolean =>
  Boolean(user?.permissions.some(
    (held) => held.resource === resource && held.action === action,
  ))

/** Whether they hold any act at all on a kind of record. */
export const canAny = (
  user: PermissionBearer | undefined,
  resource: string,
): boolean => Boolean(user?.permissions.some((held) => held.resource === resource))

export const hasRole = (user: RoleBearer | undefined, ...roles: string[]): boolean =>
  Boolean(user && roles.some((role) => user.roles.includes(role)))

export const isSuperAdministrator = (user: RoleBearer | undefined): boolean =>
  hasRole(user, 'SUPER_ADMIN')

export const isApplicant = (user: RoleBearer | undefined): boolean =>
  hasRole(user, 'APPLICANT')

/**
 * Whether somebody belongs in the office at all.
 *
 * **One definition, because the door and the navigation must agree.** They did
 * not: the door was widened to admit any office permission while the sidebar
 * still asked for two named ones, so a role composed to read only the activity
 * history got an office shell with nothing in it — admitted to the building and
 * shown no way to the one room it holds.
 *
 * *Any* permission at all, rather than a list of office resources. Applicant
 * access is deliberately not a catalogue permission, so holding one already
 * means office work — and a list here would be a second copy of
 * `auth/catalog.json` with nothing checking the two agree, silently locking out
 * the holders of whatever resource was added to the server and forgotten here.
 *
 * Deliberately wider than any screen behind it. A refusal on the screen you
 * asked for is a sentence you can act on; a refusal at the door is being told
 * you are in the wrong building while standing in the right one.
 */
export const belongsInTheOffice = (
  user: (RoleBearer & PermissionBearer) | undefined,
): boolean => isSuperAdministrator(user) || (user?.permissions.length ?? 0) > 0

/** True only for somebody whose whole office authority is the banner. */
export const holdsOnlyTheBanner = (
  user: (RoleBearer & PermissionBearer) | undefined,
): boolean =>
  !isSuperAdministrator(user) &&
  canAny(user, 'announcement') &&
  (user?.permissions ?? []).every((held) => held.resource === 'announcement')
