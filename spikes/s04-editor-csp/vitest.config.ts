// Spike S04 — the Vitest Browser Mode host, a spike-only project that never joins the root
// `vitest.config.ts`. It reuses the same Chromium the root `component` project uses
// (`@vitest/browser-playwright` with `channel: 'chromium'`) and serves the built harness page from
// `./dist` under `/s04` with the strict policy as a real response header.
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

import { s04CspHost } from './csp-host.mjs';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [s04CspHost({ dist: `${import.meta.dirname}/dist`, reportDir: import.meta.dirname })],
  test: {
    include: ['s04.csp.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({ launchOptions: { channel: 'chromium' } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
