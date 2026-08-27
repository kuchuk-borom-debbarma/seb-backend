import { QueryClient } from '@tanstack/react-query'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

/*
 * A deploy replaces every hashed chunk, so a tab opened before it asks for
 * files that no longer exist and the next navigation dies with "Importing a
 * module script failed". Vite announces exactly that moment; answering it
 * with one reload swaps the tab onto the new version with the same URL. The
 * session flag stops a loop if the reload itself cannot fetch the new app.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    const GUARD = 'chunk-reload-at'
    const last = Number(sessionStorage.getItem(GUARD) ?? 0)
    if (Date.now() - last < 30_000) return
    sessionStorage.setItem(GUARD, String(Date.now()))
    event.preventDefault()
    window.location.reload()
  })
}

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
