// The spike harness runs outside the root projects on purpose: nothing in the root `vitest.config.ts`
// includes `apps/server/test/spikes/**`, so the throwaway files of D12-5 never join a CI lane. Run from
// `apps/server` with `pnpm exec vitest --run --config test/spikes/vitest.config.ts`.
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '..', '..', '..', '..'),
  test: {
    name: 'spike',
    environment: 'node',
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    // Spikes are ordered narratives with measurements, not shuffled unit tests.
    sequence: { shuffle: false, concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 120_000,
    include: ['apps/server/test/spikes/**/*.spike.spec.ts'],
  },
});
