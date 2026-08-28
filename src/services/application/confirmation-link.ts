/**
 * The emailed copy of an application, served from a signed link.
 *
 * The notification provider attaches files by URL — it fetches what the link
 * names and encloses it — so the programme cannot hand it bytes, only a
 * place. This module is that place: it signs a link at send time and serves
 * the PDF when the provider (or the applicant, from the same email) follows
 * it. The document is rebuilt from the frozen submission on every request
 * rather than stored: the answers are pinned, so the copy is reproducible.
 *
 * The link is a bearer credential with the same reach as the email it rides
 * in — whoever holds the email already holds everything the PDF says. It
 * still expires, because an emailed link outlives an inbox's secrecy.
 */
import { createDigest, verifySignedValue } from '../auth/crypto'
import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'
import { buildApplicationPdf } from './confirmation'
import {
  findApplicationHeadById,
  findLatestSubmittedVersion,
  findProgrammeCycleIdentity,
} from './queries/application'
import {
  answersFromRows,
  findAnswerRows,
  findPinnedCycleRules,
} from './queries/form-template'

const PURPOSE = 'application-confirmation-link'

/** Long enough to be read from an old email, short enough to die with it. */
const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1_000

export const confirmationPdfUrl = async (
  env: AppBindings,
  requestUrl: string,
  applicationId: string,
  now: Date,
): Promise<string> => {
  const expires = now.getTime() + LINK_TTL_MS
  const signature = await createDigest(
    env.AUTH_SECRET,
    PURPOSE,
    `${applicationId}.${expires}`,
  )
  const origin = new URL(requestUrl).origin
  const query = new URLSearchParams({
    application: applicationId,
    expires: String(expires),
    signature,
  })
  return `${origin}/confirmation-pdf?${query.toString()}`
}

/**
 * The route's whole behaviour: verify, load, rebuild, serve.
 *
 * Every refusal is the same bare 403 — a link is valid or it is nothing, and
 * naming which check failed would let a guess distinguish a wrong signature
 * from a real application id.
 */
export const confirmationPdfResponse = async (
  db: Database,
  env: AppBindings,
  query: { application?: string; expires?: string; signature?: string },
): Promise<Response> => {
  const refused = new Response('Not available.', { status: 403 })
  const { application, expires, signature } = query
  if (!application || !expires || !signature) return refused
  if (!/^\d{1,16}$/u.test(expires) || Number(expires) < Date.now()) return refused
  const valid = await verifySignedValue(
    env.AUTH_SECRET,
    PURPOSE,
    `${application}.${expires}`,
    signature,
  )
  if (!valid) return refused

  const head = await findApplicationHeadById(db, application)
  if (!head) return refused
  const submitted = await findLatestSubmittedVersion(db, application)
  if (!submitted) return refused
  const [cycle, rules, answerRows] = await Promise.all([
    findProgrammeCycleIdentity(db, head.programmeCycleId),
    findPinnedCycleRules(db, submitted.programmeCycleId, submitted.programmeCycleVersion),
    findAnswerRows(db, [submitted.id]),
  ])
  if (!cycle || !rules) return refused

  const bytes = await buildApplicationPdf({
    referenceNumber: head.referenceNumber,
    cycleCode: cycle.cycleCode,
    cycleDisplayName: cycle.displayName,
    submittedAt: head.firstSubmittedAt,
    template: rules.template,
    answers: answersFromRows(rules.template, submitted.id, answerRows),
    heading: 'Submitted application',
  })
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition':
        `attachment; filename="application-${head.referenceNumber ?? head.id}.pdf"`,
      'cache-control': 'private, no-store',
    },
  })
}
