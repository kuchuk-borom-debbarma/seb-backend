import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
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
import styles from '#/features/settings/Settings.module.css'

export const Route = createFileRoute('/_shell/settings/general')({
  component: GeneralSettings,
})

type Challenge = { challengeToken: string; expiresAt: string }

function GeneralSettings() {
  const { user } = Route.useRouteContext()
  return (
    <>
      <section className={styles.section}>
        <h2>Account</h2>
        <p className={styles.sectionDescription}>
          The identity this portal knows you by.
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

      <NameSection current={user.displayName ?? ''} />
      <EmailSection current={user.email} />
    </>
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
    <section className={styles.section}>
      <h2>Your name</h2>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div>
          <label className="field-label" htmlFor="display-name">
            Name
          </label>
          <input
            id="display-name"
            className="input"
            autoComplete="name"
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          {/*
            Deliberately not sold as an identifier. Staff find each other by
            address, and two people sharing a name is not a conflict here.
          */}
          <p className="field-hint">
            Shown instead of your email address where there is room for it. Leave it
            empty to remove it.
          </p>
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

        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save name'}
        </button>
      </form>
    </section>
  )
}

function EmailSection({ current }: { current: string }) {
  // Sequential for the same reason sign-up is: the API issues a challenge and
  // only the code sent to the new address can consume it.
  const [challenge, setChallenge] = useState<Challenge | null>(null)

  return (
    <section className={styles.section}>
      <h2>Email address</h2>
      <p className={styles.sectionDescription}>
        You sign in with <strong>{current}</strong>.
      </p>
      {challenge ? (
        <ConfirmEmailStep challenge={challenge} onRestart={() => setChallenge(null)} />
      ) : (
        <RequestEmailStep onChallenge={setChallenge} />
      )}
    </section>
  )
}

function RequestEmailStep({ onChallenge }: { onChallenge: (value: Challenge) => void }) {
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
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        start.mutate()
      }}
    >
      <div>
        <label className="field-label" htmlFor="new-email">
          New email address
        </label>
        <input
          id="new-email"
          className="input"
          type="email"
          autoComplete="email"
          required
          value={newEmail}
          onChange={(event) => setNewEmail(event.target.value)}
        />
        <p className="field-hint">
          We will send a code there to check you can read it.
        </p>
      </div>

      <div>
        <label className="field-label" htmlFor="email-current-password">
          Your password
        </label>
        <input
          id="email-current-password"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </div>

      {/*
        Stated up front rather than discovered later. An invitation is sealed
        against the address it was sent to, so changing address quietly makes an
        unaccepted one stop working, and nothing else would say why.
      */}
      <p className="notice" data-tone="action">
        <span className="notice-title">Before you change it</span>
        Any invitation sent to your current address that you have not accepted yet will
        stop working. Your other devices will be signed out.
      </p>

      {start.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(start.error)}
        </p>
      ) : null}

      <button type="submit" className="button" disabled={start.isPending}>
        {start.isPending ? 'Sending code…' : 'Send confirmation code'}
      </button>
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
      <p className="notice" data-tone="ok" role="status">
        <span className="notice-title">Address changed</span>
        You now sign in with {confirm.data.email}.
      </p>
    )
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        confirm.mutate()
      }}
    >
      <p className="notice" data-tone="action">
        <span className="notice-title">Read the code from the server console</span>
        This development build prints the six-digit code to the Wrangler output instead of
        emailing it. It expires {formatRelative(challenge.expiresAt)}.
      </p>

      <div>
        <label className="field-label" htmlFor="email-otp">
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
        />
      </div>

      {confirm.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(confirm.error)}
        </p>
      ) : null}

      <button
        type="submit"
        className="button"
        data-variant="primary"
        disabled={confirm.isPending}
      >
        {confirm.isPending ? 'Confirming…' : 'Confirm new address'}
      </button>

      <button type="button" className="button" data-variant="ghost" onClick={onRestart}>
        Use a different address
      </button>
    </form>
  )
}
