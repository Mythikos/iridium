// Root Playwright configuration (10-testing-and-quality.md, "Playwright 1.63.0 configuration").
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'apps/e2e',
  // Distinguish repeated Electron cases when the three operating-system blobs are merged.
  ...(CI ? { tag: `@${process.platform}` } : {}),
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  ...(CI ? { workers: 4 } : {}),
  reporter: CI ? [['blob'], ['github']] : [['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.IRIDIUM_E2E_ORIGIN ?? 'http://127.0.0.1:4000',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    extraHTTPHeaders: {
      'X-Iridium-Client-Version': process.env.IRIDIUM_E2E_CLIENT_VERSION ?? '0.0.0-e2e',
    },
  },
  ...(process.env.IRIDIUM_E2E_EXTERNAL_SERVER
    ? {}
    : {
        webServer: {
          command: 'node apps/server/dist/main.mjs serve', // the built bundle, never the Vite dev server
          url: 'http://127.0.0.1:4000/readyz',
          reuseExistingServer: !CI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            NODE_ENV: 'test',
            PUBLIC_ORIGIN: 'http://127.0.0.1:4000',
            COLLAB_DEBOUNCE_MS: '100',
            COLLAB_MAX_DEBOUNCE_MS: '500',
          },
        },
      }),
  projects: [
    { name: 'setup', testMatch: /apps\/e2e\/setup\/.*\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /apps\/e2e\/web\/.*\.e2e\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'electron',
      testMatch: /apps\/e2e\/electron\/.*\.e2e\.spec\.ts/,
      dependencies: ['setup'],
      workers: 1,
    },
  ],
});
