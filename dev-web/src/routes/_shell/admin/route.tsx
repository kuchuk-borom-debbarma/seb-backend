/**
 * The programme office gate.
 *
 * Being able to read is what opens the console, which is the API's own rule:
 * every administrative query asks for `STAFF_READ`. A reviewer holds only that
 * and belongs here; what they cannot do is decided screen by screen rather
 * than at the door.
 *
 * An announcer holds `ANNOUNCE` and deliberately not `STAFF_READ`, so the
 * door admits that capability too — and then keeps its holder on the one
 * screen it unlocks: every other office page renders from casework queries
 * that would only answer with refusals, so anything else under `/admin`
 * forwards to the announcement board instead of drawing a broken page.
 *
 * Asked as capabilities rather than by naming roles. A list of acceptable
 * roles here would be a second copy of the policy in `auth/capabilities.ts` —
 * which is exactly how the two drift.
 */
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { RoleRefusal } from '#/features/portal/RoleRefusal'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin')({
  beforeLoad: ({ context, location }) => {
    if (
      context.user &&
      !can(context.user, 'STAFF_READ') &&
      can(context.user, 'ANNOUNCE') &&
      !location.pathname.startsWith('/admin/announcements')
    ) {
      throw redirect({ to: '/admin/announcements' })
    }
  },
  component: OfficeGate,
})

function OfficeGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'STAFF_READ') && !can(user, 'ANNOUNCE')) {
    return <RoleRefusal portal="office" user={user} />
  }
  return <Outlet />
}
