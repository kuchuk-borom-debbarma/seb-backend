import {
  CatchBoundary,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
} from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import {
  MobileHeader,
  NavigationBackdrop,
  PlatformNavigation,
  canUsePortal,
  navPortalFor,
  portalFor,
  type Portal,
  usePlatformNavigation,
} from '#/features/portal/PortalShell'
import { GuideProvider, useGuide } from '#/features/guide/GuideContext'
import { FirstVisit } from '#/features/guide/FirstVisit'
import { TourRail } from '#/features/guide/TourRail'
import { messageFor } from '#/lib/result'
import { ensureSession, type SignedInUser } from '#/lib/session'
import styles from '#/features/portal/PortalShell.module.css'
import { useEffect, useState } from 'react'

/**
 * The signed-in shell.
 *
 * A pathless layout route, so every screen inside it shares one identity fetch
 * and one guard rather than repeating both. `beforeLoad` runs before any child
 * loader, so an expired session never renders a half-populated page.
 */
export const Route = createFileRoute('/_shell')({
  beforeLoad: async ({ context, location }) => {
    const session = await ensureSession(context.queryClient)
    if (!session) {
      throw redirect({ to: '/login', search: { next: location.href } })
    }
    return { user: session.user }
  },
  component: Shell,
})

/**
 * Keeps a failed screen inside the shell.
 *
 * Expected refusals normally arrive inside a result envelope and are rendered
 * in place. One that surfaces here came from a route loader, where there is no
 * component yet to show it — most often an operation this account's roles do
 * not allow. Rendering it with the navigation intact lets the person go
 * somewhere else instead of meeting a blank error page.
 */
function ShellError({ error }: { error: Error }) {
  return (
    <main className="page">
      <PageHeader title="This page could not be loaded" />
      <p className="notice" data-tone="error" role="alert">
        {messageFor(error)}
      </p>
    </main>
  )
}

function Shell() {
  const { user } = Route.useRouteContext()
  const location = useLocation()

  return (
    <GuideProvider user={user}>
      <ShellFrame user={user} pathname={location.pathname} search={location.searchStr} />
    </GuideProvider>
  )
}

/**
 * The three columns: navigation, the page, and the guide when one is running.
 *
 * The guide is a column rather than an overlay, so the layout gives it room
 * instead of the page giving up its legibility. `data-guided` is what the
 * stylesheet reads to widen the grid.
 */
function ShellFrame({
  user,
  pathname,
  search,
}: {
  user: SignedInUser
  pathname: string
  search: string
}) {
  const { tour } = useGuide()
  const navigation = usePlatformNavigation()
  /*
   * Capability decides the portal, not just the address. They differ only when
   * somebody has opened a portal they cannot use — and then the whole shell,
   * masthead and measure alike, is the one they belong to. The refusal on the
   * page says where they are; the chrome around it stays somewhere real.
   */
  const addressedPortal = navPortalFor(portalFor(pathname), user)
  const sharedRoute =
    pathname === '/guide' ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/account/')
  const [lastPortal, setLastPortal] = useState<Portal>(addressedPortal)

  useEffect(() => {
    if (!sharedRoute) setLastPortal(addressedPortal)
  }, [addressedPortal, sharedRoute])

  const portal =
    sharedRoute && canUsePortal(lastPortal, user) ? lastPortal : addressedPortal

  return (
    <div
      className={styles.shell}
      data-guided={tour ? 'true' : undefined}
      data-collapsed={navigation.collapsed ? 'true' : undefined}
      /* Read by the stylesheet for measure, and by the tests to prove the two
         portals really are set differently. */
      data-portal={portal}
    >
      <MobileHeader
        portal={portal}
        onOpen={navigation.openNavigation}
        triggerRef={navigation.triggerRef}
      />
      <PlatformNavigation
        portal={portal}
        user={user}
        open={navigation.open}
        onClose={navigation.closeNavigation}
        collapsed={navigation.collapsed}
        onToggleCollapsed={navigation.toggleCollapsed}
      />
      <NavigationBackdrop open={navigation.open} onClose={navigation.closeNavigation} />
      <div className={styles.main}>
        <FirstVisit portal={portal} />
        {/*
          The boundary is around the outlet rather than on the route, because a
          route's error component replaces that route's whole output — which
          would take the navigation with it and strand somebody on a dead page
          with no way out but the back button. Here the failure is confined to
          the screen that failed.

          Reset on the address, so moving somewhere else clears the error rather
          than carrying it to a page that would have loaded.
        */}
        <CatchBoundary getResetKey={() => pathname + search} errorComponent={ShellError}>
          <Outlet />
        </CatchBoundary>
      </div>
      <TourRail />
    </div>
  )
}
