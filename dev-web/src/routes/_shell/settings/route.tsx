import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { MonitorSmartphone, UserRound } from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import styles from '#/features/settings/Settings.module.css'

export const Route = createFileRoute('/_shell/settings')({
  component: SettingsLayout,
})

function SettingsLayout() {
  return (
    <main className="page">
      <PageHeader
        title="Settings"
        description="Your Mission SEP account details and the devices currently signed in."
      />
      <div className={styles.layout}>
        <nav className={styles.navigation} aria-label="Settings sections">
          <Link to="/settings/general" activeOptions={{ exact: true }}>
            <UserRound aria-hidden="true" /> General
          </Link>
          <Link to="/settings/security" activeOptions={{ exact: true }}>
            <MonitorSmartphone aria-hidden="true" /> Security
          </Link>
        </nav>
        <div className={styles.content}>
          <Outlet />
        </div>
      </div>
    </main>
  )
}
