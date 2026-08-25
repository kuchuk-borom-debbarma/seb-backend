import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { SignInDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { ensureSession, forgetSession, isApplicant } from '#/lib/session'
import styles from './sign-in.module.css'

export const Route = createFileRoute('/sign-in')({
  // `next` is set by the shell when it turns away an expired session, so the
  // person returns to the page they asked for instead of the overview.
  // Returning the key only when present keeps it optional for callers and
  // keeps `/sign-in` free of an empty query string.
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  // Resolved before the form renders, so an already-signed-in person is sent
  // straight on rather than shown a form that would immediately redirect.
  beforeLoad: async ({ context }) => {
    const session = await ensureSession(context.queryClient)
    if (session) throw redirect({ to: '/' })
  },
  component: SignInPage,
})

function SignInPage() {
  const router = useRouter()
  const { next } = Route.useSearch()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const signIn = useMutation({
    mutationFn: async () => {
      const data = await gql(SignInDocument, { email, password })
      return unwrap(data.auth.signIn)
    },
    onSuccess: async (signedIn) => {
      // The cookie has just changed, so the cached signed-out answer is wrong
      // rather than stale. It has to be discarded, not invalidated: this query
      // has no observers, so an invalidation would never refetch it and the
      // next guard would turn us straight back to this page.
      await forgetSession(queryClient)
      /*
       * Return to whatever the shell turned away; otherwise go to the portal
       * this account's roles fit. An officer who holds no applicant grant would
       * otherwise be told they are not an applicant every single time they
       * signed in.
       *
       * `next` is router-produced, but it still goes through `to` rather than
       * an open redirect: only in-app paths are accepted.
       */
      const home = isApplicant(signedIn.user) ? '/' : '/admin'
      await router.navigate({ to: next?.startsWith('/') ? next : home })
    },
  })

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <p className="eyebrow">TTAADC</p>
        <h1 className={styles.wordmark}>Mission SEP</h1>
        <p className={styles.intro}>
          Sign in to manage your enterprise and applications.
        </p>

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            signIn.mutate()
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
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {signIn.isError ? (
            <p className="notice" data-tone="error" role="alert">
              {messageFor(signIn.error)}
            </p>
          ) : null}

          <button
            type="submit"
            className="button"
            data-variant="primary"
            disabled={signIn.isPending}
          >
            {signIn.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className={styles.footer}>
          <Link to="/forgot-password">Forgotten your password?</Link>
          <br />
          Applying for the first time? <Link to="/sign-up">Create an account</Link>
        </p>
      </div>
    </main>
  )
}
