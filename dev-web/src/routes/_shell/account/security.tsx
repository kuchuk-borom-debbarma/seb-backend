import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { ChangePasswordDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { assertSucceeded, messageFor } from '#/lib/result'
import { forgetSession } from '#/lib/session'

export const Route = createFileRoute('/_shell/account/security')({
  component: SecurityPage,
})

function SecurityPage() {
  const queryClient = useQueryClient()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [mismatch, setMismatch] = useState(false)

  const change = useMutation({
    mutationFn: async () => {
      const data = await gql(ChangePasswordDocument, { currentPassword, newPassword })
      assertSucceeded(data.auth.changePassword)
    },
    onSuccess: async () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      // Other devices were signed out; this one was not. Re-reading keeps the
      // device list on the next screen honest.
      await forgetSession(queryClient)
    },
  })

  return (
    <main className="page">
      <PageHeader
        title="Password"
        description="Change the password you use to sign in."
      />

      <div className="card">
        <div className="card-body">
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault()
              /*
               * Checked here rather than by the API, because a typed-twice
               * mismatch is not a refusal — it is this screen's own job, and
               * sending it would spend a rate-limit allowance and a scrypt
               * verification to be told something the browser already knew.
               */
              const matches = newPassword === confirmation
              setMismatch(!matches)
              if (matches) change.mutate()
            }}
          >
            <div>
              <label className="field-label" htmlFor="current-password">
                Current password
              </label>
              <input
                id="current-password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
              <p className="field-hint">
                Asked for so that finding this screen already open is not enough to take
                the account over.
              </p>
            </div>

            <div>
              <label className="field-label" htmlFor="new-password">
                New password
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
              <p className="field-hint">At least 8 characters.</p>
            </div>

            <div>
              <label className="field-label" htmlFor="confirm-password">
                Repeat the new password
              </label>
              <input
                id="confirm-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={mismatch}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              {mismatch ? (
                <p className="field-error" role="alert">
                  These two do not match.
                </p>
              ) : null}
            </div>

            <p className="field-hint">
              Your other signed-in devices will be signed out. This one stays signed in.
            </p>

            {change.isError ? (
              <p className="notice" data-tone="error" role="alert">
                {messageFor(change.error)}
              </p>
            ) : null}

            {change.isSuccess ? (
              <p className="notice" data-tone="ok" role="status">
                Your password has been changed.
              </p>
            ) : null}

            <button
              type="submit"
              className="button"
              data-variant="primary"
              disabled={change.isPending}
            >
              {change.isPending ? 'Changing password…' : 'Change password'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
