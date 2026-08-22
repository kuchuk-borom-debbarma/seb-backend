import { createFileRoute, redirect } from '@tanstack/react-router'
import { ensureSession } from '#/lib/session'

/** The root address is a signpost, not a page: it sends you where you belong. */
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const session = await ensureSession(context.queryClient)
    throw redirect({ to: session ? '/app' : '/sign-in' })
  },
})
