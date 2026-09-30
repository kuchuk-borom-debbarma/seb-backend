/**
 * The stage permissions, each asked with a literal pair.
 *
 * An action's permissions come from its effects' catalogue entries, as strings
 * like `stage:advance`. They are answered here, through a table of literal
 * `holdsPermission` calls, rather than by splitting the string — so
 * `check:catalog` can see every `stage` pair enforced by name, and a pair the
 * catalogue drops fails to compile here instead of quietly guarding nothing.
 */
import { holdsPermission, type Authority } from '../auth/permissions'
import type { PermissionPair } from './registry'

type Holder = Pick<Authority, 'permissions'>

const pairGuards: Record<string, (session: Holder) => boolean> = {
  'stage:advance': (session) => holdsPermission(session, 'stage', 'advance'),
  'stage:return': (session) => holdsPermission(session, 'stage', 'return'),
  'stage:request_revision': (session) => holdsPermission(session, 'stage', 'request_revision'),
  'stage:decide': (session) => holdsPermission(session, 'stage', 'decide'),
  'stage:close': (session) => holdsPermission(session, 'stage', 'close'),
  'application:note': (session) => holdsPermission(session, 'application', 'note'),
}

/**
 * Whether a session holds every pair. A pair with no guard here holds for
 * nobody: an effect naming a permission this table does not know is refused,
 * never waved through.
 */
export const holdsEvery = (session: Holder, pairs: readonly PermissionPair[]): boolean =>
  pairs.every((pair) => pairGuards[pair]?.(session) === true)
