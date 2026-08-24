/**
 * Guarded persistence for programme cycles and their pinned policy versions.
 *
 * A policy snapshot is inserted only after the guarded head reached the version
 * it belongs to, and the dependent document, assessment, and reason rows stay
 * in the same D1 batch — if the head update loses a race their version foreign
 * key fails and the whole batch rolls back.
 *
 * Normalized rows are written one prepared statement at a time because D1 has a
 * low bind-variable ceiling that a single large multi-row INSERT can exceed.
 */
import { and, asc, count, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import {
  coreAuditEvent,
  sebApplication,
  sebProgrammeCycle,
  sebProgrammeCycleAssessmentRule,
  sebProgrammeCycleDocumentRule,
  sebProgrammeCycleIdentifierRule,
  sebProgrammeCycleEvent,
  sebProgrammeCycleReason,
  sebProgrammeCycleVersion,
} from '../../../db/schema'
import { COUNT_MISSING, requireInvariant } from '../../application/support'
import type { Database } from '../../../db'
import type { AdminAuditAction } from '../support'
import type {
  AdminOperationContext,
  PageInfo,
  ProgrammeCycleInput,
} from '../types'
import { adminAudit } from '../support'
import { prefixMatch, prefixPattern } from '../../search'
import { encodeAdminCursor } from '../pagination'

export type ProgrammeCycleRecord = typeof sebProgrammeCycle.$inferSelect
type ProgrammeCycleStatus = ProgrammeCycleRecord['status']
export type ProgrammeCycleVersionRecord = typeof sebProgrammeCycleVersion.$inferSelect

export type ProgrammeCycleAggregate = {
  head: ProgrammeCycleRecord
  version: ProgrammeCycleVersionRecord
  documentRules: Array<typeof sebProgrammeCycleDocumentRule.$inferSelect>
  identifierRules: Array<typeof sebProgrammeCycleIdentifierRule.$inferSelect>
  assessmentRules: Array<typeof sebProgrammeCycleAssessmentRule.$inferSelect>
  reasons: Array<typeof sebProgrammeCycleReason.$inferSelect>
}

export const loadProgrammeCycle = async (
  db: Database,
  id: string,
): Promise<ProgrammeCycleAggregate | null> => {
  const [row] = await db
    .select({ head: sebProgrammeCycle, version: sebProgrammeCycleVersion })
    .from(sebProgrammeCycle)
    .innerJoin(
      sebProgrammeCycleVersion,
      and(
        eq(sebProgrammeCycleVersion.programmeCycleId, sebProgrammeCycle.id),
        eq(sebProgrammeCycleVersion.version, sebProgrammeCycle.currentVersion),
      ),
    )
    .where(eq(sebProgrammeCycle.id, id))
    .limit(1)
  if (!row) return null
  /*
   * One statement, not 3. Every read here is single-table, so `db.batch` maps
   * the results back correctly — a joined read could not go in here, because a
   * batch is read back by column name and two columns called `id` collide.
   */
  const [documentRules, identifierRules, assessmentRules, reasons] = await db.batch([
    db
      .select()
      .from(sebProgrammeCycleDocumentRule)
      .where(
        and(
          eq(sebProgrammeCycleDocumentRule.programmeCycleId, id),
          eq(sebProgrammeCycleDocumentRule.programmeCycleVersion, row.head.currentVersion),
        ),
      ),
    // Joins the batch rather than costing its own call: single-table, so the
    // by-name mapping a batch does is safe here.
    db
      .select()
      .from(sebProgrammeCycleIdentifierRule)
      .where(
        and(
          eq(sebProgrammeCycleIdentifierRule.programmeCycleId, id),
          eq(sebProgrammeCycleIdentifierRule.programmeCycleVersion, row.head.currentVersion),
        ),
      ),
    db
      .select()
      .from(sebProgrammeCycleAssessmentRule)
      .where(
        and(
          eq(sebProgrammeCycleAssessmentRule.programmeCycleId, id),
          eq(sebProgrammeCycleAssessmentRule.programmeCycleVersion, row.head.currentVersion),
        ),
      ),
    db
      .select()
      .from(sebProgrammeCycleReason)
      .where(
        and(
          eq(sebProgrammeCycleReason.programmeCycleId, id),
          eq(sebProgrammeCycleReason.programmeCycleVersion, row.head.currentVersion),
        ),
      ),
  ])
  return { ...row, documentRules, identifierRules, assessmentRules, reasons }
}

export const listProgrammeCycles = async (
  db: Database,
  input: {
    first: number
    after: { timestamp: Date; id: string } | null
    includeDeleted: boolean
    status?: ProgrammeCycleStatus | null
    cycleYear?: number | null
    search?: string | null
  },
): Promise<{ nodes: ProgrammeCycleRecord[]; pageInfo: PageInfo }> => {
  const cursor = input.after
    ? or(
        gt(sebProgrammeCycle.updatedAt, input.after.timestamp),
        and(
          eq(sebProgrammeCycle.updatedAt, input.after.timestamp),
          gt(sebProgrammeCycle.id, input.after.id),
        ),
      )
    : undefined
  const pattern = prefixPattern(input.search)
  const filters = and(
    input.includeDeleted ? undefined : isNull(sebProgrammeCycle.deletedAt),
    input.status ? eq(sebProgrammeCycle.status, input.status) : undefined,
    input.cycleYear ? eq(sebProgrammeCycle.cycleYear, input.cycleYear) : undefined,
    // The code, which is what a cycle is called in conversation.
    pattern ? prefixMatch(sebProgrammeCycle.cycleCode, pattern) : undefined,
  )
  const rows = await db
    .select()
    .from(sebProgrammeCycle)
    .where(and(filters, cursor))
    .orderBy(asc(sebProgrammeCycle.updatedAt), asc(sebProgrammeCycle.id))
    .limit(input.first + 1)
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)
  const [total] = await db
    .select({ value: count() })
    .from(sebProgrammeCycle)
    .where(filters)
  return {
    nodes: selected,
    pageInfo: {
      hasNextPage: rows.length > input.first,
      endCursor: last ? encodeAdminCursor('updatedAt', last.updatedAt, last.id) : null,
      totalCount: requireInvariant(total, COUNT_MISSING).value,
    },
  }
}

export const programmeCycleCounts = async (db: Database, id: string) => {
  const rows = await db
    .select({ status: sebApplication.status, count: sql<number>`count(*)` })
    .from(sebApplication)
    .where(eq(sebApplication.programmeCycleId, id))
    .groupBy(sebApplication.status)
  return rows.map(({ status, count }) => ({ status, count: Number(count) }))
}

export const listProgrammeCycleEvents = async (
  db: Database,
  id: string,
  first: number,
) => db
  .select()
  .from(sebProgrammeCycleEvent)
  .where(eq(sebProgrammeCycleEvent.programmeCycleId, id))
  .orderBy(desc(sebProgrammeCycleEvent.createdAt), desc(sebProgrammeCycleEvent.id))
  .limit(first)

const versionValues = (
  cycleId: string,
  version: number,
  input: ProgrammeCycleInput,
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED',
  changeType:
    | 'CREATED'
    | 'UPDATED'
    | 'OPENED'
    | 'GUIDANCE_CHANGED'
    | 'CLOSING_CHANGED'
    | 'CLOSED'
    | 'ARCHIVED',
  reason: string | null,
  actorUserId: string,
  now: Date,
): typeof sebProgrammeCycleVersion.$inferInsert => ({
  id: crypto.randomUUID(),
  programmeCycleId: cycleId,
  version,
  cycleCode: input.cycleCode,
  displayName: input.displayName,
  cycleYear: input.cycleYear,
  policyReference: input.policyReference ?? null,
  applicantGuidance: input.applicantGuidance ?? null,
  partnerBankGuidance: input.partnerBankGuidance ?? null,
  status,
  opensAt: input.opensAt ?? null,
  closesAt: input.closesAt ?? null,
  minimumApplicantAge: input.policy.minimumApplicantAge,
  maximumApplicantAge: input.policy.maximumApplicantAge,
  categoryAMaximumMonths: input.policy.categoryAMaximumMonths,
  expansionWaitMonths: input.policy.expansionWaitMonths,
  majorityOwnershipRequired: input.policy.majorityOwnershipRequired,
  jurisdiction: input.policy.jurisdiction,
  fundingCeilingState: input.policy.fundingCeilingState,
  fundingCeilingAmountPaise: input.policy.fundingCeilingAmountPaise,
  fundingCeilingScope: input.policy.fundingCeilingScope,
  changeType,
  changeReason: reason,
  changedByUserId: actorUserId,
  createdAt: now,
})

const policyRows = (
  cycleId: string,
  version: number,
  input: ProgrammeCycleInput,
  now: Date,
) => ({
  documentRules: input.policy.documentRules.map((rule) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    documentType: rule.documentType,
    condition: rule.condition,
    createdAt: now,
  })),
  /*
   * Absent means the cycle configures none, which demands nothing and compares
   * nothing. That is what leaves cycles created before these rules existed
   * working exactly as they did.
   */
  identifierRules: (input.policy.identifierRules ?? []).map((rule) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    kind: rule.kind,
    requirement: rule.requirement,
    duplicatePolicy: rule.duplicatePolicy,
    // Only a rule that demands something needs to name the check it belongs
    // to; the CHECK constraint enforces the same pairing in the database.
    checkType: rule.requirement === 'REQUIRED_ON_PASS' ? rule.checkType : null,
    createdAt: now,
  })),
  assessmentRules: input.policy.requiredAssessmentTypes.map((assessmentType) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    assessmentType,
    requiredOutcome: 'PASSED' as const,
    createdAt: now,
  })),
  reasons: input.policy.reasons.map((reason) => ({
    id: crypto.randomUUID(),
    programmeCycleId: cycleId,
    programmeCycleVersion: version,
    context: reason.context,
    code: reason.code,
    label: reason.label,
    applicantMessageTemplate: reason.applicantMessageTemplate ?? null,
    createdAt: now,
  })),
})

/** Inserts a policy snapshot only after the guarded head reached that version. */
const insertGuardedCycleVersion = (
  context: AdminOperationContext,
  value: typeof sebProgrammeCycleVersion.$inferInsert,
) => context.db.insert(sebProgrammeCycleVersion).select(sql`
  SELECT ${value.id}, ${value.programmeCycleId}, ${value.version}, ${value.cycleCode},
    ${value.displayName}, ${value.cycleYear}, ${value.policyReference},
    ${value.applicantGuidance}, ${value.partnerBankGuidance}, ${value.status},
    ${value.opensAt ? value.opensAt.getTime() : null},
    ${value.closesAt ? value.closesAt.getTime() : null},
    ${value.minimumApplicantAge}, ${value.maximumApplicantAge},
    ${value.categoryAMaximumMonths}, ${value.expansionWaitMonths},
    ${value.majorityOwnershipRequired}, ${value.jurisdiction},
    ${value.fundingCeilingState}, ${value.fundingCeilingAmountPaise},
    ${value.fundingCeilingScope}, ${value.changeType}, ${value.changeReason},
    ${value.changedByUserId},
    ${value.createdAt.getTime()}
  WHERE EXISTS (
    SELECT 1 FROM ${sebProgrammeCycle}
    WHERE ${sebProgrammeCycle.id} = ${value.programmeCycleId}
      AND ${sebProgrammeCycle.currentVersion} = ${value.version}
      AND ${sebProgrammeCycle.updatedAt} = ${value.createdAt.getTime()}
  )
`)

export const insertProgrammeCycle = async (
  context: AdminOperationContext,
  input: ProgrammeCycleInput,
  actorUserId: string,
  now: Date,
): Promise<string | null> => {
  const id = crypto.randomUUID()
  const policy = policyRows(id, 1, input, now)
  const audit = adminAudit(context, {
    actorUserId,
    action: 'SEB.CYCLE_CREATED' as AdminAuditAction,
    entityType: 'SEB_PROGRAMME_CYCLE',
    entityId: id,
    now,
  })
  const statements = [
    context.db.insert(sebProgrammeCycle).values({
      id,
      cycleCode: input.cycleCode,
      displayName: input.displayName,
      cycleYear: input.cycleYear,
      policyReference: input.policyReference ?? null,
      applicantGuidance: input.applicantGuidance ?? null,
      partnerBankGuidance: input.partnerBankGuidance ?? null,
      status: 'DRAFT',
      opensAt: input.opensAt ?? null,
      closesAt: input.closesAt ?? null,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
    }),
    context.db.insert(sebProgrammeCycleVersion).values(
      versionValues(id, 1, input, 'DRAFT', 'CREATED', null, actorUserId, now),
    ),
    // Keep each normalized row in its own prepared statement. D1/SQLite has a
    // low bind-variable ceiling; one large multi-row INSERT can exceed it even
    // though the overall atomic batch remains comfortably bounded (< 40).
    ...policy.documentRules.map((row) =>
      context.db.insert(sebProgrammeCycleDocumentRule).values(row)),
    ...policy.identifierRules.map((row) =>
      context.db.insert(sebProgrammeCycleIdentifierRule).values(row)),
    ...policy.assessmentRules.map((row) =>
      context.db.insert(sebProgrammeCycleAssessmentRule).values(row)),
    ...policy.reasons.map((row) =>
      context.db.insert(sebProgrammeCycleReason).values(row)),
    context.db.insert(coreAuditEvent).values(audit),
  ]
  await context.db.batch(
    statements as [typeof statements[number], ...Array<typeof statements[number]>],
  )
  return id
}

export const updateDraftProgrammeCycle = async (
  context: AdminOperationContext,
  input: ProgrammeCycleInput & { id: string; expectedVersion: number; reason: string },
  actorUserId: string,
  now: Date,
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const policy = policyRows(input.id, nextVersion, input, now)
  const updated = context.db
    .update(sebProgrammeCycle)
    .set({
      cycleCode: input.cycleCode,
      displayName: input.displayName,
      cycleYear: input.cycleYear,
      policyReference: input.policyReference ?? null,
      applicantGuidance: input.applicantGuidance ?? null,
      partnerBankGuidance: input.partnerBankGuidance ?? null,
      opensAt: input.opensAt ?? null,
      closesAt: input.closesAt ?? null,
      currentVersion: nextVersion,
      updatedAt: now,
    })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.id),
        eq(sebProgrammeCycle.status, 'DRAFT'),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  // The dependent inserts intentionally remain in the same D1 batch. If the
  // guarded head update loses a race, their version foreign key fails and D1
  // rolls the complete batch back.
  const [changed] = await context.db.batch([
    updated,
    insertGuardedCycleVersion(
      context,
      versionValues(
        input.id,
        nextVersion,
        input,
        'DRAFT',
        'UPDATED',
        input.reason,
        actorUserId,
        now,
      ),
    ),
    ...policy.documentRules.map((row) =>
      context.db.insert(sebProgrammeCycleDocumentRule).values(row)),
    ...policy.identifierRules.map((row) =>
      context.db.insert(sebProgrammeCycleIdentifierRule).values(row)),
    ...policy.assessmentRules.map((row) =>
      context.db.insert(sebProgrammeCycleAssessmentRule).values(row)),
    ...policy.reasons.map((row) =>
      context.db.insert(sebProgrammeCycleReason).values(row)),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${actorUserId}, 'SEB.CYCLE_UPDATED',
        'SEB_PROGRAMME_CYCLE', ${input.id}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
      )
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const transitionProgrammeCycle = async (
  context: AdminOperationContext,
  input: {
    aggregate: ProgrammeCycleAggregate
    expectedVersion: number
    toStatus: 'OPEN' | 'CLOSED' | 'ARCHIVED'
    changeType: 'OPENED' | 'CLOSED' | 'ARCHIVED'
    reason: string
    message: string
    action: AdminAuditAction
    actorUserId: string | null
    now: Date
  },
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const updated = context.db
    .update(sebProgrammeCycle)
    .set({ status: input.toStatus, currentVersion: nextVersion, updatedAt: input.now })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.aggregate.head.id),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        eq(sebProgrammeCycle.status, input.aggregate.head.status),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  const base = input.aggregate.version
  const [changed] = await context.db.batch([
    updated,
    insertGuardedCycleVersion(context, {
      ...base,
      id: crypto.randomUUID(),
      version: nextVersion,
      status: input.toStatus,
      changeType: input.changeType,
      changeReason: input.reason,
      changedByUserId: input.actorUserId,
      createdAt: input.now,
    }),
    context.db.insert(sebProgrammeCycleDocumentRule).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        document_type, condition, ${input.now.getTime()}
      FROM ${sebProgrammeCycleDocumentRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    // Carried forward with the others. A rule table that is not copied here
    // silently empties itself the first time a cycle changes version, which is
    // the moment it is least likely to be noticed.
    context.db.insert(sebProgrammeCycleIdentifierRule).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        kind, requirement, duplicate_policy, check_type, ${input.now.getTime()}
      FROM ${sebProgrammeCycleIdentifierRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    context.db.insert(sebProgrammeCycleAssessmentRule).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        assessment_type, required_outcome, ${input.now.getTime()}
      FROM ${sebProgrammeCycleAssessmentRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    context.db.insert(sebProgrammeCycleReason).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        context, code, label, applicant_message_template, ${input.now.getTime()}
      FROM ${sebProgrammeCycleReason}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    context.db.insert(sebProgrammeCycleEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.aggregate.head.id}, ${input.changeType},
        ${input.actorUserId}, ${input.message}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
      )
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, ${input.action},
        'SEB_PROGRAMME_CYCLE', ${input.aggregate.head.id}, 'SUCCESS', NULL,
        NULL, NULL, NULL, ${JSON.stringify({ status: input.toStatus })},
        ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
      )
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const reviseOpenProgrammeCycle = async (
  context: AdminOperationContext,
  input: {
    aggregate: ProgrammeCycleAggregate
    expectedVersion: number
    applicantGuidance?: string
    partnerBankGuidance?: string
    closesAt?: Date
    changeType: 'GUIDANCE_CHANGED' | 'CLOSING_CHANGED'
    reason: string
    message: string
    action: AdminAuditAction
    actorUserId: string
    now: Date
  },
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const guidance = input.applicantGuidance ?? input.aggregate.head.applicantGuidance
  const bankGuidance = input.partnerBankGuidance ?? input.aggregate.head.partnerBankGuidance
  const closesAt = input.closesAt ?? input.aggregate.head.closesAt
  const update = context.db
    .update(sebProgrammeCycle)
    .set({
      applicantGuidance: guidance,
      partnerBankGuidance: bankGuidance,
      closesAt,
      currentVersion: nextVersion,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.aggregate.head.id),
        eq(sebProgrammeCycle.status, 'OPEN'),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        isNull(sebProgrammeCycle.deletedAt),
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  const [changed] = await context.db.batch([
    update,
    insertGuardedCycleVersion(context, {
      ...input.aggregate.version,
      id: crypto.randomUUID(),
      version: nextVersion,
      applicantGuidance: guidance,
      partnerBankGuidance: bankGuidance,
      closesAt,
      changeType: input.changeType,
      changeReason: input.reason,
      changedByUserId: input.actorUserId,
      createdAt: input.now,
    }),
    context.db.insert(sebProgrammeCycleDocumentRule).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        document_type, condition, ${input.now.getTime()}
      FROM ${sebProgrammeCycleDocumentRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    // Carried forward with the others. A rule table that is not copied here
    // silently empties itself the first time a cycle changes version, which is
    // the moment it is least likely to be noticed.
    context.db.insert(sebProgrammeCycleIdentifierRule).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        kind, requirement, duplicate_policy, check_type, ${input.now.getTime()}
      FROM ${sebProgrammeCycleIdentifierRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    context.db.insert(sebProgrammeCycleAssessmentRule).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        assessment_type, required_outcome, ${input.now.getTime()}
      FROM ${sebProgrammeCycleAssessmentRule}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    context.db.insert(sebProgrammeCycleReason).select(sql`
      SELECT ${crypto.randomUUID()} || '-' || id, programme_cycle_id, ${nextVersion},
        context, code, label, applicant_message_template, ${input.now.getTime()}
      FROM ${sebProgrammeCycleReason}
      WHERE programme_cycle_id = ${input.aggregate.head.id}
        AND programme_cycle_version = ${input.expectedVersion}
    `),
    context.db.insert(sebProgrammeCycleEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.aggregate.head.id}, ${input.changeType},
        ${input.actorUserId}, ${input.message}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
      )
    `),
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId}, ${input.action},
        'SEB_PROGRAMME_CYCLE', ${input.aggregate.head.id}, 'SUCCESS', NULL,
        NULL, NULL, NULL, NULL, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycleVersion}
        WHERE ${sebProgrammeCycleVersion.programmeCycleId} = ${input.aggregate.head.id}
          AND ${sebProgrammeCycleVersion.version} = ${nextVersion}
      )
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

export const setDraftCycleDeleted = async (
  context: AdminOperationContext,
  input: {
    id: string
    expectedVersion: number
    deleted: boolean
    reason: string | null
    actorUserId: string
    now: Date
  },
): Promise<boolean> => {
  const updated = context.db
    .update(sebProgrammeCycle)
    .set({
      deletedAt: input.deleted ? input.now : null,
      deletedByUserId: input.deleted ? input.actorUserId : null,
      deleteReason: input.deleted ? input.reason : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebProgrammeCycle.id, input.id),
        eq(sebProgrammeCycle.status, 'DRAFT'),
        eq(sebProgrammeCycle.currentVersion, input.expectedVersion),
        input.deleted
          ? isNull(sebProgrammeCycle.deletedAt)
          : sql`${sebProgrammeCycle.deletedAt} IS NOT NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${sebApplication}
          WHERE ${sebApplication.programmeCycleId} = ${input.id}
        )`,
      ),
    )
    .returning({ id: sebProgrammeCycle.id })
  const [changed] = await context.db.batch([
    updated,
    context.db.insert(coreAuditEvent).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.actorUserId},
        ${input.deleted ? 'SEB.CYCLE_DELETED' : 'SEB.CYCLE_RESTORED'},
        'SEB_PROGRAMME_CYCLE', ${input.id}, 'SUCCESS', NULL, NULL, NULL,
        NULL, NULL, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebProgrammeCycle}
        WHERE ${sebProgrammeCycle.id} = ${input.id}
          AND ${sebProgrammeCycle.updatedAt} = ${input.now.getTime()}
      )
    `),
  ])
  return Array.isArray(changed) && changed.length === 1
}

/** Finds a small deterministic closing batch; later cron runs continue. */
export const findExpiredOpenCycles = async (db: Database, now: Date) => db
  .select({ id: sebProgrammeCycle.id })
  .from(sebProgrammeCycle)
  .where(
    and(
      eq(sebProgrammeCycle.status, 'OPEN'),
      isNull(sebProgrammeCycle.deletedAt),
      lt(sebProgrammeCycle.closesAt, now),
    ),
  )
  .orderBy(asc(sebProgrammeCycle.closesAt), asc(sebProgrammeCycle.id))
  .limit(20)
