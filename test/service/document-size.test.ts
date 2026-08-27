/**
 * A cycle that asks for a smaller document than the programme's own limit.
 *
 * `max_file_bytes` is authored per question, stored on the pinned template,
 * and rendered by the client beside the upload control — and **it was enforced
 * by nothing**. Both size gates measured against `MAX_DOCUMENT_BYTES` alone, so
 * a cycle asking for 200 KB accepted two megabytes and the figure the applicant
 * was shown was decoration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { activeDatabase, closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { createEnterprise, openCycle, signIn, startApplication } from '../support/api'
import { defaultTemplate } from '../support/form'
import { createLoaders } from '../../src/loaders'
import { issueDocumentUpload } from '../../src/services/application/controllers/document'

/*
 * The controller directly rather than the mutation. What is under test is a
 * size bound, and the GraphQL path would need a real authorization round trip
 * to reach it — which is the storage suite's subject, not this one.
 */
const directContext = (cookie: string) => ({
  db: activeDatabase(), loaders: createLoaders(activeDatabase()),
  env,
  requestHeaders: new Headers({ cookie }),
  requestUrl: 'https://api.example.test/graphql',
  responseHeaders: new Headers(),
})

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const SMALL = 200 * 1024

/** The fixture form, with one document slot asking for less. */
const smallDprTemplate = () => defaultTemplate((template) => ({
  ...template,
  fields: template.fields.map((field) =>
    field.fieldKey === 'DPR' ? { ...field, maxFileBytes: SMALL } : field),
}))

const upload = async (cookie: string, applicationId: string, fieldKey: string, sizeBytes: number) =>
  issueDocumentUpload({
    applicationId,
    fieldKey: fieldKey as never,
    expectedDocumentVersion: 0,
    originalFilename: 'plan.pdf',
    contentType: 'application/pdf',
    sizeBytes,
    checksumSha256: `${'A'.repeat(43)}=`,
  }, directContext(cookie))

describe('a document slot that asks for less than the programme allows', () => {
  const started = async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await openCycle(officer.cookie, { formTemplate: smallDprTemplate() })
    const applicant = await signIn(['APPLICANT'])
    const enterpriseId = await createEnterprise(applicant.cookie)
    return {
      cookie: applicant.cookie,
      applicationId: await startApplication(applicant.cookie, enterpriseId, cycle.id),
    }
  }

  it('refuses a file past the slot’s own limit, and names the question', async () => {
    const { cookie, applicationId } = await started()
    expect(await upload(cookie, applicationId, 'DPR', SMALL + 1)).toMatchObject({
      success: false,
      message: 'Detailed project report must be 200 KB or smaller.',
    })
  })

  it('accepts one at the limit exactly', async () => {
    const { cookie, applicationId } = await started()
    expect((await upload(cookie, applicationId, 'DPR', SMALL)).success).toBe(true)
  })

  /*
   * The programme's own limit is still the ceiling. A slot saying nothing about
   * size is measured against it, and a slot can only ask for less — never more,
   * which is checked before the template is even read.
   */
  it('still allows the programme’s limit where the slot names none', async () => {
    const { cookie, applicationId } = await started()
    expect((await upload(cookie, applicationId, 'BANK_DETAILS', SMALL + 1)).success).toBe(true)
  })
})
