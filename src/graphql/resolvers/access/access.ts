import {
  grantRole,
  managedUserByEmail,
  managedUserById,
  revokeRole,
  type ManageableRole,
} from '../../../services/auth'
import type { GraphQLContext } from '../../types'

/**
 * Thin adapters only. Authorization, the step-up password confirmation, and the
 * guarded role writes all live in the auth service.
 */
export const accessResolvers = {
  Query: {
    access: () => ({}),
  },
  Mutation: {
    access: () => ({}),
  },
  AccessQuery: {
    userByEmail: (
      _parent: unknown,
      args: { email: string },
      context: GraphQLContext,
    ) => managedUserByEmail(args, context),
    userById: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
      managedUserById(args, context),
  },
  AccessMutation: {
    grantRole: (
      _parent: unknown,
      args: {
        input: {
          userId: string
          role: ManageableRole
          reason: string
          currentPassword: string
        }
      },
      context: GraphQLContext,
    ) => grantRole(args.input, context),
    revokeRole: (
      _parent: unknown,
      args: { input: { grantId: string; reason: string; currentPassword: string } },
      context: GraphQLContext,
    ) => revokeRole(args.input, context),
  },
}
