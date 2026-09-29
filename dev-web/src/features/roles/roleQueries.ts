/**
 * The roles the office composed, and everything one may be given.
 *
 * Roles are data now, so no screen carries a list of its own. A picker that did
 * would be a second copy of what the office decided, and would go on offering a
 * role after it was retired — or miss one somebody added this morning.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  InvitableRolesDocument,
  PermissionCatalogueDocument,
  RoleByKeyDocument,
  RolesDocument,
  type RoleFieldsFragment,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'

export type Role = RoleFieldsFragment

export const rolesQuery = queryOptions({
  queryKey: ['roles'],
  queryFn: async () => (await gql(RolesDocument)).access.roles,
  // Roles decide what every other screen offers, so a stale list would draw
  // controls the API then refuses.
  staleTime: 0,
})

/**
 * The roles the caller may offer somebody else.
 *
 * Read from the API rather than filtered here: the ceiling — you may offer only
 * a role whose permissions you already hold — is the server's rule, and a
 * client deciding it for itself would be a second copy of the thing that
 * decides it. That copy is exactly what this replaced.
 */
export const invitableRolesQuery = queryOptions({
  queryKey: ['roles', 'invitable'],
  queryFn: async () => (await gql(InvitableRolesDocument)).access.invitableRoles,
  staleTime: 0,
})

export const roleQuery = (key: string) => queryOptions({
  queryKey: ['roles', key],
  queryFn: async () => (await gql(RoleByKeyDocument, { key })).access.role,
  staleTime: 0,
})

/**
 * Everything a role may be given.
 *
 * Fixed for a given deployment — it is the server's own catalogue, generated
 * from `catalog.json` — so it is held for the session rather than re-read every
 * time the editor opens.
 */
export const catalogueQuery = queryOptions({
  queryKey: ['permission-catalogue'],
  staleTime: Number.POSITIVE_INFINITY,
  queryFn: async () =>
    (await gql(PermissionCatalogueDocument)).access.permissionCatalogue,
})

/** How a key reads on screen: `programme_cycle` → "Programme cycle". */
export const humanizeKey = (key: string): string =>
  key.replace(/_/gu, ' ').replace(/^./u, (first) => first.toUpperCase())

export const permissionKey = (permission: {
  resource: string
  action: string
}): string => `${permission.resource}:${permission.action}`
