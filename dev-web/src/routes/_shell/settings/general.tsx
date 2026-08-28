import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Info, Lock, Mail, UserRound } from 'lucide-react'
import { useState } from 'react'
import {
  ChangeDisplayNameDocument,
  CompleteEmailChangeDocument,
  StartEmailChangeDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatRelative } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { assertSucceeded, messageFor, unwrap } from '#/lib/result'
import { forgetSession } from '#/lib/session'

export const Route = createFileRoute('/_shell/settings/general')({
  component: GeneralSettings,
})

type Challenge = { challengeToken: string; expiresAt: string; delivery: string }

function GeneralSettings() {
  const { user } = Route.useRouteContext()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Card 1: Account */}
      <section
        style={{
          background: '#ffffff',
          border: '1px solid #D9DDE2',
          borderRadius: '12px',
          padding: '24px 28px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '22px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              background: '#EBF3FC',
              color: '#4271B7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <UserRound size={22} />
          </div>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ink)', margin: '0 0 2px' }}>
              Account
            </h2>
            <p style={{ fontSize: '13.5px', color: 'var(--ink-secondary)', margin: 0 }}>
              The identity this portal knows you by.
            </p>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '24px',
            paddingLeft: '60px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ink)' }}>
              Email address
            </span>
            <span style={{ fontSize: '14px', color: 'var(--ink)' }}>{user.email}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ink)' }}>
              Verification
            </span>
            <div>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: user.emailVerified ? '#EAF5EE' : '#FEF3C7',
                  color: user.emailVerified ? '#23814C' : '#B45309',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: '6px',
                }}
              >
                {user.emailVerified ? (
                  <>
                    <Check size={14} strokeWidth={2.5} /> Verified
                  </>
                ) : (
                  'Not verified'
                )}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ink)' }}>
              Member since
            </span>
            <span style={{ fontSize: '14px', color: 'var(--ink)' }}>
              {formatDate(user.createdAt)}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ink)' }}>
              Active roles
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {user.roles.map((role) => (
                <span
                  key={role}
                  style={{
                    background: '#EBF3FC',
                    color: '#4271B7',
                    fontSize: '12.5px',
                    fontWeight: 500,
                    padding: '3px 10px',
                    borderRadius: '6px',
                  }}
                >
                  {role.replaceAll('_', ' ').toLowerCase()}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Card 2: Your name */}
      <NameSection current={user.displayName ?? ''} />

      {/* Cards 3 & 4: Email address and Password */}
      <EmailSection current={user.email} />
    </div>
  )
}

function NameSection({ current }: { current: string }) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(current)

  const save = useMutation({
    mutationFn: async () => {
      const data = await gql(ChangeDisplayNameDocument, { displayName })
      assertSucceeded(data.auth.changeDisplayName)
    },
    onSuccess: () => forgetSession(queryClient),
  })

  return (
    <section
      style={{
        background: '#ffffff',
        border: '1px solid #D9DDE2',
        borderRadius: '12px',
        padding: '24px 28px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: '#EBF3FC',
            color: '#4271B7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: '2px',
          }}
        >
          <UserRound size={22} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ink)', margin: '0 0 14px' }}>
            Your name
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate()
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
          >
            <div>
              <label
                htmlFor="display-name"
                style={{
                  display: 'block',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                  marginBottom: '4px',
                }}
              >
                Name
              </label>
              <p
                style={{
                  fontSize: '13px',
                  color: 'var(--ink-secondary)',
                  margin: '0 0 8px',
                }}
              >
                Shown instead of your email address where there is room for it. Leave it empty to
                remove it.
              </p>
              <input
                id="display-name"
                className="input"
                autoComplete="name"
                maxLength={120}
                placeholder="Enter your full name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #D9DDE2',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {save.isError ? (
              <p className="notice" data-tone="error" role="alert">
                {messageFor(save.error)}
              </p>
            ) : null}

            {save.isSuccess ? (
              <p className="notice" data-tone="ok" role="status">
                Your name has been saved.
              </p>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={save.isPending}
                style={{
                  background: '#4271B7',
                  color: '#ffffff',
                  padding: '9px 22px',
                  borderRadius: '6px',
                  fontSize: '13.5px',
                  fontWeight: 500,
                }}
              >
                {save.isPending ? 'Saving…' : 'Save name'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  )
}

function EmailSection({ current }: { current: string }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null)

  if (challenge) {
    return (
      <section
        style={{
          background: '#ffffff',
          border: '1px solid #D9DDE2',
          borderRadius: '12px',
          padding: '24px 28px',
        }}
      >
        <ConfirmEmailStep challenge={challenge} onRestart={() => setChallenge(null)} />
      </section>
    )
  }

  return <RequestEmailSteps current={current} onChallenge={setChallenge} />
}

function RequestEmailSteps({
  current,
  onChallenge,
}: {
  current: string
  onChallenge: (value: Challenge) => void
}) {
  const [newEmail, setNewEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')

  const start = useMutation({
    mutationFn: async () => {
      const data = await gql(StartEmailChangeDocument, { newEmail, currentPassword })
      return unwrap(data.auth.startEmailChange)
    },
    onSuccess: onChallenge,
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        start.mutate()
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
    >
      {/* Card 3: Email address */}
      <section
        style={{
          background: '#ffffff',
          border: '1px solid #D9DDE2',
          borderRadius: '12px',
          padding: '24px 28px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              background: '#EBF3FC',
              color: '#4271B7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              marginTop: '2px',
            }}
          >
            <Mail size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <h2
              style={{
                fontSize: '18px',
                fontWeight: 700,
                color: 'var(--ink)',
                margin: '0 0 4px',
              }}
            >
              Email address
            </h2>
            <p
              style={{
                fontSize: '13.5px',
                color: 'var(--ink-secondary)',
                margin: '0 0 16px',
              }}
            >
              You sign in with <strong>{current}</strong>.
            </p>

            <div>
              <label
                htmlFor="new-email"
                style={{
                  display: 'block',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                  marginBottom: '6px',
                }}
              >
                New email address
              </label>
              <input
                id="new-email"
                className="input"
                type="email"
                autoComplete="email"
                placeholder="Enter new email address"
                required
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #D9DDE2',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
              <p
                style={{
                  fontSize: '12.5px',
                  color: 'var(--ink-secondary)',
                  margin: '6px 0 0',
                }}
              >
                We will send a code there to check you can read it.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Card 4: Your password */}
      <section
        style={{
          background: '#ffffff',
          border: '1px solid #D9DDE2',
          borderRadius: '12px',
          padding: '24px 28px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              background: '#EBF3FC',
              color: '#4271B7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              marginTop: '2px',
            }}
          >
            <Lock size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <h2
              style={{
                fontSize: '18px',
                fontWeight: 700,
                color: 'var(--ink)',
                margin: '0 0 16px',
              }}
            >
              Your password
            </h2>

            <div style={{ marginBottom: '16px' }}>
              <label
                htmlFor="email-current-password"
                style={{
                  display: 'block',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                  marginBottom: '6px',
                }}
              >
                Current password
              </label>
              <input
                id="email-current-password"
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder="Enter current password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #D9DDE2',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '20px',
                flexWrap: 'wrap',
              }}
            >
              {/* Notice Box */}
              <div
                style={{
                  background: '#F0F5FC',
                  border: '1px solid #D6E4F8',
                  borderRadius: '8px',
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  flex: 1,
                  minWidth: '280px',
                }}
              >
                <div
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: '#4271B7',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: '2px',
                  }}
                >
                  <Info size={13} strokeWidth={2.5} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 700, color: 'var(--ink)' }}>
                    Before you change it
                  </span>
                  <span
                    style={{
                      fontSize: '12.5px',
                      color: 'var(--ink-secondary)',
                      lineHeight: 1.45,
                    }}
                  >
                    Any invitation sent to your current address that you have not accepted yet will
                    stop working.
                    <br />
                    Your other devices will be signed out.
                  </span>
                </div>
              </div>

              {/* Action Button */}
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={start.isPending}
                style={{
                  background: '#4271B7',
                  color: '#ffffff',
                  padding: '10px 22px',
                  borderRadius: '6px',
                  fontSize: '13.5px',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                {start.isPending ? 'Sending code…' : 'Send confirmation code'}
              </button>
            </div>

            {start.isError ? (
              <p className="notice" data-tone="error" role="alert" style={{ marginTop: '16px' }}>
                {messageFor(start.error)}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </form>
  )
}

function ConfirmEmailStep({
  challenge,
  onRestart,
}: {
  challenge: Challenge
  onRestart: () => void
}) {
  const queryClient = useQueryClient()
  const [otp, setOtp] = useState('')

  const confirm = useMutation({
    mutationFn: async () => {
      const data = await gql(CompleteEmailChangeDocument, {
        challengeToken: challenge.challengeToken,
        otp,
      })
      return unwrap(data.auth.completeEmailChange)
    },
    onSuccess: () => forgetSession(queryClient),
  })

  if (confirm.isSuccess) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <p className="notice" data-tone="ok" role="status">
          <span className="notice-title">Address changed</span>
          You now sign in with {confirm.data.email}.
        </p>
      </div>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        confirm.mutate()
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ink)', margin: 0 }}>
        Confirm new email address
      </h2>

      {challenge.delivery === 'CONSOLE' ? (
        <p className="notice" data-tone="action">
          <span className="notice-title">Read the code from the server console</span>
          This development server prints the six-digit code to its log instead of emailing it. It
          expires {formatRelative(challenge.expiresAt)}.
        </p>
      ) : (
        <p className="notice" data-tone="action">
          <span className="notice-title">Check the new address&rsquo;s inbox</span>
          We emailed a six-digit code to the new address. It expires{' '}
          {formatRelative(challenge.expiresAt)}.
        </p>
      )}

      <div>
        <label
          htmlFor="email-otp"
          style={{
            display: 'block',
            fontSize: '13.5px',
            fontWeight: 600,
            color: 'var(--ink)',
            marginBottom: '6px',
          }}
        >
          Six-digit code
        </label>
        <input
          id="email-otp"
          className="input"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={otp}
          onChange={(event) => setOtp(event.target.value)}
          style={{
            width: '100%',
            maxWidth: '320px',
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid #D9DDE2',
            fontSize: '16px',
            letterSpacing: '0.1em',
          }}
        />
      </div>

      {confirm.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(confirm.error)}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={confirm.isPending}
          style={{
            background: '#4271B7',
            color: '#ffffff',
            padding: '10px 22px',
            borderRadius: '6px',
            fontSize: '13.5px',
          }}
        >
          {confirm.isPending ? 'Confirming…' : 'Confirm new address'}
        </button>

        <button
          type="button"
          className="button"
          data-variant="ghost"
          onClick={onRestart}
          style={{ fontSize: '13.5px' }}
        >
          Use a different address
        </button>
      </div>
    </form>
  )
}
