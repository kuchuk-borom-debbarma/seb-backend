import type { CodegenConfig } from '@graphql-codegen/cli'

/**
 * Types are generated from the Worker's own SDL, not from a copy.
 *
 * The schema globs point at the same files the Worker loads at runtime, so an
 * operation that asks for a field the API does not expose fails
 * `npm run typecheck` instead of failing in front of a user.
 */
const sharedConfig = {
  // Each operation becomes a plain tree-shakeable string constant rather than a
  // parsed AST or a lookup map, so importing one operation pulls in exactly
  // that operation and the per-route bundle budget stays reachable.
  documentMode: 'string',
  useTypeImports: true,
  // Every scalar must be mapped deliberately. The Worker serializes Money as a
  // decimal string of paise and both date scalars as strings; mapping Money to
  // `number` would be a silent precision bug in every award and release amount.
  strictScalars: true,
  scalars: {
    DateTime: 'string',
    Date: 'string',
    Money: 'string',
    /*
     * Mapped deliberately rather than left to `any`.
     *
     * `strictScalars` fails the build on an unmapped scalar, which is what this
     * exists for — but codegen reports "Generate outputs" and leaves the last
     * good files in place, so an unmapped scalar reads as a clean run while
     * every generated type silently stays stale.
     *
     * Relative rather than the `#/` alias: codegen reads `#` as its own
     * module/type separator, so the alias produces a broken import.
     */
    JSON: '../../features/application/answers#AnswerMap',
  },
  avoidOptionals: { field: true, inputValue: false },
  skipTypename: true,
  enumsAsTypes: true,
} as const

const config: CodegenConfig = {
  schema: [
    '../src/graphql/schema.graphql',
    '../src/graphql/queries/**/*.graphql',
    '../src/graphql/mutations/**/*.graphql',
  ],
  documents: ['src/**/*.graphql'],
  generates: {
    // Schema types live in their own module so the operations module can import
    // them by namespace. Emitting both from one file makes `typescript` and
    // `typescript-operations` each declare the enums, which collides.
    'src/graphql/generated/schema.ts': {
      plugins: [{ typescript: sharedConfig }],
    },
    'src/graphql/generated/operations.ts': {
      plugins: [
        { add: { content: "import type * as Types from './schema'" } },
        {
          'typescript-operations': {
            ...sharedConfig,
            preResolveTypes: false,
            namespacedImportName: 'Types',
          },
        },
        { 'typed-document-node': sharedConfig },
      ],
    },
  },
}

export default config
