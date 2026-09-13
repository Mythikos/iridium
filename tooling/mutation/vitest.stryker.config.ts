// The mutation lane runs the `unit` project only: Stryker does not support Browser Mode, and a
// database-backed project would make every mutant a timeout (10-testing-and-quality.md, "Mutation").
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Pinned to the repository root rather than inherited from `process.cwd()`, because Stryker runs
  // the runner from its own working directory and the `include` globs below are repository-relative
  // (the root config does the same with `root: import.meta.dirname`).
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    name: 'unit',
    environment: 'node',
    pool: 'forks',
    isolate: true,
    retry: 0,
    // Six times the unit project's 10 s. Stryker instruments every mutated module with a mutant switch
    // in each expression, so the code-point loops of `packages/crdt` run an order of magnitude slower
    // in the dry run than in the unit lane, and the 200-run properties there measured past 10 s. The
    // per-mutant budget is still Stryker's own: `timeoutMS` plus `timeoutFactor` times the dry-run
    // time of each test (stryker.config.mjs), so a slow mutant is caught by that, not by this.
    testTimeout: 60_000,
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
