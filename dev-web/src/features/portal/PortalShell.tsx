/**
 * The signed-in platform shell.
 *
 * Navigation is offered from live permissions, read from the same session the
 * API authorizes against. The shell never grants authority; it only avoids
 * presenting controls the next request would refuse.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  CalendarDays,
  ChevronUp,
  CircleHelp,
  ClipboardList,
  FileText,
  History,
  Home,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  MonitorSmartphone,
  Settings,
  Shield,
  ShieldCheck,
  UserPlus,
  UserRound,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SignOutDocument } from '#/graphql/generated/operations'
import { forgetGuide } from '#/features/guide/GuideContext'
import { gql } from '#/lib/graphql'
import {
  belongsInTheOffice,
  holdsOnlyTheBanner,
  can,
  isApplicant,
  isSuperAdministrator,
  type SignedInUser,
} from '#/lib/session'
import styles from './PortalShell.module.css'
import logoEmblem from '@/assets/mission-sep-emblem.png'
import logoRightColor from '@/assets/mission-sep-right.png'

export type Portal = 'applicant' | 'office'

const SIDEBAR_PREFERENCE = 'seb.sidebar.collapsed'

/** Everything under `/admin` is the office; everything else is the applicant's. */
export const portalFor = (pathname: string): Portal =>
  pathname === '/admin' || pathname.startsWith('/admin/') ? 'office' : 'applicant'

/**
 * Whether this portal's navigation is somebody's to use.
 *
 * The office half is `belongsInTheOffice`, shared with the door in
 * `admin/route.tsx` rather than restated. Asking a narrower question here than
 * the door asks renders an office shell with an empty sidebar — admitted to the
 * building, shown no way to the room you hold.
 */
export const canUsePortal = (portal: Portal, user: SignedInUser): boolean =>
  portal === 'office' ? belongsInTheOffice(user) : isApplicant(user)

/** Draw the navigation that works when somebody opens a portal they cannot use. */
export const navPortalFor = (addressed: Portal, user: SignedInUser): Portal => {
  if (canUsePortal(addressed, user)) return addressed
  const other: Portal = addressed === 'office' ? 'applicant' : 'office'
  return canUsePortal(other, user) ? other : addressed
}

export function PlatformNavigation({
  portal,
  user,
  open,
  onClose,
  collapsed,
  onToggleCollapsed,
}: {
  portal: Portal
  user: SignedInUser
  open: boolean
  onClose: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  /*
   * How many links the Administration group would hold.
   *
   * Counted from the same conditions the links themselves use, so the group
   * cannot be drawn empty and cannot hide a link it contains — which a separate
   * list of permissions did both of, in turn.
   */
  const administrationLinks = [
    can(user, 'programme_cycle', 'read'),
    can(user, 'pipeline', 'read'),
    can(user, 'announcement', 'read'),
    // Both, because the invite screen looks somebody up before it can offer
    // anything — the same pair its own gate asks for.
    can(user, 'role', 'invite') && can(user, 'user', 'read'),
    can(user, 'role', 'read'),
    isSuperAdministrator(user),
    can(user, 'audit', 'read'),
  ].filter(Boolean).length

  const pathname = useLocation().pathname
  const isSettingsActive =
    pathname.startsWith('/settings') || pathname.startsWith('/account/')

  return (
    <nav
      className={styles.sidebar}
      data-open={open ? 'true' : undefined}
      aria-label="Portal sections"
    >
      <div className={styles.sidebarTop}>
        <PortalSelector
          portal={portal}
          user={user}
          collapsed={collapsed}
          onNavigate={onClose}
        />
        <button
          type="button"
          className={styles.mobileClose}
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <div className={styles.groups}>
        {canUsePortal(portal, user) ? (
          portal === 'applicant' ? (
            <NavGroup title="Workspace" collapsed={collapsed}>
              <NavLink
                to="/dashboard"
                label="Dashboard"
                icon={Home}
                exact
                onNavigate={onClose}
              />
              <NavLink
                to="/applications"
                label="Applications"
                icon={FileText}
                activePrefixes={['/applications']}
                onNavigate={onClose}
              />
              <NavLink
                to="/enterprises"
                label="Enterprises"
                icon={Briefcase}
                activePrefixes={['/enterprises']}
                onNavigate={onClose}
              />
              <NavLink
                to="/cycles"
                label="Programme cycles"
                icon={CalendarDays}
                activePrefixes={['/cycles']}
                onNavigate={onClose}
              />
            </NavGroup>
          ) : (
            <>
              {/*
                * The dashboard is where sign-in lands every member of staff, so
                * it is offered to anybody the door admitted — not only to
                * casework readers. A role composed of `analytics`/`read` alone
                * has the dashboard's reporting panel and nothing else, and
                * gating this on casework left it with no link to its own screen.
                *
                * The one exception is the holder of nothing but the banner,
                * because the door itself forwards them off `/admin` — so the
                * link would say Dashboard and land on the announcement board.
                * Asked with the door's own predicate, not a second one.
                */}
              {holdsOnlyTheBanner(user) ? null : (
                <NavGroup title="Workspace" collapsed={collapsed}>
                  <NavLink
                    to="/admin"
                    label="Dashboard"
                    icon={LayoutDashboard}
                    exact
                    onNavigate={onClose}
                  />
                  {can(user, 'application', 'read') ? (
                    <NavLink
                      to="/admin/queue"
                      label="Applications"
                      icon={ClipboardList}
                      activePrefixes={['/admin/queue', '/admin/applications']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'stage', 'read') ? (
                    <NavLink
                      to="/admin/stages"
                      label="My stages"
                      icon={Inbox}
                      activePrefixes={['/admin/stages']}
                      onNavigate={onClose}
                    />
                  ) : null}
                </NavGroup>
              )}

              {/*
                * Shown only when it would hold something. Every term below is a
                * link drawn beneath it, so the condition cannot drift from the
                * contents the way a separate list of permissions would.
                */}
              {administrationLinks > 0 ? (
                <NavGroup title="Administration" collapsed={collapsed}>
                  {can(user, 'programme_cycle', 'read') ? (
                    <NavLink
                      to="/admin/cycles"
                      label="Programme cycles"
                      icon={CalendarDays}
                      activePrefixes={['/admin/cycles']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'pipeline', 'read') ? (
                    <NavLink
                      to="/admin/pipelines"
                      label="Pipelines"
                      icon={Workflow}
                      activePrefixes={['/admin/pipelines']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'announcement', 'read') ? (
                    <NavLink
                      to="/admin/announcements"
                      label="Announcement banner"
                      icon={Megaphone}
                      activePrefixes={['/admin/announcements']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'role', 'invite') && can(user, 'user', 'read') ? (
                    <NavLink
                      to="/admin/invite"
                      label="Invite a colleague"
                      icon={UserPlus}
                      activePrefixes={['/admin/invite']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'role', 'read') ? (
                    <NavLink
                      to="/admin/roles"
                      label="Roles"
                      icon={KeyRound}
                      activePrefixes={['/admin/roles']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {/*
                    * Granting and revoking is the super administrator's alone
                    * and deliberately has no permission to name — see
                    * `auth/permissions.ts`. Asked as an identity here because
                    * that is what the API asks.
                    */}
                  {isSuperAdministrator(user) ? (
                    <NavLink
                      to="/admin/access"
                      label="Users & access"
                      icon={ShieldCheck}
                      activePrefixes={['/admin/access']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'audit', 'read') ? (
                    <NavLink
                      to="/admin/audit"
                      label="Activity history"
                      icon={History}
                      activePrefixes={['/admin/audit']}
                      onNavigate={onClose}
                    />
                  ) : null}
                </NavGroup>
              ) : null}
            </>
          )
        ) : null}
      </div>

      <div className={styles.utilities}>
        <NavLink
          to="/guide"
          label="How this works"
          icon={CircleHelp}
          activePrefixes={['/guide']}
          onNavigate={onClose}
        />
        {isSettingsActive && !collapsed ? (
          <div>
            <div
              className={`${styles.navLink} ${styles.navLinkActive}`}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Settings aria-hidden="true" />
                <span className={styles.navLabel}>Settings</span>
              </div>
              <ChevronUp size={16} color="#4271B7" />
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                paddingLeft: '14px',
                marginTop: '2px',
              }}
            >
              <NavLink
                to="/settings/general"
                label="General"
                icon={UserRound}
                activePrefixes={['/settings/general']}
                onNavigate={onClose}
              />
              <NavLink
                to="/settings/security"
                label="Security"
                icon={Shield}
                activePrefixes={['/settings/security', '/account/sessions']}
                onNavigate={onClose}
              />
            </div>
          </div>
        ) : (
          <NavLink
            to="/settings/general"
            label="Settings"
            icon={Settings}
            activePrefixes={['/settings', '/account/sessions']}
            onNavigate={onClose}
          />
        )}
        <button
          type="button"
          className={`${styles.navLink} ${styles.collapse}`}
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {collapsed ? (
            <ArrowRight aria-hidden="true" />
          ) : (
            <ArrowLeft aria-hidden="true" />
          )}
          <span className={styles.navLabel}>
            {collapsed ? 'Expand navigation' : 'Collapse navigation'}
          </span>
        </button>
      </div>

      <AccountMenu
        portal={portal}
        user={user}
        collapsed={collapsed}
        onNavigate={onClose}
      />
    </nav>
  )
}

export function MobileHeader({
  portal,
  onOpen,
  triggerRef,
}: {
  portal: Portal
  onOpen: () => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
}) {
  return (
    <header className={styles.mobileHeader}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.iconButton}
        aria-label="Open navigation"
        onClick={onOpen}
      >
        <Menu aria-hidden="true" />
      </button>
      <img src={logoEmblem} alt="TTAADC Seal" className={styles.mobileEmblem} />
      <img src={logoRightColor} alt="Mission SEP" className={styles.mobileLogo} />
      <span className={styles.mobilePortal}>
        {portal === 'applicant' ? 'Applicant' : 'Programme office'}
      </span>
    </header>
  )
}

export function NavigationBackdrop({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <button
      type="button"
      className={styles.backdrop}
      data-open={open ? 'true' : undefined}
      aria-label="Close navigation"
      tabIndex={open ? 0 : -1}
      onClick={onClose}
    />
  )
}

export const usePlatformNavigation = () => {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_PREFERENCE) === 'true')
  }, [])

  useEffect(() => {
    if (!open) return
    const navigation = document.querySelector<HTMLElement>(
      'nav[aria-label="Portal sections"]',
    )
    const first = navigation?.querySelector<HTMLElement>('button, a[href]')
    first?.focus()
    document.body.dataset.navigationOpen = 'true'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (event.key !== 'Tab' || !navigation) return
      const focusable = [
        ...navigation.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'),
      ]
      const firstFocusable = focusable[0]
      const lastFocusable = focusable.at(-1)
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault()
        lastFocusable?.focus()
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault()
        firstFocusable?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      delete document.body.dataset.navigationOpen
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current
      window.localStorage.setItem(SIDEBAR_PREFERENCE, String(next))
      return next
    })
  }

  const closeNavigation = () => {
    const shouldRestoreFocus = open
    setOpen(false)
    if (shouldRestoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
  }

  return {
    open,
    collapsed,
    triggerRef,
    openNavigation: () => setOpen(true),
    closeNavigation,
    toggleCollapsed,
  }
}

function PortalSelector({
  portal,
  user,
  collapsed,
  onNavigate,
}: {
  portal: Portal
  user: SignedInUser
  collapsed: boolean
  onNavigate: () => void
}) {
  const selectorRef = useRef<HTMLDetailsElement | null>(null)
  /*
   * Asked the way the door asks it. This read `application`/`read`, so somebody
   * holding an announcement-only or audit-only role beside their applicant
   * grant was admitted to the office and then offered no way back into it —
   * the door/navigation disagreement `belongsInTheOffice` exists to end.
   */
  const hasBoth = isApplicant(user) && belongsInTheOffice(user)
  const label = portal === 'applicant' ? 'Applicant' : 'Programme office'

  const closeSelector = () => {
    selectorRef.current?.removeAttribute('open')
    onNavigate()
  }

  if (!hasBoth) {
    return (
      <div
        className={styles.portalLabel}
        title={collapsed ? `Mission SEP · ${label}` : undefined}
      >
        <div className={styles.brandContainer}>
          <div className={styles.brandLogoRow}>
            <img src={logoEmblem} alt="TTAADC Seal" className={styles.brandEmblem} />
            <img src={logoRightColor} alt="Mission SEP" className={styles.brandLogo} />
          </div>
          <span className={styles.brandRoleText}>{label}</span>
        </div>
      </div>
    )
  }

  return (
    <details className={styles.portalSelector} ref={selectorRef}>
      <summary title={collapsed ? `Mission SEP · ${label}` : undefined}>
        <div className={styles.brandContainer}>
          <div className={styles.brandLogoRow}>
            <img src={logoEmblem} alt="TTAADC Seal" className={styles.brandEmblem} />
            <img src={logoRightColor} alt="Mission SEP" className={styles.brandLogo} />
            <span className={styles.selectorChevron} aria-hidden="true">
              ⌄
            </span>
          </div>
          <span className={styles.brandRoleText}>{label}</span>
        </div>
      </summary>
      <div className={styles.portalMenu}>
        <p>Switch portal</p>
        <Link to="/dashboard" className={styles.menuItem} onClick={closeSelector}>
          Applicant
        </Link>
        <Link to="/admin" className={styles.menuItem} onClick={closeSelector}>
          Programme office
        </Link>
      </div>
    </details>
  )
}

function NavGroup({
  title,
  collapsed,
  children,
}: {
  title: string
  collapsed: boolean
  children: React.ReactNode
}) {
  return (
    <section className={styles.group} aria-label={collapsed ? title : undefined}>
      <p className={styles.groupTitle}>{title}</p>
      {children}
    </section>
  )
}

function NavLink({
  to,
  label,
  icon: Icon,
  exact = false,
  activePrefixes,
  onNavigate,
}: {
  to: string
  label: string
  icon: LucideIcon
  exact?: boolean
  activePrefixes?: string[]
  onNavigate: () => void
}) {
  const pathname = useLocation().pathname
  const active = exact
    ? pathname === to
    : (activePrefixes ?? [to]).some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      )

  return (
    <Link
      to={to}
      className={`${styles.navLink} ${active ? styles.navLinkActive : ''}`}
      aria-current={active ? 'page' : undefined}
      title={label}
      onClick={onNavigate}
    >
      <Icon aria-hidden="true" />
      <span className={styles.navLabel}>{label}</span>
    </Link>
  )
}

function AccountMenu({
  portal,
  user,
  collapsed,
  onNavigate,
}: {
  portal: Portal
  user: SignedInUser
  collapsed: boolean
  onNavigate: () => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissByKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        menuRef.current
          ?.querySelector<HTMLButtonElement>('[aria-label="Account menu"]')
          ?.focus()
      }
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', dismissByKeyboard)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', dismissByKeyboard)
    }
  }, [open])

  const signOut = useMutation({
    mutationFn: async () => {
      const data = await gql(SignOutDocument)
      return data.auth.signOut
    },
    onSuccess: async () => {
      // Everything cached belongs to this identity. It must never be visible
      // for a moment to the person who signs in next.
      queryClient.clear()
      forgetGuide()
      await router.navigate({ to: '/' })
    },
  })

  const roles = user.roles
    .map((role) => role.replaceAll('_', ' ').toLowerCase())
    .join(' · ')

  return (
    <div className={styles.account} ref={menuRef}>
      <button
        type="button"
        className={styles.accountButton}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title={collapsed ? user.email : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {user.email.slice(0, 1).toUpperCase()}
        </span>
        <span className={styles.accountText}>
          <strong>{user.email}</strong>
          <small>{roles}</small>
        </span>
        <span className={styles.accountChevron} aria-hidden="true">
          •••
        </span>
      </button>
      {open ? (
        <div className={styles.accountPopover} role="menu">
          <div className={styles.accountSummary}>
            <strong>{user.email}</strong>
            <span>{roles}</span>
          </div>
          <Link
            to="/settings/general"
            className={styles.menuItem}
            role="menuitem"
            onClick={onNavigate}
          >
            <Settings aria-hidden="true" /> Settings
          </Link>
          <Link
            to="/settings/security"
            className={styles.menuItem}
            role="menuitem"
            onClick={onNavigate}
          >
            <MonitorSmartphone aria-hidden="true" /> Security
          </Link>
          {isApplicant(user) && belongsInTheOffice(user) ? (
            <Link
              to={portal === 'applicant' ? '/admin' : '/dashboard'}
              className={styles.menuItem}
              role="menuitem"
              onClick={onNavigate}
            >
              <Users aria-hidden="true" />
              {portal === 'applicant' ? 'Programme office' : 'Applicant portal'}
            </Link>
          ) : null}
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <LogOut aria-hidden="true" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
