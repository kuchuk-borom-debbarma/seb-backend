/** Thin GraphQL delegation for the audit namespace. */
import { auditActionNames, auditEvents, type AuditQueryInput } from '../../../services/audit'
import type { GraphQLContext } from '../../types'

export const auditResolvers = {
  Query: {
    audit: () => ({}),
  },
  AuditQuery: {
    events: (
      _parent: unknown,
      args: { input?: AuditQueryInput | null },
      context: GraphQLContext,
    ) => auditEvents(args.input ?? {}, context),
    actions: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      auditActionNames(context),
  },
}
