/**
 * The chrome around every signed-in screen.
 *
 * There are two portals and one shell. An applicant does this once, perhaps
 * twice in a lifetime; a programme officer works forty applications a day for
 * years. They need the same institution and different measure — so the palette,
 * the faces and the components are shared, and only the density, the masthead
 * and the navigation differ. `data-portal` is what the stylesheet reads.
 *
 * Which portal you are in is derived from the address rather than held in
 * state, so the screens both audiences share — the guide, signed-in devices —
 * wear whichever portal you reached them from, with nothing to decide.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { SignOutDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import {
  isAdministrator,
  isApplicant,
  isSuperAdministrator,
  type SignedInUser,
} from '#/lib/session'
import styles from './PortalShell.module.css'

export type Portal = 'applicant' | 'office'

/** Everything under `/admin` is the office; everything else is the applicant's. */
export const portalFor = (pathname: string): Portal =>
  pathname === '/admin' || pathname.startsWith('/admin/') ? 'office' : 'applicant'

export const canUsePortal = (portal: Portal, user: SignedInUser): boolean =>
  portal === 'office' ? isAdministrator(user) : isApplicant(user)

/**
 * The portal to draw the navigation for.
 *
 * Normally the one in the address. But somebody who has landed on a portal they
 * cannot use is shown the one they can — listing four links that would every
 * one of them refuse is exactly the thing this interface does not do. The
 * refusal on the page still says where they are and why.
 */
export const navPortalFor = (addressed: Portal, user: SignedInUser): Portal => {
  if (canUsePortal(addressed, user)) return addressed
  const other: Portal = addressed === 'office' ? 'applicant' : 'office'
  return canUsePortal(other, user) ? other : addressed
}

export function PortalNav({ portal, user }: { portal: Portal; user: SignedInUser }) {
  return (
    <nav className={styles.sidebar} aria-label="Portal sections">
      {/*
        The masthead says which portal this is without a banner. An applicant is
        told what the programme is for; an officer already knows and is told
        which desk they are at.
      */}
      <div className={styles.brand}>
        {portal === 'applicant' ? (
          <>
            <span className="eyebrow">TTAADC</span>
            <span className={styles.brandName}>Mission SEP</span>
            <span className={styles.brandNote}>
              Seed funding for first-generation entrepreneurs
            </span>
          </>
        ) : (
          <>
            <span className={styles.brandName}>Mission SEP</span>
            <span className={styles.brandNote}>Programme office</span>
          </>
        )}
      </div>

      {/*
        Navigation mirrors capability twice over. Roles are joined live on every
        request, so a revoked role removes its entry on the next navigation. And
        a link only appears once its screen exists — an entry that leads nowhere
        is worse than one that is not offered yet.
      */}
      <div className={styles.groups}>
        <NavGroup title="Start here">
          <NavLink to="/guide">How this works</NavLink>
        </NavGroup>

        {!canUsePortal(portal, user) ? null : portal === 'applicant' ? (
          <NavGroup title="Your applications">
            <NavLink to="/" exact>
              Overview
            </NavLink>
            <NavLink to="/enterprises">Enterprises</NavLink>
            <NavLink to="/applications">Applications</NavLink>
            <NavLink to="/cycles">Programme cycles</NavLink>
          </NavGroup>
        ) : (
          <>
            {/*
              Two groups, because the office does two different jobs: working
              individual files, and governing the programme they move through.
              Naming them by their content also stops the heading repeating the
              masthead directly above it.
            */}
            <NavGroup title="Casework">
              <NavLink to="/admin" exact>
                Intake
              </NavLink>
              <NavLink to="/admin/meetings">Committee meetings</NavLink>
            </NavGroup>

            <NavGroup title="Administration">
              <NavLink to="/admin/cycles">Cycle administration</NavLink>
              {/* Role management is a super-administrator power. An
                  administrator who cannot use it should not be shown it. */}
              {isSuperAdministrator(user) ? (
                <NavLink to="/admin/access">Access</NavLink>
              ) : null}
            </NavGroup>
          </>
        )}

        <NavGroup title="Account">
          <NavLink to="/account/sessions">Signed-in devices</NavLink>
        </NavGroup>
      </div>

      <PortalSwitch portal={portal} user={user} />
      <AccountFooter user={user} />
    </nav>
  )
}

/**
 * The way across, for an account that holds both kinds of role.
 *
 * One link rather than a tab bar: crossing between the two is a rare thing to
 * do, and a permanent switch would suggest otherwise.
 */
function PortalSwitch({ portal, user }: { portal: Portal; user: SignedInUser }) {
  // Only from a portal this account is actually working in. On a refusal the
  // screen itself offers the way across, and two of them would be noise.
  if (!canUsePortal(portal, user)) return null
  if (portal === 'applicant') {
    return isAdministrator(user) ? (
      <Link to="/admin" className={styles.switch}>
        Programme office <span aria-hidden="true">→</span>
      </Link>
    ) : null
  }
  return isApplicant(user) ? (
    <Link to="/" className={styles.switch}>
      Applicant portal <span aria-hidden="true">→</span>
    </Link>
  ) : null
}

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>{title}</p>
      {children}
    </div>
  )
}

function NavLink({
  to,
  exact,
  children,
}: {
  to: string
  /** A section root matches only itself; deeper pages still mark their section. */
  exact?: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={styles.navLink}
      activeProps={{ className: `${styles.navLink} ${styles.navLinkActive}` }}
      activeOptions={{ exact: exact ?? false }}
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
