/**
 * Fails when the API and the client disagree about how large a document may be.
 *
 * The number lives in two packages and cannot be shared: `dev-web` is built
 * separately and does not import the Worker's source. Before this check, a
 * comment in `uploads.ts` claimed the client "derives its message from this
 * same constant" — it never did, it was a hand-copy, and nothing would have
 * noticed the two drifting apart.
 *
 * Drift here is not cosmetic. The client refusing at a larger number than the
 * API means an applicant is allowed to spend a whole upload on a file the API
 * then rejects. The client refusing at a smaller one means a document that
 * would have been accepted cannot be offered at all. And because the limit is
 * set by what the malware scanner will accept, a client that allows more than
 * the scanner does produces documents nobody can ever open — download fails
 * closed until a scan result exists.
 *
 * Compares the expressions rather than the computed values, so `2 * 1024 *
 * 1024` and `2097152` are reported as the disagreement they are in review, and
 * so this cannot be satisfied by a number that merely happens to match today.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCES = [
  { path: 'src/services/application/uploads.ts', label: 'the API' },
  { path: 'dev-web/src/features/application/documents.ts', label: 'the client' },
]

const DECLARATION = /^export const MAX_DOCUMENT_BYTES = (.+)$/mu

/** The right-hand side of the declaration, trimmed of a trailing semicolon. */
const declaredLimit = ({ path, label }) => {
  const source = readFileSync(join(root, path), 'utf8')
  const match = source.match(DECLARATION)
  if (!match) {
    throw new Error(
      `${path} no longer declares MAX_DOCUMENT_BYTES. ${label} must state the limit for it to be checked.`,
    )
  }
  return match[1].replace(/;$/u, '').trim()
}

const [api, client] = SOURCES.map(declaredLimit)

if (api !== client) {
  console.error(
    `The document size limit disagrees between packages.\n` +
      `  ${SOURCES[0].path}: ${api}\n` +
      `  ${SOURCES[1].path}: ${client}\n\n` +
      `Both must state the same expression. The API's value is the rule; the ` +
      `client only refuses early so an applicant is told before uploading.`,
  )
  process.exit(1)
}

console.log(`Document size limit agrees across both packages: ${api}.`)
