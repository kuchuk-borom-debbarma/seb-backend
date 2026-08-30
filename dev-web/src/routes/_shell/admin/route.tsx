/**
 * The programme office gate.
 *
 * **Holding any office permission at all is what opens the console.** Not a
 * named pair: roles are composed now, so the office can create one that only
 * reads the activity history, or only the roles list, and a door listing two
 * acceptable permissions would lock out exactly the narrow roles the model
 * exists to allow. What somebody cannot do is decided screen by screen rather
 * than here.
 *
 * The door is deliberately wider than any screen behind it. A refusal on the
 * screen you asked for is a sentence you can act on; a refusal at the door is
 * being told you are in the wrong building while standing in the right one.
 *
 * The one redirect that remains is for somebody who holds *only* the banner.
 * Every other office page renders from queries that would answer them with
 * refusals, so `/admin` forwards to the board rather than drawing a page made
 * of them. Anybody holding anything else lands where they asked.
 */
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { RoleRefusal } from '#/features/portal/RoleRefusal'
import { canAny, isSuperAdministrator, type SignedInUser } from '#/lib/session'

/**
 * Every resource the office console is built on.
 *
 * Listed rather than inferred because `applicant` access is not an office
 * permission and must not open this door. Adding a resource to the catalogue
 * without adding it here means its holders reach a refusal instead of their
 * screen — which is why the list names resources rather than pairs: one entry
 * per kind of work, not one per act.
 */
const OFFICE_RESOURCES = [
  'application',
  'decision',
  'funding',
  'recovery',
  'programme_cycle',
  'form_template',
  'policy_document',
  'announcement',
  'audit',
  'user',
  'role',
  'analytics',
] as const

const belongsInTheOffice = (user: SignedInUser | undefined): boolean =>
  isSuperAdministrator(user) ||
  OFFICE_RESOURCES.some((resource) => canAny(user, resource))

/** True only for somebody whose whole office authority is the banner. */
const bannerOnly = (user: SignedInUser | undefined): boolean =>
  !isSuperAdministrator(user) &&
  canAny(user, 'announcement') &&
  !OFFICE_RESOURCES.filter((resource) => resource !== 'announcement')
    .some((resource) => canAny(user, resource))

export const Route = createFileRoute('/_shell/admin')({
  beforeLoad: ({ context, location }) => {
    if (
      context.user &&
      bannerOnly(context.user) &&
      !location.pathname.startsWith('/admin/announcements')
    ) {
      throw redirect({ to: '/admin/announcements' })
    }
  },
  component: OfficeGate,
})

function OfficeGate() {
  const { user } = Route.useRouteContext()
  if (!belongsInTheOffice(user)) {
    return <RoleRefusal portal="office" user={user} />
  }
  return <Outlet />
}
