/**
 * The Electron main process entry (07-client-applications.md §7.1, §7.2).
 *
 * The main bundle is ESM, which changes one thing that matters: `import` evaluation is asynchronous,
 * so `protocol.registerSchemesAsPrivileged` and `app.enableSandbox()` are called at module top level
 * — both must run before `ready` — and everything that depends on a session happens inside
 * `whenReady`. `desktop.boot-order.spec` asserts that ordering from M5.
 *
 * M0 is the shell the spikes and `desktop.launch.e2e` need: one hardened window loading
 * `app://iridium/`, the traversal-guarded scheme handler with the per-load CSP, deny-by-default
 * permissions, and the single IPC channel `iridium:app:info`. Profiles, credential custody, the REST
 * proxy, transfers, the native menu, deep links and the update check arrive with M5.
 */
import { app, BrowserWindow, session } from 'electron';

import { registerIpcHandlers, type IpcOriginPolicy } from './ipc.ts';
import { initializeLogging, log } from './log.ts';
import {
  installAppProtocolHandler,
  installDevelopmentCsp,
  registerAppSchemePrivileges,
} from './scheme.ts';
import { IRIDIUM_PARTITION } from './web-preferences.ts';
import { createMainWindow, hardenSession, PACKAGED_LOAD_URL, rendererRoot } from './window.ts';

// ---------------------------------------------------------------------------------------------
// Module top level: both of these must run before `ready`.
// ---------------------------------------------------------------------------------------------
app.enableSandbox();
registerAppSchemePrivileges();
initializeLogging();

/** Playwright's `electron` project sets this; it disables the updater and the single-instance lock. */
const isE2E = process.env.IRIDIUM_E2E === '1';

/**
 * The harness gives every launched instance its own `userData` directory (10-testing-and-quality.md
 * D10-5), which is what lets three instances run on one machine without sharing window state,
 * profiles or the credential store. It must be applied before anything reads a path.
 */
const userDataOverride = process.env.IRIDIUM_USER_DATA;
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride);
}

/** Set by `scripts/dev.mjs`; absent in every packaged and every end-to-end run. */
const devServerOrigin = app.isPackaged ? null : (process.env.VITE_DEV_SERVER_URL ?? null);

/** The active profile's origin. Profiles land at M5; until then the renderer may reach nothing. */
const activeServerOrigin: string | null = null;

const originPolicy: IpcOriginPolicy = { isPackaged: app.isPackaged, devServerOrigin };

let mainWindow: BrowserWindow | null = null;

function openMainWindow(): void {
  mainWindow = createMainWindow({
    devTools: !app.isPackaged,
    loadUrl: devServerOrigin ?? PACKAGED_LOAD_URL,
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function start(): void {
  const appSession = session.fromPartition(IRIDIUM_PARTITION);
  hardenSession(appSession);
  installAppProtocolHandler(appSession, {
    rendererRoot: rendererRoot(),
    serverOrigin: () => activeServerOrigin,
    isPackaged: app.isPackaged,
    devServerOrigin,
  });
  if (!app.isPackaged && devServerOrigin !== null) {
    installDevelopmentCsp(appSession, { devServerOrigin, serverOrigin: () => activeServerOrigin });
  }
  registerIpcHandlers(originPolicy);
  openMainWindow();
}

/**
 * One instance owns the deep-link route and the credential store (§7.2). `IRIDIUM_E2E=1` disables
 * the lock so Playwright can run three instances on one machine (A53).
 */
const hasInstanceLock = isE2E || app.requestSingleInstanceLock();

if (hasInstanceLock) {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // macOS keeps the application running with no window; every other platform quits.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });

  void app.whenReady().then(start, (error: unknown) => {
    log.error({ error }, 'startup failed');
    app.exit(1);
  });
} else {
  app.quit();
}
