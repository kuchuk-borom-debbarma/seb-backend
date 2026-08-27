import { createFileRoute, redirect } from '@tanstack/react-router'

/** Keeps old bookmarks working after profile moved into account settings. */
export const Route = createFileRoute('/_shell/account/profile')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/general' })
  },
})
