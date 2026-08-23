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
import type { UserRole } from '#/graphql/generated/schema'
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
 * These read nothing but the roles, so they ask for nothing but the roles.
 *
 * The sign-in response carries a narrower user than the session query does;
 * demanding the full record here would have forced a cast at the one call site
 * that decides which portal to open.
 */
type RoleBearer = { roles: readonly UserRole[] }

export const hasRole = (user: RoleBearer | undefined, ...roles: UserRole[]): boolean =>
  Boolean(user && roles.some((role) => user.roles.includes(role)))

/** `SUPER_ADMIN` carries every administrative capability; it needs no ADMIN grant. */
export const isAdministrator = (user: RoleBearer | undefined): boolean =>
  hasRole(user, 'ADMIN', 'SUPER_ADMIN')

export const isSuperAdministrator = (user: RoleBearer | undefined): boolean =>
  hasRole(user, 'SUPER_ADMIN')

export const isApplicant = (user: RoleBearer | undefined): boolean =>
  hasRole(user, 'APPLICANT')
