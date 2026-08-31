/**
 * The signed-in platform shell.
 *
 * Navigation is offered from live capabilities, exactly like the API's own
 * authorization policy. The shell never grants authority; it only avoids
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
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SignOutDocument } from '#/graphql/generated/operations'
import { forgetGuide } from '#/features/guide/GuideContext'
import { gql } from '#/lib/graphql'
import { can, isApplicant, type SignedInUser } from '#/lib/session'
import styles from './PortalShell.module.css'
import logoEmblem from '@/assets/mission-sep-emblem.png'
import logoRightColor from '@/assets/mission-sep-right.png'

export type Portal = 'applicant' | 'office'

const SIDEBAR_PREFERENCE = 'seb.sidebar.collapsed'

/** Everything under `/admin` is the office; everything else is the applicant's. */
export const portalFor = (pathname: string): Portal =>
  pathname === '/admin' || pathname.startsWith('/admin/') ? 'office' : 'applicant'

export const canUsePortal = (portal: Portal, user: SignedInUser): boolean =>
  portal === 'office'
    ? can(user, 'STAFF_READ') || can(user, 'ANNOUNCE')
    : isApplicant(user)

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
              {can(user, 'STAFF_READ') ? (
                <NavGroup title="Workspace" collapsed={collapsed}>
                  <NavLink
                    to="/admin"
                    label="Dashboard"
                    icon={LayoutDashboard}
                    exact
                    onNavigate={onClose}
                  />
                  <NavLink
                    to="/admin/queue"
                    label="Applications"
                    icon={ClipboardList}
                    activePrefixes={['/admin/queue', '/admin/applications']}
                    onNavigate={onClose}
                  />
                </NavGroup>
              ) : null}

              {can(user, 'STAFF_WRITE') ||
              can(user, 'ROLE_ADMIN') ||
              can(user, 'ROLE_INVITE') ||
              can(user, 'AUDIT_READ') ||
              can(user, 'ANNOUNCE') ? (
                <NavGroup title="Administration" collapsed={collapsed}>
                  {can(user, 'STAFF_WRITE') ? (
                    <NavLink
                      to="/admin/cycles"
                      label="Programme cycles"
                      icon={CalendarDays}
                      activePrefixes={['/admin/cycles']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'ANNOUNCE') ? (
                    <NavLink
                      to="/admin/announcements"
                      label="Announcement banner"
                      icon={Megaphone}
                      activePrefixes={['/admin/announcements']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'ROLE_INVITE') ? (
                    <NavLink
                      to="/admin/invite"
                      label="Invite a colleague"
                      icon={UserPlus}
                      activePrefixes={['/admin/invite']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'ROLE_ADMIN') ? (
                    <NavLink
                      to="/admin/access"
                      label="Users & access"
                      icon={ShieldCheck}
                      activePrefixes={['/admin/access']}
                      onNavigate={onClose}
                    />
                  ) : null}
                  {can(user, 'AUDIT_READ') ? (
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
  const hasBoth = isApplicant(user) && can(user, 'STAFF_READ')
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
          {isApplicant(user) && can(user, 'STAFF_READ') ? (
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
