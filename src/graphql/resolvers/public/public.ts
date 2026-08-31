import { publicAnnouncementBanner } from '../../../services/announcement'
import type { GraphQLContext } from '../../types'

/**
 * The unauthenticated namespace. Deliberately thin: the trust basis of the one
 * read under it is stated where it is enforced, at the top of
 * `services/announcement/controllers/public.ts`.
 */
export const publicResolvers = {
  Query: {
    public: () => ({}),
  },
  PublicQuery: {
    announcementBanner: (_parent: unknown, _args: unknown, context: GraphQLContext) =>
      publicAnnouncementBanner(context),
  },
}
