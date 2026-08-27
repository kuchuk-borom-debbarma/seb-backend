import { createFileRoute, redirect } from '@tanstack/react-router'

/** Keeps old bookmarks working after security moved into account settings. */
export const Route = createFileRoute('/_shell/account/security')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/security' })
  },
})
