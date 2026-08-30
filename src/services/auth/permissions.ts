/**
 * What a signed-in person may do, and the one place that decides it.
 *
 * Authority used to be a fixed table of roles to capabilities. It is data now:
 * a super administrator composes roles out of resource/action pairs, and this
 * module turns the grants somebody holds into the set of pairs they hold. The
 * catalogue of legal pairs is `catalog.json`; the types that make those pairs
 * literal are generated beside it and checked by `npm run check:catalog`.
 *
 * ## Two authorities are deliberately not in the catalogue
 *
 * **A super administrator holds the wildcard**, expressed here and never as a
 * row. Anything added to the catalogue is theirs the moment it is added, which
 * is the only arrangement where a new resource cannot arrive un-administrable —
 * there is no backfill to run and nothing to forget. It is not a role that
 * happens to hold everything: if it were, an operator could edit its
 * permissions and lock the programme out of its own administration, with
 * bootstrap permanently closed and no way back.
 *
 * **An applicant holds no catalogue permission at all.** That grant is created
 * only by verified signup and nothing can grant it back, and it answers a
 * different question — whether somebody may use the applicant portal — from the
 * one every pair below answers.
 *
 * ## What this module does not decide
 *
 * Composing a role, and granting or revoking one, are the super administrator's
 * alone and are guarded in code rather than by a pair. They are absent from the
 * catalogue entirely: an authority that cannot be written down cannot be handed
 * out by mistake, and `docs/rules/security.md` is blunt about why that matters —
 * an administrator who can create administrators is a super administrator by
 * another name.
 */
import {
  actionDescriptions,
  grants,
  permissions as catalogPermissions,
  resourceDescriptions,
  resources,
  type ActionOf,
  type Permission,
  type Resource,
} from './catalog.generated'

export type { ActionOf, Permission, Resource }
export { actionDescriptions, grants, resourceDescriptions, resources }

/** Every legal pair, in catalogue order. */
export const catalogue: readonly Permission[] = catalogPermissions

/**
 * The wire and lookup form of a pair.
 *
 * One string rather than two columns because SQL aggregates a person's whole
 * set in one array, and two arrays under `DISTINCT` do not stay index-aligned.
 * `:` is unambiguous because the catalogue's own keys are lower_snake_case and
 * a role key is SCREAMING_SNAKE, both of which the schema enforces.
 */
export const permissionKey = (resource: string, action: string): string =>
  `${resource}:${action}`

const catalogueKeys: ReadonlySet<string> = new Set(
  catalogue.map((held) => permissionKey(held.resource, held.action)),
)

/** Whether a stored pair is one the catalogue still allows. */
export const isCataloguePermission = (resource: string, action: string): boolean =>
  catalogueKeys.has(permissionKey(resource, action))

/**
 * What a resolved session may do.
 *
 * `superAdministrator` has to survive alongside the expanded set rather than
 * being folded into it. If the guard could only see the pairs, "holds the
 * wildcard" and "was granted every pair one at a time" would be
 * indistinguishable — and role administration, which only the first may do,
 * depends on telling them apart.
 */
export type Authority = {
  superAdministrator: boolean
  /** Gates the applicant portal. Deliberately not a catalogue permission. */
  applicant: boolean
  /** Effective pairs, with the wildcard already expanded. */
  permissions: Permission[]
}

/**
 * The pairs a person actually holds.
 *
 * Ordered by the catalogue rather than by whatever order the rows came back in,
 * for the reason `orderedRoles` already exists: a public response should not
 * depend on the database's row order, and two reads of one identity should
 * compare equal.
 *
 * **A stored pair the catalogue no longer allows is dropped rather than
 * carried.** A resource can be removed from the catalogue in code while its
 * rows survive in the database, and the direction that must fail is closed —
 * so removing one takes effect at once instead of pending a data migration.
 */
export const permissionsOf = (input: {
  superAdministrator: boolean
  grantedKeys: readonly string[]
}): Permission[] => {
  if (input.superAdministrator) return catalogue.map((held) => ({ ...held }))
  const held = new Set(input.grantedKeys)
  return catalogue
    .filter((pair) => held.has(permissionKey(pair.resource, pair.action)))
    .map((pair) => ({ ...pair }))
}

/**
 * Whether a resolved authority carries one pair.
 *
 * A membership test with no special case, because `permissionsOf` already
 * expanded the wildcard. One rule applied once, where the set is built, rather
 * than a branch every guard has to remember — and the direction that mistake
 * fails in is "too permissive".
 */
export const holdsPermission = <R extends Resource>(
  authority: Pick<Authority, 'permissions'>,
  resource: R,
  action: ActionOf<R>,
): boolean =>
  authority.permissions.some(
    (held) => held.resource === resource && held.action === action,
  )
