import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { formatDate } from '#/lib/format'
import { isAdministrator, isApplicant, isSuperAdministrator } from '#/lib/session'

export const Route = createFileRoute('/_shell/app/')({
  component: OverviewPage,
})

/**
 * What this account can currently do.
 *
 * Deliberately reports capability rather than inventing statistics: the
 * applicant screens that would supply counts are not built yet, and a number
 * nobody can click through to would be decoration.
 */
function OverviewPage() {
  const { user } = Route.useRouteContext()

  return (
    <main className="page">
      <PageHeader
        title="Overview"
        description="Mission SEP is the TTAADC seed-funding programme for first-generation Scheduled Tribe entrepreneurs."
      />

      <div className="card">
        <div className="card-header">
          <div>
            <p className="eyebrow">Your account</p>
            <h2 style={{ marginTop: '0.25rem' }}>{user.email}</h2>
          </div>
          <span className="badge" data-tone={user.emailVerified ? 'ok' : 'action'}>
            {user.emailVerified ? 'Email verified' : 'Email not verified'}
          </span>
        </div>
        <div className="card-body">
          <div className="detail-grid">
            <div>
              <span className="field-label">Roles held</span>
              <div className="row" style={{ gap: '0.375rem', flexWrap: 'wrap' }}>
                {user.roles.map((role) => (
                  <span key={role} className="badge">
                    {role.replace('_', ' ').toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <span className="field-label">Member since</span>
              <span>{formatDate(user.createdAt)}</span>
            </div>
          </div>

          <div style={{ marginTop: '1.5rem' }} className="stack">
            <p className="field-label" style={{ marginBottom: 0 }}>
              What these roles allow
            </p>
            {isApplicant(user) ? (
              <p className="notice" data-tone="ok">
                <span className="notice-title">Applicant</span>
                Register enterprises and apply for seed funding in an open
                programme cycle.
              </p>
            ) : null}
            {isAdministrator(user) ? (
              <p className="notice" data-tone="ok">
                <span className="notice-title">Programme officer</span>
                Review submitted applications, record partner-bank and committee
                decisions, and administer awards.
              </p>
            ) : null}
            {isSuperAdministrator(user) ? (
              <p className="notice" data-tone="ok">
                <span className="notice-title">Super administrator</span>
                Grant and revoke administrative roles for other people.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  )
}
