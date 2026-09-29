/**
 * Every audited action's declaration, in one registry.
 *
 * Split by domain so each file stays one subject a reviewer can hold in mind,
 * and merged here so the rest of the system asks one question — "what is this
 * action?" — in one place: the row builder when it writes, the read side when
 * it labels, filters and explains.
 *
 * The catalogue in `src/db/schema/core/audit.ts` names the actions; this says
 * what each one records. The two are checked against each other at compile
 * time in both directions below, so an action cannot be declared without a
 * shape, or given a shape without being declared.
 */
import type { AuditAction } from '../../db/schema'
import { accessVocabulary } from './access'
import { announcementVocabulary } from './announcement'
import { applicationVocabulary } from './application'
import { exportVocabulary } from './audit'
import { authVocabulary } from './auth'
import { caseworkVocabulary } from './casework'
import { fundingVocabulary } from './funding'
import { programmeVocabulary } from './programme'
import type { AuditCategory, AuditSpec } from './types'

export const auditVocabulary = {
  ...authVocabulary,
  ...accessVocabulary,
  ...applicationVocabulary,
  ...caseworkVocabulary,
  ...fundingVocabulary,
  ...programmeVocabulary,
  ...announcementVocabulary,
  ...exportVocabulary,
  // `any` is the widest spec: each entry keeps its own precise type through
  // `defineAudit`, and this only asks that every action has one.
} satisfies Record<AuditAction, AuditSpec<any, any, any, any>>

export type AuditVocabulary = typeof auditVocabulary

/*
 * The other direction. `satisfies` proves every catalogue action has a spec,
 * but an object spread is exempt from excess-property checks, so a spec whose
 * key is misspelled — or names an action the catalogue dropped — would sit here
 * unread. This line fails to compile until it is removed.
 */
type Undeclared = Exclude<keyof AuditVocabulary, AuditAction>
const everySpecIsDeclared: [Undeclared] extends [never] ? true : Undeclared = true
void everySpecIsDeclared

// Widened for lookup by a stored name, which may be one this build never declared.
const specs: Record<string, AuditSpec | undefined> = auditVocabulary as unknown as Record<string, AuditSpec>

/**
 * The declaration for a stored action name, or nothing.
 *
 * Takes a plain string because the read side meets names this build may not
 * know — a legacy action, a fixture — and must show them rather than fail.
 */
export const auditSpecOf = (action: string): AuditSpec | undefined => specs[action]

/** A stored action's category; an unknown one reads as `OTHER`. */
export const auditCategoryOf = (action: string): AuditCategory =>
  auditSpecOf(action)?.category ?? 'OTHER'

/** Every declared action in the given categories — how a category filter reads. */
export const auditActionsIn = (categories: readonly AuditCategory[]): AuditAction[] => {
  const wanted = new Set(categories)
  return (Object.keys(auditVocabulary) as AuditAction[]).filter((action) =>
    wanted.has(auditVocabulary[action].category),
  )
}
