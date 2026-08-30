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

export type StaffMember = {
  id: string
  email: string
  /**
   * Every authority held, by name — the two decided in code, then the composed
   * roles this person holds.
   *
   * Names rather than a closed union, because a role is a row now. This is for
   * display beside somebody's work; what they may *do* is a permission, and no
   * screen should decide anything from this list.
   */
  roles: string[]
}
