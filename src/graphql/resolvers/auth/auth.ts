import {
  applicantSessions,
  currentApplicantSession,
  revokeAllApplicantSessions,
  revokeApplicantSession,
  revokeOtherApplicantSessions,
  signInApplicant,
  signOutApplicant,
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
    currentApplicantSession: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      currentApplicantSession(context),
    applicantSessions: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      applicantSessions(context),
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
    signInApplicant: (
      _parent: unknown,
      args: { input: { email: string; password: string } },
      context: GraphQLContext,
    ) => signInApplicant(args.input, context),
    signOutApplicant: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      signOutApplicant(context),
    revokeApplicantSession: (
      _parent: unknown,
      args: { sessionId: string },
      context: GraphQLContext,
    ) => revokeApplicantSession(args.sessionId, context),
    revokeOtherApplicantSessions: (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => revokeOtherApplicantSessions(context),
    revokeAllApplicantSessions: (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => revokeAllApplicantSessions(context),
  },
}
