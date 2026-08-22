/**
 * Looking an account up for role management.
 *
 * Exact match only — the API offers no listing — so this either finds the one
 * account or reports that it did not. A miss is an ordinary answer rather than
 * an error, so the caller reads the message instead of unwrapping.
 *
 * Never cached beyond the moment: roles are exactly the thing being changed on
 * this screen, and a stale answer would show authority somebody no longer has.
 */
import { queryOptions } from '@tanstack/react-query'
import { ManagedUserByEmailDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'

export const managedUserQuery = (email: string | undefined) =>
  queryOptions({
    queryKey: ['managed-user', email ?? null],
    queryFn: async () => {
      const data = await gql(ManagedUserByEmailDocument, { email: email as string })
      return data.access.user
    },
    enabled: Boolean(email),
    staleTime: 0,
  })
