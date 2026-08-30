import {
  acceptRoleInvite,
  createRole,
  deleteRole,
  grantRole,
  invitableRoles,
  inviteRole,
  managedUserByEmail,
  managedUserById,
  permissionCatalogue,
  revokeRole,
  roleByKey,
  roles,
  updateRole,
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
    roles: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      roles(context),
    role: (_parent: unknown, args: { key: string }, context: GraphQLContext) =>
      roleByKey(args, context),
    permissionCatalogue: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      permissionCatalogue(context),
    invitableRoles: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      invitableRoles(context),
  },
  AccessMutation: {
    createRole: (
      _parent: unknown,
      args: { input: { key: string; name: string; description: string } },
      context: GraphQLContext,
    ) => createRole(args.input, context),
    updateRole: (
      _parent: unknown,
      args: {
        input: {
          roleId: string
          expectedVersion: number
          name: string
          description: string
          permissions: { resource: string; action: string }[]
          currentPassword: string
        }
      },
      context: GraphQLContext,
    ) => updateRole(args.input, context),
    deleteRole: (
      _parent: unknown,
      args: {
        input: {
          roleId: string
          expectedVersion: number
          reason: string
          currentPassword: string
        }
      },
      context: GraphQLContext,
    ) => deleteRole(args.input, context),
    grantRole: (
      _parent: unknown,
      args: {
        input: {
          userId: string
          roleKey: string
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
    inviteRole: (
      _parent: unknown,
      args: { input: { userId: string; roleKey: string; reason: string } },
      context: GraphQLContext,
    ) => inviteRole(args.input, context),
    acceptRoleInvite: (
      _parent: unknown,
      args: { token: string },
      context: GraphQLContext,
    ) => acceptRoleInvite(args, context),
  },
}
