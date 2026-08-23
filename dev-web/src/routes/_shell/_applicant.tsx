/**
 * The applicant gate.
 *
 * A pathless layout carrying no chrome of its own — the shell above it already
 * drew that. Its only job is to decide whether this account may see the screens
 * beneath it, and to refuse in place rather than redirect: being sent somewhere
 * else without explanation teaches nobody why.
 *
 * The API refuses these operations independently. This gate stops the client
 * *offering* work that would be refused; it is not the security boundary.
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { RoleRefusal } from '#/features/portal/RoleRefusal'
import { isApplicant } from '#/lib/session'

export const Route = createFileRoute('/_shell/_applicant')({
  component: ApplicantGate,
})

function ApplicantGate() {
  const { user } = Route.useRouteContext()
  if (!isApplicant(user)) return <RoleRefusal portal="applicant" user={user} />
  return <Outlet />
}
