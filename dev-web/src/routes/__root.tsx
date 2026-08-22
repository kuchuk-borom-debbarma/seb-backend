import type { QueryClient } from '@tanstack/react-query'
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import appCss from '#/styles.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'light' },
      { title: 'Mission SEP' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  errorComponent: RootError,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/**
 * The last resort for an unexpected fault.
 *
 * Expected refusals never reach here: the Worker returns them inside a result
 * envelope, and screens render them in place. Anything that lands on this
 * component is a transport or programming error, so it says what happened and
 * offers the only useful action.
 */
function RootError({ error }: { error: Error }) {
  return (
    <main style={{ padding: '3rem', maxWidth: '38rem', margin: '0 auto' }}>
      <p className="eyebrow">Something went wrong</p>
      <h1 style={{ marginTop: '0.5rem' }}>This page could not load</h1>
      <p className="muted" style={{ marginTop: '0.75rem' }}>
        {error.message}
      </p>
      <button
        type="button"
        className="button"
        style={{ marginTop: '1.5rem' }}
        onClick={() => window.location.reload()}
      >
        Reload the page
      </button>
    </main>
  )
}

function NotFound() {
  return (
    <main style={{ padding: '3rem', maxWidth: '38rem', margin: '0 auto' }}>
      <p className="eyebrow">Not found</p>
      <h1 style={{ marginTop: '0.5rem' }}>There is nothing at this address</h1>
      <a className="button" href="/" style={{ marginTop: '1.5rem' }}>
        Go to the portal
      </a>
    </main>
  )
}
