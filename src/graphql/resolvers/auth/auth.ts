import {
  currentSession,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  sessions,
  signIn,
  signOut,
  startApplicantSignup,
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
  },
}
