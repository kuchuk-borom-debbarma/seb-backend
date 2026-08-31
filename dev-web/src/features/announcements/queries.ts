/**
 * Queries behind the announcement banner — the public read the landing page
 * renders from, and the version-guarded board the announcer edits.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  AdminAnnouncementBoardDocument,
  PublicAnnouncementBannerDocument,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

/*
 * One API read per landing-page render, deliberately uncached on the server.
 *
 * A module-scope memo would spare the API's per-IP request budget — which may
 * never see a visitor's address through the site's own server — but it would
 * also serve every anonymous visitor a banner up to a minute stale after the
 * office publishes, and no signal reaches an anonymous page to bust it. At
 * this programme's traffic one read per visit is the cheaper honesty; the day
 * the landing page needs a cache, it belongs in HTTP response headers where
 * the office's writes can shorten it, not in a memo nothing can reach.
 */
export const publicAnnouncementsQuery = queryOptions({
  queryKey: ['public-announcements'],
  queryFn: async () => {
    try {
      const data = await gql(PublicAnnouncementBannerDocument)
      return data.public.announcementBanner.response?.announcements ?? []
    } catch {
      // The marketing page must never fail because its notice board did; an
      // empty board hides the panel, which is the honest degraded state.
      return []
    }
  },
  // A notice board changes weekly, not per tab focus.
  staleTime: 60 * 60 * 1000,
})

export const announcementBoardQuery = queryOptions({
  queryKey: ['admin-announcement-board'],
  queryFn: async () => {
    const data = await gql(AdminAnnouncementBoardDocument)
    return unwrap(data.admin.announcement.board)
  },
  // Never served stale: every write quotes a version read from this data.
  staleTime: 0,
})
