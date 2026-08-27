import { QueryClient } from '@tanstack/react-query'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        /*
         * Navigating back to a screen should not refetch it. Individual
         * queries raise this where the data is genuinely static — the status
         * guide and programme cycles barely change — and drop it to zero
         * where staleness would be wrong, such as an open draft.
         */
        staleTime: 30_000,
        retry: 1,
        /*
         * On, deliberately. A lifecycle change made in a modal, another tab,
         * or by a colleague must show the moment the officer looks back at
         * the screen — with this off, a tab that missed one refetch showed a
         * cycle as Closed after it had been archived, until a full reload.
         * `staleTime` above still keeps quick tab-switches quiet.
         */
        refetchOnWindowFocus: true,
      },
    },
  })

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Preloaded data is reused rather than immediately refetched on navigation.
    defaultPreloadStaleTime: 0,
    // Long enough that a fast navigation never flashes a spinner.
    defaultPendingMs: 300,
    defaultPendingMinMs: 400,
  })

  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
