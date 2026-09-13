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
    'apps/server/test/fixtures/**',
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
