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
  /**
   * The pipeline stages this person's roles own, as `pipelineId/stageKey`.
   * Ownership is the data half of stage authority: two bank officers hold the
   * same permissions and differ only in which stage they work. Empty for a
   * super administrator, who owns every stage through {@link ownsStage}.
   */
  ownedStages: ReadonlySet<string>
}

/**
 * Whether a person works a stage. A super administrator works every stage,
 * for the same reason they hold every permission: authority that could be
 * edited away could lock the programme out of its own casework.
 */
export const ownsStage = (
  authority: Pick<Authority, 'superAdministrator' | 'ownedStages'>,
  pipelineId: string,
  stageKey: string,
): boolean => authority.superAdministrator || authority.ownedStages.has(`${pipelineId}/${stageKey}`)

/**
 * Whether a person works every stage in `stages`, each as `pipelineId/stageKey`.
 *
 * The stage half of the invitation ceiling. Two bank officers hold the same
 * permissions, so `withinAuthority` alone would let the State Bank's officer
 * invite somebody to the Tripura Gramin Bank's role — offering work at a stage
 * they do not work themselves. A role is offered only by somebody who owns
 * every stage it owns; a super administrator owns them all.
 */
export const ownsEveryStage = (
  authority: Pick<Authority, 'superAdministrator' | 'ownedStages'>,
  stages: readonly string[],
): boolean => authority.superAdministrator || stages.every((stage) => authority.ownedStages.has(stage))

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

/**
 * Whether an authority covers a whole set of pairs — the invitation ceiling.
 *
 * Without a ceiling, "an administrator may invite" is a privilege escalation:
 * somebody could invite a second account to more than they hold and obtain
 * through it exactly the authority they are directly forbidden.
 *
 * This used to be a hand-written table of role names, and with composed roles
 * that table cannot be written at all — the roles are not known when the code
 * is. So the rule generalizes to what it always meant and reads the actual
 * sets. A super administrator holds the wildcard, so every role is a subset.
 *
 * It lives here rather than beside `inviteRole` because two operations ask it:
 * the mutation, which refuses, and `invitableRoles`, which lists what would be
 * accepted. Two copies of a ceiling drift, and the direction they drift in is
 * a picker offering a role the mutation then refuses — or worse, the reverse.
 *
 * Pairs are compared as strings rather than by type, because the wanted set is
 * usually rows read from the database and a row can name a resource the
 * catalogue no longer has. Such a pair is in nobody's held set, so it is not a
 * subset of anything — which fails closed, in the required direction.
 */
export const withinAuthority = (
  actor: {
    superAdministrator: boolean
    permissions: readonly { resource: string; action: string }[]
  },
  wanted: readonly { resource: string; action: string }[],
): boolean => {
  if (actor.superAdministrator) return true
  const held = new Set(
    actor.permissions.map((pair) => permissionKey(pair.resource, pair.action)),
  )
  return wanted.every((pair) => held.has(permissionKey(pair.resource, pair.action)))
}
