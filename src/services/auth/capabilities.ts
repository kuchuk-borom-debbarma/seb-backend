/**
 * What each role is allowed to do.
 *
 * Every administrative operation used to ask one question — "is this person an
 * administrator?" — and the answer decided all forty of them. Splitting staff
 * into a reviewer who may only read and an approver who may only decide means
 * the operations have to start asking narrower questions, and if each one asked
 * its own the authorization rules would be spread across forty files.
 *
 * So operations name a **capability**, and this file is the only place that
 * says which roles hold it. To learn what a reviewer can do, read the table
 * below; to change it, change one line here.
 *
 * ## Why a table rather than a hierarchy
 *
 * Roles are deliberately not ranked. `APPROVER` may record a decision that
 * `REVIEWER` may not, but neither may open a programme cycle, and an ordering
 * that put approver "above" reviewer would imply they can do everything a
 * reviewer can and more — which is true today and would quietly stop being
 * checked the moment it was not. A person may hold several roles, and their
 * capabilities are the union.
 */
import type { UserRole } from '../../db/schema'

export const capabilities = [
  /** Every administrative read: the queue, a workspace, documents, funding. */
  'STAFF_READ',
  /** Intake, desk review, referral, awards, recovery. */
  'STAFF_WRITE',
  /** Creating a cycle, editing its rules and its form — the questions every applicant is judged against. */
  'CYCLE_ADMIN',
  /** Recording and correcting the programme decision, and nothing else. */
  'DECIDE',
  /** Granting and revoking a role directly. */
  'ROLE_ADMIN',
  /** Inviting somebody to a role they must accept themselves. */
  'ROLE_INVITE',
  /** Reading the audit history. */
  'AUDIT_READ',
] as const

export type Capability = (typeof capabilities)[number]

/**
 * The whole authorization policy.
 *
 * `ADMIN` deliberately lacks `ROLE_ADMIN`. `controllers/auth.ts` states the
 * reason where the super-administrator guard is defined: granting and revoking
 * authority is the one capability a plain administrator must not inherit,
 * because an administrator who can create administrators is a super
 * administrator by another name.
 *
 * `ROLE_INVITE` is a weaker thing and `ADMIN` does hold it — an invitation
 * cannot exceed the issuer's own authority (see `invite.ts`) and the person
 * invited has to accept it themselves.
 */
const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  APPLICANT: [],
  REVIEWER: ['STAFF_READ'],
  APPROVER: ['STAFF_READ', 'DECIDE'],
  ADMIN: ['STAFF_READ', 'STAFF_WRITE', 'DECIDE', 'ROLE_INVITE'],
  SUPER_ADMIN: [...capabilities],
}

/** Whether any of the roles held carries the capability. */
export const rolesHaveCapability = (
  roles: readonly UserRole[],
  capability: Capability,
): boolean => roles.some((role) => ROLE_CAPABILITIES[role].includes(capability))

/**
 * Every capability the roles held add up to.
 *
 * Used to tell a client what to offer rather than to authorize anything. A
 * screen that hides a control the caller cannot use is kinder than one that
 * shows it and refuses, but the refusal is still what enforces the rule.
 */
export const capabilitiesOf = (roles: readonly UserRole[]): Capability[] =>
  capabilities.filter((capability) => rolesHaveCapability(roles, capability))
