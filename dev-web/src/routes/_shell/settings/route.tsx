import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { ChevronDown, Settings, Shield } from 'lucide-react'

export const Route = createFileRoute('/_shell/settings')({
  component: SettingsLayout,
})

function SettingsLayout() {
  const { user } = Route.useRouteContext()
  const initials = user.displayName
    ? user.displayName
        .split(' ')
        .filter(Boolean)
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : user.email.slice(0, 2).toUpperCase()

  const roleText = user.roles.map((r) => r.replaceAll('_', ' ').toLowerCase()).join(', ')

  return (
    <main
      style={{
        maxWidth: '1120px',
        margin: '0 auto',
        padding: '32px 28px 80px',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: '24px',
          gap: '20px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '28px',
              fontWeight: 700,
              color: 'var(--ink)',
              margin: '0 0 6px',
              letterSpacing: '-0.02em',
            }}
          >
            Settings
          </h1>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--ink-secondary)',
              margin: 0,
            }}
          >
            Your Mission SEP account details and the devices currently signed in.
          </p>
        </div>

        {/* Top Right Profile Summary */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background: '#E2E8F0',
              color: '#334155',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              fontSize: '13.5px',
            }}
          >
            {initials}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span
                style={{
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                }}
              >
                {user.displayName || user.email}
              </span>
              <ChevronDown size={14} color="var(--ink-secondary)" />
            </div>
            <span
              style={{
                fontSize: '12px',
                color: 'var(--ink-secondary)',
                textTransform: 'capitalize',
              }}
            >
              {roleText}
            </span>
          </div>
        </div>
      </div>

      {/* Top Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '28px',
          borderBottom: '1px solid #D9DDE2',
          marginBottom: '28px',
        }}
      >
        <Link
          to="/settings/general"
          activeOptions={{ exact: true }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 2px 14px',
            fontSize: '14px',
            textDecoration: 'none',
            borderBottom: '2px solid transparent',
            marginBottom: '-1px',
            color: 'var(--ink-secondary)',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          activeProps={{
            style: {
              borderBottom: '2px solid #4271B7',
              color: '#4271B7',
              fontWeight: 600,
            },
          }}
        >
          <Settings size={17} strokeWidth={2} />
          <span>General</span>
        </Link>
        <Link
          to="/settings/security"
          activeOptions={{ exact: true }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 2px 14px',
            fontSize: '14px',
            textDecoration: 'none',
            borderBottom: '2px solid transparent',
            marginBottom: '-1px',
            color: 'var(--ink-secondary)',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          activeProps={{
            style: {
              borderBottom: '2px solid #4271B7',
              color: '#4271B7',
              fontWeight: 600,
            },
          }}
        >
          <Shield size={17} strokeWidth={2} />
          <span>Security</span>
        </Link>
      </div>

      {/* Main Settings Body */}
      <div>
        <Outlet />
      </div>
    </main>
  )
}
