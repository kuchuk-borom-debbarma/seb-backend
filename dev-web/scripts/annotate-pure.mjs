/**
 * Marks generated operation documents as side-effect free.
 *
 * Codegen emits every operation as `new TypedDocumentString(...)` at module
 * scope. A bundler cannot prove a constructor call has no side effects, so
 * without help it keeps all of them — importing one query would ship every
 * query in the application. The `#__PURE__` annotation is the standard signal
 * that lets Rollup drop the ones a route never imports.
 *
 * Run automatically by `npm run codegen`; see `codegen.ts`.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = process.argv[2]
if (!file) throw new Error('Usage: annotate-pure.mjs <generated-file>')

const source = await readFile(file, 'utf8')
const annotated = source.replaceAll(
  '= new TypedDocumentString(',
  '= /*#__PURE__*/ new TypedDocumentString(',
)
if (annotated !== source) await writeFile(file, annotated)
