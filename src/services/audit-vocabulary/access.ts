/**
 * Who may do what: composing roles, granting and revoking them, and the
 * invitations that let somebody accept one.
 *
 * A grant or revocation records the person it changed as its subject, so
 * "everything done to this person's access" is one indexed read, and records
 * the operator's reason, bounded — the full text stays on the grant row.
 */
import { z } from 'zod'
import { auditId, code, isoInstant, label, reasonText, REASON_FIELD, version } from './fields'
import { defineAudit } from './types'

/** How a grant came to exist or end — each route in is a different authority. */
// An accepted invitation records itself as `RBAC.ROLE_INVITE_ACCEPTED`, and a
// retirement closes grants under `RBAC.ROLE_RETIRED`, so neither is a route here.
const grantRoute = z.enum(['DIRECT', 'SIGNUP', 'BOOTSTRAP'])

const ROUTE_LABELS: Record<z.infer<typeof grantRoute>, string> = {
  DIRECT: 'directly',
  SIGNUP: 'at signup',
  BOOTSTRAP: 'by the first-administrator bootstrap',
}

/*
 * Grant and revoke share one shape: the same person, the same role, the same
 * route, the same reason. One schema, so a call site choosing between the two
 * with a ternary is checked against the one it actually writes.
 */
const grantChange = z.strictObject({
  subjectUserId: auditId,
  role: code,
  via: grantRoute,
  reason: reasonText.optional(),
})

const grantChangeFields = {
  subjectUserId: { label: 'Person', kind: 'USER' },
  role: { label: 'Role', kind: 'ROLE' },
  via: { label: 'How', kind: 'ENUM' },
  reason: REASON_FIELD,
} as const

export const accessVocabulary = {
  'RBAC.ROLE_CREATED': defineAudit({
    label: 'Composed a role',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_ROLE'],
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({ roleKey: code, roleName: label }),
    fields: {
      roleKey: { label: 'Role', kind: 'ROLE' },
      roleName: { label: 'Name', kind: 'TEXT' },
    },
    summary: (p) => `Composed the role ${p.roleName}`,
    example: { roleKey: 'CASEWORK_READER', roleName: 'Casework reader' },
  }),
  'RBAC.ROLE_UPDATED': defineAudit({
    label: 'Changed what a role may do',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_ROLE'],
    subject: 'NONE',
    application: 'NONE',
    // How many, not which: the pairs live on the role, and a second copy of
    // somebody's authority in retained history would drift from the first.
    payload: z.strictObject({ roleKey: code, permissionCount: z.number().int().nonnegative(), version }),
    fields: {
      roleKey: { label: 'Role', kind: 'ROLE' },
      permissionCount: { label: 'Permissions', kind: 'COUNT' },
      version: { label: 'Version', kind: 'COUNT' },
    },
    summary: (p, name) =>
      `Set ${name('ROLE', p.roleKey)} to ${p.permissionCount} ${p.permissionCount === 1 ? 'permission' : 'permissions'}`,
    example: { roleKey: 'CASEWORK_READER', permissionCount: 4, version: 2 },
  }),
  'RBAC.ROLE_RETIRED': defineAudit({
    label: 'Retired a role',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_ROLE'],
    subject: 'NONE',
    application: 'NONE',
    payload: z.strictObject({ roleKey: code, reason: reasonText }),
    fields: { roleKey: { label: 'Role', kind: 'ROLE' }, reason: REASON_FIELD },
    summary: (p, name) => `Retired ${name('ROLE', p.roleKey)}`,
    example: { roleKey: 'AUDITOR', reason: 'No longer used.' },
  }),
  'RBAC.ROLE_GRANTED': defineAudit({
    label: 'Granted a role',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_USER_ROLE_GRANT'],
    subject: { payload: 'subjectUserId' },
    application: 'NONE',
    // Written by bootstrap too, whose payload is fixed by configuration.
    callerTextFree: true,
    payload: grantChange,
    fields: grantChangeFields,
    summary: (p, name) =>
      `Gave ${name('USER', p.subjectUserId)} the role ${name('ROLE', p.role)} ${ROUTE_LABELS[p.via]}`,
    example: { subjectUserId: '00000000-0000-4000-8000-000000000001', role: 'CASEWORK_READER', via: 'DIRECT', reason: 'Joined the desk.' },
  }),
  'RBAC.ROLE_REVOKED': defineAudit({
    label: 'Revoked a role',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_USER_ROLE_GRANT', 'CORE_USER'],
    subject: { payload: 'subjectUserId' },
    application: 'NONE',
    callerTextFree: true,
    payload: grantChange,
    fields: grantChangeFields,
    summary: (p, name) =>
      `Took the role ${name('ROLE', p.role)} from ${name('USER', p.subjectUserId)} ${ROUTE_LABELS[p.via]}`,
    example: { subjectUserId: '00000000-0000-4000-8000-000000000001', role: 'APPLICANT', via: 'BOOTSTRAP', reason: 'First super administrator bootstrap' },
  }),
  'RBAC.FIRST_SUPER_ADMIN_BOOTSTRAP': defineAudit({
    label: 'Bootstrapped the first super administrator',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    // This endpoint carries two credentials and runs without a session.
    callerTextFree: true,
    payload: z.strictObject({
      grantId: auditId.optional(),
      failure: z.enum(['WRONG_PASSWORD', 'NOT_PERMITTED']).optional(),
    }),
    fields: {
      grantId: { label: 'Grant', kind: 'ID' },
      failure: { label: 'Refused because', kind: 'ENUM' },
    },
    summary: (p, name) =>
      p.failure
        ? 'Refused a first-administrator bootstrap'
        : `Made ${name('ROLE', 'SUPER_ADMIN')} the first administrator's only role`,
    example: { grantId: '00000000-0000-4000-8000-000000000002' },
  }),
  'RBAC.ROLE_INVITE_ISSUED': defineAudit({
    label: 'Invited somebody to a role',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    // The token is never recorded: it would be a second copy of a live
    // credential, readable by anybody who may read the history.
    payload: z.strictObject({ role: code, roleVersion: version, reason: reasonText, expiresAt: isoInstant }),
    fields: {
      role: { label: 'Role', kind: 'ROLE' },
      roleVersion: { label: 'Role version', kind: 'COUNT' },
      reason: REASON_FIELD,
      expiresAt: { label: 'Expires', kind: 'DATETIME' },
    },
    summary: (p, name) => `Invited somebody to ${name('ROLE', p.role)}`,
    example: { role: 'DECISION_APPROVER', roleVersion: 3, reason: 'Covering approvals.', expiresAt: '2026-10-01T09:00:00.000Z' },
  }),
  'RBAC.ROLE_INVITE_ACCEPTED': defineAudit({
    label: 'Accepted a role invitation',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    payload: z.strictObject({ role: code, issuerUserId: auditId, grantId: auditId }),
    fields: {
      role: { label: 'Role', kind: 'ROLE' },
      issuerUserId: { label: 'Invited by', kind: 'USER' },
      grantId: { label: 'Grant', kind: 'ID' },
    },
    summary: (p, name) => `Accepted ${name('ROLE', p.role)} from ${name('USER', p.issuerUserId)}`,
    example: { role: 'DECISION_APPROVER', issuerUserId: '00000000-0000-4000-8000-000000000003', grantId: '00000000-0000-4000-8000-000000000004' },
  }),
  'RBAC.ROLE_INVITE_REFUSED': defineAudit({
    label: 'Refused a role invitation',
    category: 'ACCESS',
    writer: 'auth',
    entityTypes: ['CORE_USER'],
    subject: 'ENTITY',
    application: 'NONE',
    // Recorded precisely here; the caller is always told the same thing, so a
    // link cannot be used to learn which of these was true.
    payload: z.strictObject({
      refusal: z.enum([
        'UNREADABLE_OR_EXPIRED',
        'ACCOUNT_UNUSABLE',
        'ROLE_CHANGED',
        'BEYOND_ISSUER_AUTHORITY',
        'ADDRESS_CHANGED',
      ]),
    }),
    fields: { refusal: { label: 'Refused because', kind: 'ENUM' } },
    summary: () => 'Refused a role invitation',
    example: { refusal: 'ROLE_CHANGED' },
  }),
} as const
