import {
  changeDisplayName,
  changePassword,
  completeEmailChange,
  completePasswordReset,
  currentSession,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  sessions,
  signIn,
  signOut,
  startApplicantSignup,
  startEmailChange,
  startPasswordReset,
  verifyApplicantSignup,
} from '../../../services/auth'
import type { GraphQLContext } from '../../types'

/**
 * Resolvers are intentionally boring adapters. Validation, cryptography, and
 * persistence live in the auth service so they can be tested without GraphQL.
 */
export const authResolvers = {
  Query: {
    auth: () => ({}),
  },
  Mutation: {
    auth: () => ({}),
  },
  AuthQuery: {
    currentSession: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      currentSession(context),
    sessions: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      sessions(context),
  },
  AuthMutation: {
    startApplicantSignup: (
      _parent: unknown,
      args: { input: { email: string } },
      context: GraphQLContext,
    ) => startApplicantSignup(args.input, context),
    verifyApplicantSignup: (
      _parent: unknown,
      args: { input: { challengeToken: string; otp: string; password: string } },
      context: GraphQLContext,
    ) => verifyApplicantSignup(args.input, context),
    signIn: (
      _parent: unknown,
      args: { input: { email: string; password: string } },
      context: GraphQLContext,
    ) => signIn(args.input, context),
    signOut: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      signOut(context),
    revokeSession: (
      _parent: unknown,
      args: { sessionId: string },
      context: GraphQLContext,
    ) => revokeSession(args.sessionId, context),
    revokeOtherSessions: (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => revokeOtherSessions(context),
    revokeAllSessions: (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => revokeAllSessions(context),
    startPasswordReset: (
      _parent: unknown,
      args: { input: { email: string } },
      context: GraphQLContext,
    ) => startPasswordReset(args.input, context),
    completePasswordReset: (
      _parent: unknown,
      args: { input: { challengeToken: string; otp: string; newPassword: string } },
      context: GraphQLContext,
    ) => completePasswordReset(args.input, context),
    changePassword: (
      _parent: unknown,
      args: { input: { currentPassword: string; newPassword: string } },
      context: GraphQLContext,
    ) => changePassword(args.input, context),
    startEmailChange: (
      _parent: unknown,
      args: { input: { newEmail: string; currentPassword: string } },
      context: GraphQLContext,
    ) => startEmailChange(args.input, context),
    completeEmailChange: (
      _parent: unknown,
      args: { input: { challengeToken: string; otp: string } },
      context: GraphQLContext,
    ) => completeEmailChange(args.input, context),
    changeDisplayName: (
      _parent: unknown,
      args: { input: { displayName: string } },
      context: GraphQLContext,
    ) => changeDisplayName(args.input, context),
  },
}
