/**
 * The programme office gate.
 *
 * Being able to read is what opens the console, which is the API's own rule:
 * every administrative query asks for `STAFF_READ`. A reviewer holds only that
 * and belongs here; what they cannot do is decided screen by screen rather
 * than at the door.
 *
 * Asked as a capability rather than by naming roles. Four roles now reach this
 * gate, and a list of acceptable ones here would be a second copy of the
 * policy in `auth/capabilities.ts` — which is exactly how the two drift.
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { RoleRefusal } from '#/features/portal/RoleRefusal'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin')({
  component: OfficeGate,
})

function OfficeGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'STAFF_READ')) return <RoleRefusal portal="office" user={user} />
  return <Outlet />
}
