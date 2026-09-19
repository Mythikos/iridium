// Root Vitest configuration (10-testing-and-quality.md, "Vitest 5.0.0 root configuration").
// Every project is declared inline; per-package scripts pass `--config ../../vitest.config.ts`.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

import { workspaceSourceAliases } from './tooling/mutation/workspace-source-aliases.ts';

const seed = Number(process.env.IRIDIUM_TEST_SEED ?? Date.now());

// The coverage thresholds of 12-milestones.md section 3 are one gate, evaluated once over the merged
// reports by the `merge-reports` CI job, which sets IRIDIUM_COVERAGE_GATE=1; every other coverage run
// only collects. They are enforced from the M1 exit onward: M0 lands the empty stubs of every later
// boot step by design, so the M0 exit record reports the merged numbers without enforcing them.
// `docs/milestones/CURRENT` names the last exited milestone.
const exitedMilestone = readFileSync(
  join(import.meta.dirname, 'docs/milestones/CURRENT'),
  'utf8',
).trim();
const enforceCoverageThresholds =
  process.env.IRIDIUM_COVERAGE_GATE === '1' &&
  (process.env.IRIDIUM_TEST_TARGET_MILESTONE ?? exitedMilestone) !== 'M0';
console.info(`[vitest] sequence seed ${seed}`); // printed so order-coupling failures replay

export default defineConfig({
  // The repository root is the Vitest root wherever the command runs from, so a package script's
  // `--config ../../vitest.config.ts --dir .` scopes the same projects to that package.
  root: import.meta.dirname,
  resolve: {
    // One first-party module identity per test process. Mixing source-relative unit imports with
    // compiled workspace exports duplicates both state and V8 source-map function records.
    // Child, container and Electron suites still run the unmodified built product.
    alias: workspaceSourceAliases(import.meta.dirname),
  },
  test: {
    // Each worker boots native hashing and multiple server fixtures. Bound process fan-out
    // independently of the host's advertised CPU count; explicit CLI overrides remain available.
    maxWorkers: Math.min(4, availableParallelism()),
    retry: 0,
    // Forks receive this environment before Node starts, so native argon2 and I/O share the
    // documented production-sized libuv pool rather than an already-initialized pool of four.
    env: { UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '8' },
    clearMocks: true, // Vitest 5 default, stated explicitly
    sequence: { shuffle: true, seed },
    // The blob reporter is a property of the lane command, not of the config: every ci.yml lane that
    // feeds `merge-reports` passes `--reporter=default --reporter=blob --outputFile.blob=…`, and the
    // merge itself refuses to run against a config that lists `blob`.
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.{ts,tsx}',
        'apps/server/src/**/*.ts',
        // The preload itself is `index.cts`, Electron-only code that only the Playwright `electron`
        // project can execute; it is deliberately outside Vitest coverage, and `desktop.launch.e2e`
        // plus the preload-surface snapshot prove it. The per-file rule below covers `shared/**`.
        'apps/desktop/src/{preload,shared}/**/*.ts',
        'apps/web/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.spec.*',
        '**/generated/**',
        '**/*.d.ts',
        '**/testing/**',
        'apps/server/src/migrations/**',
        'apps/desktop/src/main/**', // proven by the Playwright `electron` project, which emits no Vitest coverage
      ],
      reporter: ['text', 'json-summary', 'lcov'],
      reportOnFailure: true,
      ...(enforceCoverageThresholds
        ? {
            thresholds: {
              statements: 85,
              lines: 85,
              branches: 80,
              functions: 85,
              'apps/desktop/src/{preload,shared}/**': { 100: true, perFile: true },
              'apps/server/src/auth/**': { 100: true, perFile: true },
              'apps/server/src/authz/**': { 100: true, perFile: true },
              'apps/server/src/oauth/**': { 100: true, perFile: true },
              'packages/contracts/src/{tokens,paths,authz}.ts': { 100: true, perFile: true },
              'packages/markdown/src/sanitize/**': { 100: true, perFile: true },
              'apps/server/src/collab/persistence/**': { lines: 95, branches: 90, perFile: true },
              'apps/server/src/audit/**': { lines: 95, branches: 90, perFile: true },
              'packages/crdt/src/**': { lines: 95, branches: 90, perFile: true },
            },
          }
        : {}),
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          pool: 'forks',
          isolate: true,
          testTimeout: Number(process.env.IRIDIUM_PROP_RUNS ?? 200) > 200 ? 90_000 : 10_000,
          include: [
            'packages/*/src/**/*.{unit,prop}.spec.ts',
            'apps/*/src/**/*.{unit,prop}.spec.ts',
          ],
        },
      },
      {
        test: {
          name: 'guard',
          environment: 'node',
          pool: 'forks',
          isolate: true,
          testTimeout: 30_000,
          include: [
            'apps/server/test/guards/*.guard.spec.ts', // selected by PATH, never by test title
            'packages/*/src/**/*.guard.spec.ts',
            'packages/*/test/**/*.guard.spec.ts',
            'apps/*/src/**/*.guard.spec.ts',
          ],
        },
      },
      {
        test: {
          name: 'component',
          include: [
            'packages/{ui,editor,markdown-react}/src/**/*.component.spec.tsx',
            'packages/*/test/**/*.component.spec.tsx', // package-level component trees
            'apps/web/src/**/*.component.spec.tsx',
          ],
          setupFiles: ['packages/ui/test/setup.browser.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { channel: 'chromium' } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          pool: 'forks',
          hookTimeout: 120_000,
          testTimeout: 30_000,
          globalSetup: ['packages/testkit/src/global/mysql.global.ts'],
          setupFiles: ['packages/testkit/src/global/worker-schema.setup.ts'],
          include: ['apps/server/test/integration/**/*.integration.spec.ts'],
        },
      },
      {
        test: {
          name: 'property',
          environment: 'node',
          pool: 'forks',
          testTimeout: Number(process.env.IRIDIUM_PROP_DB_RUNS ?? 200) > 200 ? 4_200_000 : 900_000,
          hookTimeout: 120_000,
          globalSetup: ['packages/testkit/src/global/mysql.global.ts'],
          setupFiles: ['packages/testkit/src/global/worker-schema.setup.ts'],
          include: ['apps/server/test/property/**/*.prop.spec.ts'],
        },
      },
      {
        test: {
          name: 'chaos',
          environment: 'node',
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
          globalSetup: [
            'packages/testkit/src/global/mysql.global.ts',
            'packages/testkit/src/global/toxiproxy.global.ts',
          ],
          setupFiles: ['packages/testkit/src/global/worker-schema.setup.ts'],
          include: ['apps/server/test/chaos/**/*.{chaos,drill}.spec.ts'], // `drill` is a layer of this project
        },
      },
      {
        test: {
          name: 'contract',
          environment: 'node',
          pool: 'forks',
          testTimeout: 60_000,
          globalSetup: ['packages/testkit/src/global/mysql.global.ts'],
          setupFiles: ['packages/testkit/src/global/worker-schema.setup.ts'],
          include: [
            'apps/server/test/contract/**/*.contract.spec.ts',
            'packages/mcp-bridge/test/**/*.contract.spec.ts',
          ],
        },
      },
      {
        test: {
          name: 'mcp',
          environment: 'node',
          pool: 'forks',
          testTimeout: 30_000,
          globalSetup: ['packages/testkit/src/global/mysql.global.ts'],
          setupFiles: ['packages/testkit/src/global/worker-schema.setup.ts'],
          include: ['apps/server/test/mcp/**/*.mcp.spec.ts'],
        },
      },
    ],
  },
});
