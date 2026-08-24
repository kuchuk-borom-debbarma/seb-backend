import { createFileRoute } from '@tanstack/react-router'
import { formatDate } from '#/lib/format'
import styles from '#/features/settings/Settings.module.css'

export const Route = createFileRoute('/_shell/settings/general')({
  component: GeneralSettings,
})

function GeneralSettings() {
  const { user } = Route.useRouteContext()
  return (
    <section className={styles.section}>
      <h2>Account</h2>
      <p className={styles.sectionDescription}>
        Identity details are read-only. Email changes and account closure are not
        available in this portal.
      </p>
      <dl className={styles.details}>
        <div className={styles.detail}>
          <dt>Email address</dt>
          <dd>{user.email}</dd>
        </div>
        <div className={styles.detail}>
          <dt>Verification</dt>
          <dd>
            <span className="badge" data-tone={user.emailVerified ? 'ok' : 'action'}>
              {user.emailVerified ? 'Verified' : 'Not verified'}
            </span>
          </dd>
        </div>
        <div className={styles.detail}>
          <dt>Member since</dt>
          <dd>{formatDate(user.createdAt)}</dd>
        </div>
        <div className={styles.detail}>
          <dt>Active roles</dt>
          <dd className={styles.roleList}>
            {user.roles.map((role) => (
              <span key={role} className="badge">
                {role.replaceAll('_', ' ').toLowerCase()}
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </section>
  )
}
