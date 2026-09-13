// Base fragment: every package. Type-aware rules run through oxlint-tsgolint (root `options.typeAware`).
import { defineConfig } from 'oxlint';

/**
 * Modules banned everywhere (08-markdown-pipeline-import-export.md I2; 13-decision-log.md A42):
 * no AST→Markdown serializer exists in the codebase, and the rejected alternatives never enter it.
 */
export const bannedEverywhere: ReadonlyArray<{ name: string; message: string }> = [
  {
    name: 'remark-stringify',
    message: 'No AST→Markdown serializer exists; every note mutation is a text edit (I2).',
  },
  {
    name: 'mdast-util-to-markdown',
    message: 'No AST→Markdown serializer exists; every note mutation is a text edit (I2).',
  },
  { name: 'gray-matter', message: 'Frontmatter is parsed by remark-frontmatter + yaml (A42).' },
  {
    name: 'markdown-it',
    message: 'The pipeline is unified/remark (A42); markdown-it is the recorded fallback only.',
  },
  { name: 'shiki', message: 'Highlighting is rehype-highlight (class output, CSP-safe) (A42).' },
  {
    name: 'isomorphic-dompurify',
    message: 'dompurify is browser-only and used for HTML-string sinks only.',
  },
  { name: 'remark-obsidian', message: 'GPL-3.0: never enters the lockfile (licence policy).' },
  {
    name: 'remark-gfm',
    message: 'GFM is wired per extension (micromark-extension-gfm-*), never as a black box (A42).',
  },
];

/** Yjs may only be imported by @iridium/crdt (A14); the root config re-enables it there. */
export const yjsRestricted: ReadonlyArray<{ name: string; message: string }> = [
  { name: 'yjs', message: 'Only @iridium/crdt imports yjs (A14).' },
  { name: 'y-protocols', message: 'Only @iridium/crdt imports y-protocols (A14).' },
  { name: 'lib0', message: 'Only @iridium/crdt imports lib0 (A14).' },
];

export default defineConfig({
  plugins: ['typescript', 'import', 'promise', 'unicorn', 'vitest', 'node'],
  env: { es2024: true, 'shared-node-browser': true },
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'warn',
  },
  rules: {
    'import/no-cycle': 'error',
    'import/no-self-import': 'error',
    'import/no-duplicates': 'error',
    'no-restricted-imports': ['error', { paths: [...bannedEverywhere, ...yjsRestricted] }],
    'typescript/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/await-thenable': 'error',
    'typescript/no-unnecessary-type-assertion': 'error',
    'promise/catch-or-return': 'off',
    'unicorn/prefer-node-protocol': 'error',
    'unicorn/no-array-for-each': 'off',
    'unicorn/no-null': 'off',
    'no-console': ['error', { allow: ['info', 'warn', 'error'] }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
  },
  overrides: [
    {
      files: ['**/*.spec.ts', '**/*.spec.tsx'],
      rules: {
        'vitest/no-focused-tests': 'error',
        'vitest/no-disabled-tests': 'error',
        'vitest/expect-expect': 'error',
        'vitest/no-conditional-expect': 'error',
        'vitest/require-to-throw-message': 'error',
        'vitest/valid-expect': 'error',
        // oxlint 1.82 has no `no-restricted-syntax`; the sleep ban is expressed on the global instead.
        'no-restricted-globals': [
          'error',
          {
            name: 'setTimeout',
            message:
              'Sleeps are banned in tests: use expect.poll, ManualClock or a Toxiproxy toxic.',
          },
        ],
      },
    },
  ],
});
