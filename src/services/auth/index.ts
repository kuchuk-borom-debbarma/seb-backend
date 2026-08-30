export {
  createRole,
  deleteRole,
  invitableRoles,
  permissionCatalogue,
  roleByKey,
  roles,
  updateRole,
} from './controllers/roles'
export type { PermissionCatalogue } from './controllers/roles'
export {
  acceptRoleInvite,
  grantRole,
  inviteRole,
  managedUserByEmail,
  managedUserById,
  revokeRole,
} from './controllers/access'
export {
  changeDisplayName,
  changePassword,
  completeEmailChange,
  completePasswordReset,
  startEmailChange,
  startPasswordReset,
} from './controllers/account'
export type { ManagedRole } from './queries/roles'
export type { Action, ActionOf, Permission, Resource } from './permissions'
export { catalogue, permissionKey, actionDescriptions, resourceDescriptions, grants } from './permissions'
export {
  authenticatedApplicant,
  authenticatedSuperAdministrator,
  authenticatedWithPermission,
  bootstrapFirstSuperAdmin,
  cleanupExpiredAuthentication,
  currentSession,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  sessions,
  signIn,
  signOut,
  startApplicantSignup,
  verifyApplicantSignup,
} from './controllers/auth'
export { isValidBootstrapSecret } from './crypto'
export type * from './types'
