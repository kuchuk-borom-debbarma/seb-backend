import { createFileRoute, redirect } from '@tanstack/react-router'

/** Keeps old bookmarks working after sessions moved into account settings. */
export const Route = createFileRoute('/_shell/account/sessions')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/security' })
  },
})
