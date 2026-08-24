/**
 * A member of staff, as another member of staff sees them.
 *
 * Its own module because it is a shape rather than a mechanism: the loader
 * produces it and the admin resolver returns it, so neither owns it. It
 * imports the role vocabulary and nothing else.
 *
 * Deliberately small — who they are and what authority they hold. Everything
 * else about an account belongs to the access namespace, behind its own guard.
 */
import type { UserRole } from '../db/schema'

export type StaffMember = {
  id: string
  email: string
  roles: UserRole[]
}
