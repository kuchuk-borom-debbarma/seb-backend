/**
 * The programme office gate.
 *
 * Either administrative role opens the console — the API's own rule, where
 * `currentAdministrator` accepts `ADMIN` or `SUPER_ADMIN`. The narrower powers
 * inside it are gated separately: role management needs `SUPER_ADMIN`, checked
 * on its own route.
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { RoleRefusal } from '#/features/portal/RoleRefusal'
import { isAdministrator } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin')({
  component: OfficeGate,
})

function OfficeGate() {
  const { user } = Route.useRouteContext()
  if (!isAdministrator(user)) return <RoleRefusal portal="office" user={user} />
  return <Outlet />
}
