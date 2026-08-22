import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { SignOutDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor } from '#/lib/result'
import { ensureSession, isApplicant, type SignedInUser } from '#/lib/session'
import styles from './_shell.module.css'

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
      throw redirect({ to: '/sign-in', search: { next: location.href } })
    }
    return { user: session.user }
  },
  component: Shell,
  errorComponent: ShellError,
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

  return (
    <div className={styles.shell}>
      <Sidebar user={user} />
      <div className={styles.main}>
        <Outlet />
      </div>
    </div>
  )
}

function Sidebar({ user }: { user: SignedInUser }) {
  return (
    <nav className={styles.sidebar} aria-label="Portal sections">
      <div className={styles.brand}>
        <span className="eyebrow">TTAADC</span>
        <span className={styles.brandName}>Mission SEP</span>
      </div>

      {/*
        Navigation mirrors capability twice over. Roles are joined live on every
        request, so a revoked role removes its section on the next navigation.
        And a link only appears once its screen exists — an entry that leads
        nowhere is worse than a section that is not offered yet.
      */}
      <div className={styles.groups}>
        <NavGroup title="Portal">
          <NavLink to="/app">Overview</NavLink>
          {/* Applicant screens are refused by the API without an APPLICANT
              grant, so offering them to an administrator-only account would be
              advertising a page that cannot load. */}
          {isApplicant(user) ? (
            <NavLink to="/app/enterprises">Enterprises</NavLink>
          ) : null}
        </NavGroup>

        <NavGroup title="Account">
          <NavLink to="/account/sessions">Signed-in devices</NavLink>
        </NavGroup>
      </div>

      <AccountFooter user={user} />
    </nav>
  )
}

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>{title}</p>
      {children}
    </div>
  )
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className={styles.navLink}
      activeProps={{ className: `${styles.navLink} ${styles.navLinkActive}` }}
      // Only the section root should light up for its own index route; deeper
      // pages still mark their section as current.
      activeOptions={{ exact: to === '/app' || to === '/admin' }}
    >
      {children}
    </Link>
  )
}

function AccountFooter({ user }: { user: SignedInUser }) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const signOut = useMutation({
    mutationFn: async () => {
      const data = await gql(SignOutDocument)
      return data.auth.signOut
    },
    onSuccess: async () => {
      // Everything cached was fetched as this person. Clearing rather than
      // invalidating prevents the next visitor briefly seeing their data.
      queryClient.clear()
      await router.navigate({ to: '/sign-in' })
    },
  })

  return (
    <div className={styles.account}>
      <div className={styles.accountText}>
        <span className={styles.accountEmail} title={user.email}>
          {user.email}
        </span>
        <span className={styles.accountRoles}>
          {user.roles.map((role) => role.replace('_', ' ').toLowerCase()).join(' · ')}
        </span>
      </div>
      <button
        type="button"
        className={styles.signOut}
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
      >
        <span className="visually-hidden">Sign out</span>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6M10 11l3-3-3-3M13 8H6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}
