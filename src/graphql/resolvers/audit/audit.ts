/** Thin GraphQL delegation for the audit namespace. */
import {
  auditActionNames,
  auditEvent,
  auditEvents,
  auditPeople,
  exportAuditEvents,
  type AuditFilterInput,
  type AuditQueryInput,
} from '../../../services/audit'
import type { GraphQLContext } from '../../types'

export const auditResolvers = {
  Query: {
    audit: () => ({}),
  },
  Mutation: {
    audit: () => ({}),
  },
  AuditQuery: {
    events: (_parent: unknown, args: { input?: AuditQueryInput | null }, context: GraphQLContext) =>
      auditEvents(args.input ?? {}, context),
    event: (_parent: unknown, args: { id: string }, context: GraphQLContext) => auditEvent(args.id, context),
    people: (
      _parent: unknown,
      args: { input: { email?: string | null; ids?: string[] | null } },
      context: GraphQLContext,
    ) => auditPeople(args.input, context),
    actions: (_parent: unknown, _args: unknown, context: GraphQLContext) => auditActionNames(context),
  },
  AuditMutation: {
    exportEvents: (
      _parent: unknown,
      args: { input: { filter?: AuditFilterInput | null; purpose: string } },
      context: GraphQLContext,
    ) => exportAuditEvents(args.input, context),
  },
}
