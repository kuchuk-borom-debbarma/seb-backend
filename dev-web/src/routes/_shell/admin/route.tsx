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
import { belongsInTheOffice, holdsOnlyTheBanner } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin')({
  beforeLoad: ({ context, location }) => {
    if (
      context.user &&
      holdsOnlyTheBanner(context.user) &&
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
