import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  CompletePasswordResetDocument,
  StartPasswordResetDocument,
} from '#/graphql/generated/operations'
import { formatRelative } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap, assertSucceeded } from '#/lib/result'
import { ensureSession, forgetSession } from '#/lib/session'
import styles from './sign-in.module.css'

export const Route = createFileRoute('/forgot-password')({
  beforeLoad: async ({ context }) => {
    // Somebody already signed in does not need this; the security screen
    // changes a password they still know.
    const session = await ensureSession(context.queryClient)
    if (session) throw redirect({ to: '/account/security' })
  },
  component: ForgotPasswordPage,
})

type Challenge = { challengeToken: string; expiresAt: string }

function ForgotPasswordPage() {
  // Two genuinely sequential steps, as in sign-up: the API issues a challenge
  // and only the emailed code can consume it.
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [email, setEmail] = useState('')

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <p className="eyebrow">TTAADC</p>
        <h1 className={styles.wordmark}>Mission SEP</h1>
        <p className={styles.intro}>
          {challenge
            ? 'Enter the code we sent and choose a new password.'
            : 'We will send a code to your email address so you can set a new password.'}
        </p>

        {challenge ? (
          <ResetStep challenge={challenge} onRestart={() => setChallenge(null)} />
        ) : (
          <RequestStep email={email} onEmailChange={setEmail} onChallenge={setChallenge} />
        )}

        <p className={styles.footer}>
          Remembered it? <Link to="/sign-in">Sign in</Link>
        </p>
      </div>
    </main>
  )
}

function RequestStep({
  email,
  onEmailChange,
  onChallenge,
}: {
  email: string
  onEmailChange: (value: string) => void
  onChallenge: (challenge: Challenge) => void
}) {
  const start = useMutation({
    mutationFn: async () => {
      const data = await gql(StartPasswordResetDocument, { email })
      return unwrap(data.auth.startPasswordReset)
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
        <label className="field-label" htmlFor="email">
          Email address
        </label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
        />
        {/*
          The API answers identically for an address it knows and one it does
          not, so this screen cannot promise a message will arrive. Saying so is
          honest, and it also stops the page becoming the oracle the API refuses
          to be.
        */}
        <p className="field-hint">
          If the address belongs to an account, a code will be sent to it.
        </p>
      </div>

      {start.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(start.error)}
        </p>
      ) : null}

      <button type="submit" className="button" data-variant="primary" disabled={start.isPending}>
        {start.isPending ? 'Sending code…' : 'Send reset code'}
      </button>
    </form>
  )
}

function ResetStep({
  challenge,
  onRestart,
}: {
  challenge: Challenge
  onRestart: () => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const reset = useMutation({
    mutationFn: async () => {
      const data = await gql(CompletePasswordResetDocument, {
        challengeToken: challenge.challengeToken,
        otp,
        newPassword,
      })
      assertSucceeded(data.auth.completePasswordReset)
    },
    onSuccess: async () => {
      // A reset ends every session, including any this browser held, so the
      // cached one has to go before navigating.
      await forgetSession(queryClient)
      await router.navigate({ to: '/sign-in' })
    },
  })

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        reset.mutate()
      }}
    >
      {/*
        Notification delivery is a console transport in development (roadmap
        §18). Saying so is more useful than pretending an email was sent.
      */}
      <p className="notice" data-tone="action">
        <span className="notice-title">Read the code from the server console</span>
        This development build prints the six-digit code to the Wrangler output instead of
        emailing it. It expires {formatRelative(challenge.expiresAt)}.
      </p>

      <div>
        <label className="field-label" htmlFor="otp">
          Six-digit code
        </label>
        <input
          id="otp"
          className="input"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={otp}
          onChange={(event) => setOtp(event.target.value)}
        />
      </div>

      <div>
        <label className="field-label" htmlFor="new-password">
          Choose a new password
        </label>
        <input
          id="new-password"
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <p className="field-hint">
          At least 8 characters. Every signed-in device will be signed out.
        </p>
      </div>

      {reset.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(reset.error)}
        </p>
      ) : null}

      <button type="submit" className="button" data-variant="primary" disabled={reset.isPending}>
        {reset.isPending ? 'Setting password…' : 'Set new password'}
      </button>

      <button type="button" className="button" data-variant="ghost" onClick={onRestart}>
        Use a different email address
      </button>
    </form>
  )
}
