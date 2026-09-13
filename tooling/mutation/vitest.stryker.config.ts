// The mutation lane runs the `unit` project only: Stryker does not support Browser Mode, and a
// database-backed project would make every mutant a timeout (10-testing-and-quality.md, "Mutation").
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    pool: 'forks',
    isolate: true,
    retry: 0,
    testTimeout: 10_000,
    include: ['packages/*/src/**/*.{unit,prop}.spec.ts', 'apps/*/src/**/*.{unit,prop}.spec.ts'],
  },
});
