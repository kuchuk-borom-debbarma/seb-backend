/** Applicant-owned canonical enterprise use cases. */
import { auditActions } from '../../../db/schema'
import { decodeCursor, pageSize } from '../pagination'
import {
  listEnterpriseDeletionBlockers,
  findOwnedEnterprise,
  insertEnterpriseAggregate,
  listOwnedEnterprises,
  setEnterpriseDeleted,
  updateEnterpriseAggregate,
} from '../queries/enterprise'
import {
  AUTH_REQUIRED_MESSAGE,
  auditRecord,
  currentApplicant,
  requireInvariant,
  runConstraintSafe,
  runConstraintSafeInsert,
  validationFailureMessage,
} from '../support'
import { failure, success } from '../../envelope'
import type {
  ApplicationOperationContext,
  BusinessSector,
  Connection,
  Enterprise,
  EnterpriseDeletionResult,
  EnterpriseStatus,
  SebResult,
  SuppliedEnterpriseProfile,
} from '../types'
import { normalizeEnterpriseProfile } from '../validation'

export const myEnterprises = async (
  input: {
    first?: number | null
    after?: string | null
    includeDeleted?: boolean | null
    status?: EnterpriseStatus | null
    sector?: BusinessSector | null
    search?: string | null
  },
  context: ApplicationOperationContext,
): Promise<SebResult<Connection<Enterprise>>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const first = pageSize(input.first)
  const cursor = decodeCursor(input.after, 'updatedAt')
  if (first === null || cursor === 'INVALID') return failure('Invalid pagination input.')
  return success(
    await listOwnedEnterprises(context.db, {
      userId: applicant.id,
      first,
      cursor,
      includeDeleted: input.includeDeleted === true,
      status: input.status,
      sector: input.sector,
      search: input.search,
    }),
  )
}

export const enterpriseById = async (
  id: string,
  context: ApplicationOperationContext,
): Promise<SebResult<Enterprise>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const enterprise = await findOwnedEnterprise(context.db, applicant.id, id, true)
  return enterprise ? success(enterprise) : failure('The enterprise was not found.')
}

export const createEnterprise = async (
  input: SuppliedEnterpriseProfile,
  context: ApplicationOperationContext,
): Promise<SebResult<Enterprise>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const normalized = normalizeEnterpriseProfile(input)
  if (!normalized.value) {
    return failure(validationFailureMessage(normalized.message, 'Invalid enterprise details.'))
  }
  const profile = normalized.value

  const now = new Date()
  const status = profile.establishmentDate === null ? 'PROPOSED' : 'ACTIVE'
  const enterpriseId = crypto.randomUUID()
  const inserted = await runConstraintSafeInsert(() =>
    insertEnterpriseAggregate(context.db, {
      enterpriseId,
      fundingCaseId: crypto.randomUUID(),
      userId: applicant.id,
      profile,
      status,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: auditActions.enterpriseCreated,
        entityType: 'SEB_ENTERPRISE',
        entityId: enterpriseId,
        now,
      }),
    }),
  )
  if (!inserted) return failure('The enterprise registration or GSTIN is already in use.')
  return success(requireInvariant(
    await findOwnedEnterprise(context.db, applicant.id, enterpriseId),
    'Created enterprise could not be read.',
  ))
}

export const updateEnterprise = async (
  input: { id: string; expectedVersion: number; profile: SuppliedEnterpriseProfile },
  context: ApplicationOperationContext,
): Promise<SebResult<Enterprise>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return failure('Expected version must be a positive integer.')
  }
  const normalized = normalizeEnterpriseProfile(input.profile)
  if (!normalized.value) {
    return failure(validationFailureMessage(normalized.message, 'Invalid enterprise details.'))
  }
  const profile = normalized.value
  const now = new Date()
  const status = profile.establishmentDate === null ? 'PROPOSED' : 'ACTIVE'
  const updated = await runConstraintSafe(() =>
    updateEnterpriseAggregate(context.db, {
      enterpriseId: input.id,
      userId: applicant.id,
      expectedVersion: input.expectedVersion,
      profile,
      status,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: auditActions.enterpriseUpdated,
        entityType: 'SEB_ENTERPRISE',
        entityId: input.id,
        now,
      }),
    }),
  )
  if (!updated) return failure('The enterprise changed, or its registration or GSTIN is already in use.')
  return success(requireInvariant(
    await findOwnedEnterprise(context.db, applicant.id, input.id),
    'Updated enterprise could not be read.',
  ))
}

const changeEnterpriseDeletion = async (
  input: { id: string; expectedVersion: number; reason?: string | null },
  context: ApplicationOperationContext,
  deleted: boolean,
): Promise<EnterpriseDeletionResult> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return { ...failure(AUTH_REQUIRED_MESSAGE), blockers: [] }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { ...failure('Expected version must be a positive integer.'), blockers: [] }
  }
  if (deleted) {
    // Named individually so the applicant can act on the list instead of
    // hunting for whichever draft or award is holding the enterprise open.
    const blockers = await listEnterpriseDeletionBlockers(context.db, applicant.id, input.id)
    if (blockers.length > 0) {
      return {
        ...failure(
          'Delete all drafts first. Submitted applications and awards retain their enterprise.',
        ),
        blockers,
      }
    }
  }
  const now = new Date()
  const changed = await setEnterpriseDeleted(context.db, {
    enterpriseId: input.id,
    userId: applicant.id,
    expectedVersion: input.expectedVersion,
    deleted,
    reason: deleted ? (input.reason?.trim() || 'REMOVED_BY_APPLICANT') : null,
    now,
    audit: auditRecord(context, {
      actorUserId: applicant.id,
      action: deleted ? auditActions.enterpriseDeleted : auditActions.enterpriseRestored,
      entityType: 'SEB_ENTERPRISE',
      entityId: input.id,
      now,
    }),
  })
  if (!changed) {
    return { ...failure('The enterprise was not found or its state changed.'), blockers: [] }
  }
  return {
    ...success(requireInvariant(
      await findOwnedEnterprise(context.db, applicant.id, input.id, true),
      'Changed enterprise could not be read.',
    )),
    blockers: [],
  }
}

export const softDeleteEnterprise = (
  input: { id: string; expectedVersion: number; reason?: string | null },
  context: ApplicationOperationContext,
): Promise<SebResult<Enterprise>> => changeEnterpriseDeletion(input, context, true)

export const restoreEnterprise = (
  input: { id: string; expectedVersion: number },
  context: ApplicationOperationContext,
): Promise<SebResult<Enterprise>> => changeEnterpriseDeletion(input, context, false)
