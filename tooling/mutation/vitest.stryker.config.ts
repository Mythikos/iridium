// The mutation lane runs the `unit` project only: Stryker does not support Browser Mode, and a
// database-backed project would make every mutant a timeout (10-testing-and-quality.md, "Mutation").
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { workspaceSourceAliases } from './workspace-source-aliases.ts';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  // Pinned to the repository root rather than inherited from `process.cwd()`, because Stryker runs
  // the runner from its own working directory and the `include` globs below are repository-relative
  // (the root config does the same with `root: import.meta.dirname`).
  root: repositoryRoot,
  // Resolve inside Stryker's copied tree, never through pnpm's real-tree dist junctions.
  resolve: { alias: workspaceSourceAliases(repositoryRoot) },
  test: {
    name: 'unit',
    environment: 'node',
    pool: 'forks',
    isolate: true,
    retry: 0,
    // Direct Vitest forks receive this before Node starts. Stryker instead forces threads,
    // so run.mjs establishes the same default on its child process before the shared pool starts.
    env: { UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '8' },
    // Instrumentation adds a switch at every expression, including the UTF-16/property loops.
    // Complete the ordinary 200 examples even when each large-update case is instrumented.
    // Fast-check's deadline sits inside this limit; Stryker still owns each mutant's deadline
    // through timeoutMS + timeoutFactor * its observed dry-run time.
    testTimeout: 660_000,
    // `typescript` resolves to `@typescript/typescript6` here and to `typescript` everywhere else,
    // which forks `msw`'s peer set and so installs a second physical copy of `vitest@5.0.0` under
    // `tooling/mutation/node_modules`. Stryker itself is unaffected — its runner resolves
    // `vitest/node` from the directory it was launched in, which is the repository root — but this
    // config run by the lane's own Vitest binary loads the other copy, and an externalised
    // dependency that imports `vitest` then resolves back to the root one and throws "Vitest failed
    // to find the current suite". Inlining lets Vite alias that import to the running instance, so
    // the config behaves the same under either binary (spike S5).
    server: { deps: { inline: ['@fast-check/vitest'] } },
    include: ['packages/*/src/**/*.{unit,prop}.spec.ts', 'apps/*/src/**/*.{unit,prop}.spec.ts'],
  },
});
