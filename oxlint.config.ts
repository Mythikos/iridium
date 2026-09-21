// Root oxlint configuration (12-milestones.md section 4.2 step 6). Fragments live in tooling/oxlint-config
// and are consumed through the package so that `turbo boundaries` sees a declared dependency, not a
// relative import across workspaces. Override entries accept only files, plugins, env, globals and rules,
// so `settings` lives here and each fragment contributes its plugins, env and rules.
import base, { bannedEverywhere, yjsRestricted } from '@iridium/oxlint-config/base';
import node from '@iridium/oxlint-config/node';
import react from '@iridium/oxlint-config/react';
import server from '@iridium/oxlint-config/server';
import { defineConfig } from 'oxlint';

const platformBans = {
  electron: [
    { name: 'electron', message: 'Electron is banned in this boundary tag (02, boundary table).' },
  ],
  react: [{ name: 'react', message: 'React is banned in this boundary tag (02, boundary table).' }],
};
const nodeBuiltins = {
  group: ['node:*'],
  message: 'node:* is banned in this boundary tag (02, boundary table).',
};
const nodeBuiltinsTypeOnly = {
  group: ['node:*'],
  allowTypeImports: true,
  message: 'iso packages import node:* as types only (02, boundary table).',
};

export default defineConfig({
  extends: [base],
  options: { typeAware: true },
  settings: { react: { version: '19.3.0' } },
  ignorePatterns: [
    '**/dist/**',
    '**/coverage/**',
    '**/node_modules/**',
    // Markdown/vault fixtures are pipeline test data, never code; apps/e2e/fixtures/*.ts stays linted.
    'packages/testkit/src/fixtures/**',
    'packages/markdown/fixtures/**',
    'apps/server/test/fixtures/**',
    // S11 emits benchmark bundles here; the authored spike harness remains linted.
    'spikes/s11-markdown/results/**',
    '**/generated/**',
    'apps/desktop/release/**',
    'tooling/mutation/reports/**',
    'playwright-report/**',
    'test-results/**',
  ],
  overrides: [
    // ---- boundary tags: banned imports inside files (02, "Boundary tags and allowed dependencies")
    {
      files: ['packages/contracts/**'], // core: zod only
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              ...bannedEverywhere,
              ...yjsRestricted,
              ...platformBans.electron,
              ...platformBans.react,
            ],
            patterns: [nodeBuiltins],
          },
        ],
      },
    },
    {
      files: ['packages/{markdown,api-client,collab-client}/**'], // iso
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              ...bannedEverywhere,
              ...yjsRestricted,
              ...platformBans.electron,
              ...platformBans.react,
            ],
            patterns: [nodeBuiltinsTypeOnly],
          },
        ],
      },
    },
    {
      // S11 executed A42's fallback. Only the compatibility adapter may import the parser;
      // the public pipeline still exposes the same mdast/hast and sanitized HTML contract.
      files: ['packages/markdown/src/markdown-it/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              ...bannedEverywhere.filter(
                (entry) => !['markdown-it', 'markdown-it/parser'].includes(entry.name),
              ),
              ...yjsRestricted,
              ...platformBans.electron,
              ...platformBans.react,
            ],
            patterns: [nodeBuiltinsTypeOnly],
          },
        ],
      },
    },
    {
      files: ['packages/crdt/**'], // iso, and the only first-party yjs importer (A14)
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [...bannedEverywhere, ...platformBans.electron, ...platformBans.react],
            patterns: [nodeBuiltinsTypeOnly],
          },
        ],
      },
    },
    {
      files: ['packages/{editor,markdown-react,ui}/**', 'apps/{web,desktop}/src/renderer/**'], // browser
      plugins: react.plugins,
      env: react.env,
      rules: {
        ...react.rules,
        // A stylesheet entry is imported for its side effect: that is how Vite sees Tailwind's entry
        // (07-client-applications.md section 6), and the component project's axe matchers register the same way.
        'import/no-unassigned-import': [
          'error',
          { allow: ['**/*.css', 'vitest-axe/extend-expect'] },
        ],
        // `__IRIDIUM_VERSION__` is the build-time define fixed by 07-client-applications.md section 6.1.
        'no-underscore-dangle': ['error', { allow: ['__IRIDIUM_VERSION__'] }],
        'no-restricted-imports': [
          'error',
          {
            paths: [...bannedEverywhere, ...yjsRestricted, ...platformBans.electron],
            patterns: [nodeBuiltins],
          },
        ],
      },
    },
    {
      files: [
        'packages/{mcp-bridge,testkit}/**',
        'apps/e2e/**',
        'apps/desktop/src/{main,preload}/**',
      ], // node
      plugins: node.plugins,
      env: node.env,
      rules: {
        ...node.rules,
        'no-restricted-imports': [
          'error',
          { paths: [...bannedEverywhere, ...yjsRestricted, ...platformBans.react] },
        ],
      },
    },
    {
      files: ['apps/web/src/**', 'apps/desktop/src/renderer/**'], // the two Vite entries
      rules: {
        'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
        'no-underscore-dangle': ['error', { allow: ['__IRIDIUM_VERSION__'] }],
      },
    },
    {
      files: ['apps/e2e/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              ...bannedEverywhere,
              {
                name: 'electron-playwright-helpers',
                importNames: [
                  'ipcRendererInvoke',
                  'ipcRendererSend',
                  'ipcRendererCallFirstListener',
                  'ipcMainEmit',
                  'ipcMainInvokeHandler',
                  'ipcMainCallFirstListener',
                ],
                message:
                  'These helpers require nodeIntegration: true and are banned (10, Electron security suite).',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['apps/server/src/**'], // server
      plugins: server.plugins,
      env: server.env,
      rules: server.rules,
    },
    {
      files: ['apps/server/src/config/**', 'apps/server/src/main.ts'],
      rules: { 'node/no-process-env': 'off' },
    },
    {
      files: ['apps/server/src/content/read/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              ...bannedEverywhere,
              ...yjsRestricted,
              {
                name: '@iridium/crdt',
                allowTypeImports: true,
                message: 'Committed reads cannot load a live document (A37).',
              },
              {
                name: '@hocuspocus/server',
                allowTypeImports: true,
                message: 'Committed reads cannot depend on collaboration state (A37).',
              },
            ],
          },
        ],
      },
    },
    // ---- root and tooling configuration files run under Node
    {
      files: [
        '*.config.ts',
        'tooling/**/*.ts',
        'apps/*/vite*.config.ts',
        'apps/*/tsdown*.config.ts',
        'packages/*/vite*.config.ts',
        'packages/*/tsdown*.config.ts',
      ],
      env: { node: true },
      rules: { 'no-console': 'off' },
    },
  ],
});
