import { createFileRoute, redirect } from '@tanstack/react-router'

/** Keeps old bookmarks working after the sign-in screen moved to /login. */
export const Route = createFileRoute('/sign-in')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/login', search: search as never })
  },
})
