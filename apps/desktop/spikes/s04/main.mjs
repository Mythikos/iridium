/**
 * Spike S04 — Electron host. The main-process entry of the harness.
 *
 * It reuses the product's own modules verbatim (type-stripped copies produced by `generate.mjs`):
 * `registerAppSchemePrivileges()`, `installAppProtocolHandler()` with its traversal guard, per-load
 * nonce and `packagedCsp()`, and `hardenedWebPreferences()`. The only differences from
 * `apps/desktop/src/main/main.ts` are the ones a harness needs: `rendererRoot` points at the spike's
 * built page instead of `dist/renderer`, `isPackaged: true` is passed explicitly so the packaged
 * policy is the one under test even though the harness is unpackaged, and `backgroundThrottling` is
 * off so `requestAnimationFrame` keeps running while the window is unfocused.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, session } from 'electron';

import { CSP_NONCE_BYTES, packagedCsp } from './generated/csp.mjs';
import {
  APP_ORIGIN,
  installAppProtocolHandler,
  registerAppSchemePrivileges,
} from './generated/scheme.mjs';
import { hardenedWebPreferences, IRIDIUM_PARTITION } from './generated/web-preferences.mjs';

// Harness-only: Chromium's Windows native occlusion detection reports the harness window as
// occluded, which parks `document.visibilityState` at `hidden` and stops `requestAnimationFrame` —
// and CodeMirror measures, Base UI positions and this spike's phases all run off animation frames.
// These switches affect only when frames are produced, never the policy under test.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Module top level, before `ready`, exactly as the product does it.
app.enableSandbox();
registerAppSchemePrivileges();

const here = import.meta.dirname;
const repo = path.resolve(here, '..', '..', '..', '..');
const rendererRoot = path.join(repo, 'spikes', 's04-editor-csp', 'dist');
const outFile = path.join(here, 'report-electron.json');

const result = {
  host: `electron ${process.versions.electron} (chromium ${process.versions.chrome}, node ${process.versions.node})`,
  rendererRoot,
  appOrigin: APP_ORIGIN,
  cspNonceBytes: CSP_NONCE_BYTES,
  policyShape: packagedCsp({ serverOrigin: null, nonce: '<nonce>' }),
  cspHeaders: [],
  consoleMessages: [],
};

function finish(code) {
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  app.exit(code);
}

const watchdog = setTimeout(() => {
  result.error = 'watchdog: the harness did not finish within 180s';
  finish(1);
}, 180_000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(contents, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling loop: each check must resolve before deciding whether the condition is already met
    const value = await contents.executeJavaScript(expression, true);
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    // oxlint-disable-next-line no-await-in-loop -- polling loop: the backoff must elapse before the next check, not run concurrently with it
    await wait(100);
  }
}

async function start() {
  const appSession = session.fromPartition(IRIDIUM_PARTITION);
  installAppProtocolHandler(appSession, {
    rendererRoot,
    serverOrigin: () => null,
    isPackaged: true,
    devServerOrigin: null,
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    backgroundColor: '#111113',
    webPreferences: {
      ...hardenedWebPreferences({
        preload: path.join(here, 'preload.cjs'),
        devTools: false,
      }),
      backgroundThrottling: false,
    },
  });

  const contents = window.webContents;
  contents.on('did-fail-load', (_event, code, description, url) => {
    result.consoleMessages.push(`did-fail-load ${code} ${description} ${url}`);
  });
  contents.on('preload-error', (_event, file, error) => {
    result.consoleMessages.push(`preload-error ${file} ${error?.message ?? error}`);
  });
  contents.on('render-process-gone', (_event, details) => {
    result.consoleMessages.push(`render-process-gone ${JSON.stringify(details)}`);
  });
  // Electron 44 passes one `ConsoleMessageEvent`; older signatures passed positional arguments.
  contents.on('console-message', (...args) => {
    const event = args[0];
    if (event !== null && typeof event === 'object' && 'message' in event) {
      const { level, message, sourceId, lineNumber } = event;
      result.consoleMessages.push(`${level}: ${message} (${sourceId}:${lineNumber})`);
    } else {
      result.consoleMessages.push(JSON.stringify(args));
    }
  });

  // Two loads of the same URL: the nonce the scheme handler substitutes must differ per load.
  await contents.loadURL(`${APP_ORIGIN}/index.html`);
  result.nonces = [
    await contents.executeJavaScript(
      "document.querySelector('meta[name=\"csp-nonce\"]').getAttribute('content')",
      true,
    ),
  ];
  await contents.loadURL(`${APP_ORIGIN}/index.html`);
  result.nonces.push(
    await contents.executeJavaScript(
      "document.querySelector('meta[name=\"csp-nonce\"]').getAttribute('content')",
      true,
    ),
  );
  result.noncesDiffer = result.nonces[0] !== result.nonces[1];
  window.focus();
  contents.focus();

  result.diagnostics = await contents.executeJavaScript(
    `({
      title: document.title,
      scripts: [...document.querySelectorAll('script')].map((s) => s.src),
      stylesheets: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href),
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      bridge: typeof window.s04,
      readyState: document.readyState,
    })`,
    true,
  );
  await poll(contents, 'window.s04?.awaitInput === true', 30_000, 'the editor to ask for input');

  // Real trusted input, delivered by the browser process.
  for (const character of 'typed by the host') {
    contents.sendInputEvent({ type: 'char', keyCode: character });
  }
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  for (const character of 'second line') {
    contents.sendInputEvent({ type: 'char', keyCode: character });
  }
  await wait(250);
  result.typedText = await contents.executeJavaScript(
    "document.querySelector('.cm-content')?.textContent?.slice(0, 60) ?? null",
    true,
  );
  await contents.executeJavaScript('window.s04.inputDone = true', true);

  await poll(contents, 'window.s04.report !== undefined', 120_000, 'the harness report');
  result.report = await contents.executeJavaScript(
    'JSON.parse(JSON.stringify(window.s04.report))',
    true,
  );

  clearTimeout(watchdog);
  finish(0);
}

app.on('window-all-closed', () => {
  // The harness owns the lifecycle; never quit on its own.
});

app
  .whenReady()
  .then(start)
  .catch((error) => {
    result.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}\n${error?.stack ?? ''}`;
    clearTimeout(watchdog);
    finish(1);
  });
