/**
 * `@iridium/e2e` fixtures (10-testing-and-quality.md, "Playwright 1.63.0 configuration").
 *
 * The `electron` project launches the built desktop shell through `_electron.launch` with
 * `IRIDIUM_E2E=1`, which disables the updater and the single-instance lock so several instances can
 * run on one machine (13-decision-log.md A53), and with `IRIDIUM_USER_DATA` pointing at a fresh
 * temporary directory so no run inherits another's state.
 *
 * The collaboration and frame-counter fixtures land with the milestones that need them.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, test as base, type ElectronApplication, type Page } from '@playwright/test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `apps/desktop`, which is both the Electron app directory and the cwd `electron .` needs. */
export const desktopDirectory = path.join(repositoryRoot, 'apps', 'desktop');

/** The three build outputs the shell cannot start without (07-client-applications.md §7.1). */
const requiredArtefacts = [
  path.join(desktopDirectory, 'dist', 'main', 'main.mjs'),
  path.join(desktopDirectory, 'dist', 'preload', 'index.cjs'),
  path.join(desktopDirectory, 'dist', 'renderer', 'index.html'),
];

/** The `electron` package's main export is the absolute path of the platform binary. */
const electronBinary: string = createRequire(path.join(desktopDirectory, 'package.json'))(
  'electron',
);

function assertDesktopIsBuilt(): void {
  const missing = requiredArtefacts.filter((artefact) => !existsSync(artefact));
  if (missing.length > 0) {
    throw new Error(
      `The desktop shell is not built. Run \`pnpm --filter @iridium/desktop build\` first. Missing: ${missing.join(', ')}`,
    );
  }
}

/** Playwright's `env` takes defined values only. */
function definedEnvironment(): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

export interface DesktopFixtures {
  /** The launched shell. Closed, and its `userData` directory removed, after every test. */
  electronApp: ElectronApplication;
  /** The single `BrowserWindow` the shell opens (07-client-applications.md D07-16). */
  firstWindow: Page;
}

export const test = base.extend<DesktopFixtures>({
  electronApp: async ({ baseURL }, use) => {
    assertDesktopIsBuilt();
    const userData = await mkdtemp(path.join(tmpdir(), 'iridium-e2e-'));
    const electronApp = await _electron.launch({
      executablePath: electronBinary,
      // `.` so Electron reads `apps/desktop/package.json`, exactly as `electron .` does — which is
      // what makes `app.getVersion()` and `app.getAppPath()` report what a packaged build reports.
      args: ['.'],
      cwd: desktopDirectory,
      env: {
        ...definedEnvironment(),
        IRIDIUM_E2E: '1',
        IRIDIUM_USER_DATA: userData,
        IRIDIUM_SERVER_URL: baseURL ?? '',
      },
      timeout: 30_000,
    });
    try {
      await use(electronApp);
    } finally {
      await electronApp.close();
      await rm(userData, { recursive: true, force: true });
    }
  },

  firstWindow: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

export { expect } from '@playwright/test';
