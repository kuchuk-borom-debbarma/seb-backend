/**
 * Working a file through the example pipeline over the real API.
 *
 * Officers are real: a composed role with real permission rows, made the owner
 * of real stages through `seb_pipeline_stage_owner` — the same row the
 * pipeline editor writes. Only the ownership row is seeded, because authoring
 * owners is another operation's subject and these suites are about working a
 * file, not about who may hand out a stage.
 */
import { completeAnswers } from '../../support/form'
import { graphql, signIn, type FixturePermission } from '../../support/api'
import { TEST_PIPELINE_ID } from '../../support/pipeline'
import { env } from '../../support/worker'

/** Everything the example pipeline's actions need between them. */
export const STAGE_OFFICER: FixturePermission[] = [
  ['stage', 'read'],
  ['stage', 'advance'],
  ['stage', 'return'],
  ['stage', 'request_revision'],
  ['stage', 'decide'],
  ['stage', 'close'],
  ['application', 'note'],
]

/** Makes a role an owner of stages of the fixture pipeline. */
export const ownStages = async (roleId: string, stageKeys: readonly string[], byUserId: string) => {
  const now = Date.now()
  for (const stageKey of stageKeys) {
    await env.DB.prepare(
      `INSERT INTO seb_pipeline_stage_owner (id, pipeline_id, stage_key, role_id, added_at, added_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), TEST_PIPELINE_ID, stageKey, roleId, now, byUserId).run()
  }
}

/** Somebody holding `permissions` whose role owns `stageKeys`. */
export const officer = async (
  stageKeys: readonly string[],
  permissions: readonly FixturePermission[] = STAGE_OFFICER,
) => {
  const who = await signIn({ permissions })
  await ownStages(who.roleId, stageKeys, who.userId)
  return who
}

/** A complete application asking for a grant and a loan, first choice `bank`. */
export const loanAnswers = (bank: 'SBI' | 'TGB' = 'SBI') => completeAnswers({
  WANTS_GRANT: true,
  SEED_FUND_REQUESTED_PAISE: 10_000_000,
  WANTS_BANK_LOAN: true,
  LOAN_BANK_FIRST_CHOICE: bank,
  LOAN_BANK_SECOND_CHOICE: bank === 'SBI' ? 'TGB' : 'SBI',
  LOAN_AMOUNT_REQUESTED_PAISE: 50_000_000,
})

const STAGE_APPLICATION_FIELDS = `
  id statusVersion pipelineId applicantUserId
  stage { key name applicantLabel }
  trail { key name }
  flags { key label terminal }
  recordedValues { key label type value }
  ended { key label }
  awaitingApplicant worksStage canWithdrawRevision
  openRevisions { id stageKey }
  revisionStageKeys
  actions { key label requestsRevision closesApplication returnsFile permitted defaults inputForm { fields { key type } } }
  history {
    actionKey actionLabel stageKey toStageKey actor { id email }
    flagsAdded flagsRemoved recorded { key value } inputs { key label value }
    revisionStageKeys selfReviewDisclosed
  }
`

export const readStage = async (cookie: string, applicationId: string) => {
  const body = await graphql<any>(`query($id: ID!) {
    admin { stage { application(applicationId: $id) {
      success message response { ${STAGE_APPLICATION_FIELDS} }
    } } }
  }`, { id: applicationId }, cookie)
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data.admin.stage.application as { success: boolean; message: string | null; response: any }
}

export type ActInput = {
  applicationId: string
  expectedStatusVersion: number
  stageKey: string
  actionKey: string
  inputs?: Record<string, unknown>
  revisionRequests?: { stageKey: string; note: string }[]
  selfReviewDisclosed?: boolean
}

export const act = async (cookie: string, input: ActInput) => {
  const body = await graphql<any>(`mutation($input: TakeStageActionInput!) {
    admin { stage { takeAction(input: $input) {
      success message issues { field code message }
      response { applicationId stageActionId statusVersion stageKey flags ended }
    } } }
  }`, { input }, cookie)
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data.admin.stage.takeAction as {
    success: boolean
    message: string | null
    issues: { field: string; code: string; message: string }[]
    response: { statusVersion: number; stageKey: string | null; flags: string[]; ended: boolean } | null
  }
}

/** Takes an action at wherever the file is, quoting the state the panel shows, and insists it lands. */
export const advance = async (
  cookie: string,
  applicationId: string,
  actionKey: string,
  extra: Omit<ActInput, 'applicationId' | 'expectedStatusVersion' | 'stageKey' | 'actionKey'> = {},
) => {
  const panel = await readStage(cookie, applicationId)
  if (!panel.success) throw new Error(`panel refused: ${panel.message}`)
  const result = await act(cookie, {
    applicationId,
    expectedStatusVersion: panel.response.statusVersion,
    stageKey: panel.response.stage.key,
    actionKey,
    ...extra,
  })
  if (!result.success) throw new Error(`${actionKey} refused: ${result.message} ${JSON.stringify(result.issues)}`)
  return result.response!
}
