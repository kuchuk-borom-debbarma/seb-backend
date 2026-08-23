import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  StartApplicantSignupDocument,
  VerifyApplicantSignupDocument,
} from '#/graphql/generated/operations'
import { formatRelative } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { ensureSession, forgetSession } from '#/lib/session'
import styles from './sign-in.module.css'

export const Route = createFileRoute('/sign-up')({
  beforeLoad: async ({ context }) => {
    const session = await ensureSession(context.queryClient)
    if (session) throw redirect({ to: '/app' })
  },
  component: SignUpPage,
})

type Challenge = { challengeToken: string; expiresAt: string }

function SignUpPage() {
  // The API issues a challenge first and consumes it with the code, so the two
  // steps are genuinely sequential rather than one form split for looks.
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [email, setEmail] = useState('')

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <p className="eyebrow">TTAADC</p>
        <h1 className={styles.wordmark}>Mission SEP</h1>
        <p className={styles.intro}>
          {challenge
            ? 'Enter the code we sent and choose a password.'
            : 'Create an account to apply for seed funding.'}
        </p>

        {challenge ? (
          <VerifyStep
            email={email}
            challenge={challenge}
            onRestart={() => setChallenge(null)}
          />
        ) : (
          <RequestStep
            email={email}
            onEmailChange={setEmail}
            onChallenge={setChallenge}
          />
        )}

        <p className={styles.footer}>
          Already registered? <Link to="/sign-in">Sign in</Link>
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
      const data = await gql(StartApplicantSignupDocument, { email })
      return unwrap(data.auth.startApplicantSignup)
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
      </div>

      {start.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(start.error)}
        </p>
      ) : null}

      <button
        type="submit"
        className="button"
        data-variant="primary"
        disabled={start.isPending}
      >
        {start.isPending ? 'Sending code…' : 'Send verification code'}
      </button>
    </form>
  )
}

function VerifyStep({
  email,
  challenge,
  onRestart,
}: {
  email: string
  challenge: Challenge
  onRestart: () => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [otp, setOtp] = useState('')
  const [password, setPassword] = useState('')

  const verify = useMutation({
    mutationFn: async () => {
      const data = await gql(VerifyApplicantSignupDocument, {
        challengeToken: challenge.challengeToken,
        otp,
        password,
      })
      return unwrap(data.auth.verifyApplicantSignup)
    },
    onSuccess: async () => {
      // Verified signup creates the account but deliberately does not create a
      // session, so the person still has to sign in.
      await forgetSession(queryClient)
      await router.navigate({ to: '/sign-in' })
    },
  })

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        verify.mutate()
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
          Six-digit code sent to {email}
        </label>
        <input
          id="otp"
          className="input tabular"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={otp}
          onChange={(event) => setOtp(event.target.value)}
        />
      </div>

      <div>
        <label className="field-label" htmlFor="password">
          Choose a password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      {verify.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(verify.error)}
        </p>
      ) : null}

      <button
        type="submit"
        className="button"
        data-variant="primary"
        disabled={verify.isPending}
      >
        {verify.isPending ? 'Creating account…' : 'Create account'}
      </button>
      <button type="button" className="button" data-variant="ghost" onClick={onRestart}>
        Use a different email address
      </button>
    </form>
  )
}
