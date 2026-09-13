/**
 * Spike S3 — the Electron main process of the harness.
 *
 * It is deliberately a copy of the load-bearing parts of the M0 shell rather than an import of it:
 * `apps/desktop/src/main/main.ts` hard-codes `activeServerOrigin = null` until profiles land at M5,
 * which makes the per-load CSP `connect-src 'none'` and would have the renderer refuse every probe
 * before a byte reached the server — a CSP answer to an Origin question. Everything that can decide
 * the Origin is reproduced verbatim from the shell:
 *
 *   - the `app` scheme privileges of `src/main/scheme.ts` (standard, secure, supportFetchAPI,
 *     corsEnabled, stream, codeCache),
 *   - `app.enableSandbox()` before `ready`,
 *   - the hardened `webPreferences` of `src/main/web-preferences.ts`, including the
 *     `persist:iridium` partition,
 *   - the scheme handler of `src/main/scheme.ts`: traversal guard, SPA fallback to `index.html`,
 *     `X-Content-Type-Options`, and the per-load nonce substitution,
 *   - the `packagedCsp()` shape of `src/main/csp.ts`, with `connect-src` naming the harness servers
 *     the way it will name the active profile.
 *
 * The self-signed certificate is accepted by pinning its exact PEM in `setCertificateVerifyProc` for
 * `127.0.0.1` only — never by `--ignore-certificate-errors` or `webSecurity: false`, both of which
 * the shell's CI greps ban and either of which would invalidate the result.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, net, protocol, session } from 'electron';

const config = JSON.parse(readFileSync(process.env.IRIDIUM_S03_CONFIG, 'utf8'));

const APP_SCHEME = 'app';
const APP_HOST = 'iridium';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const PARTITION = 'persist:iridium';
const CSP_NONCE_BYTES = 16;
const CSP_NONCE_PLACEHOLDER = '__IRIDIUM_CSP_NONCE__';

const events = [];
function record(entry) {
  events.push({ at: new Date().toISOString(), ...entry });
}

app.setPath('userData', config.userData);
app.enableSandbox();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function resolveRendererPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').includes('..')) return null;
  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return resolved;
}

async function isFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** `packagedCsp()` of src/main/csp.ts, with every harness server in place of the one profile. */
function harnessCsp(nonce) {
  const connect = config.targets
    .flatMap((target) => {
      const host = new URL(target.http).host;
      const wsScheme = target.ws.startsWith('wss') ? 'wss' : 'ws';
      return [new URL(target.http).origin, `${wsScheme}://${host}`];
    })
    .join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob: https: iridium-attachment:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function installAppProtocolHandler(ses) {
  ses.protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
    const resolved = resolveRendererPath(config.pagesDir, url.pathname);
    if (resolved === null) return new Response('forbidden', { status: 403 });
    const indexHtml = path.join(config.pagesDir, 'index.html');
    const file = (await isFile(resolved)) ? resolved : indexHtml;
    record({ kind: 'scheme-request', url: request.url, served: path.basename(file) });

    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    headers.set('Content-Type', type);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (file === indexHtml) {
      const nonce = randomBytes(CSP_NONCE_BYTES).toString('base64');
      headers.set('Content-Security-Policy', harnessCsp(nonce));
      const html = (await res.text()).replaceAll(CSP_NONCE_PLACEHOLDER, nonce);
      return new Response(html, { headers, status: res.status });
    }
    return new Response(res.body, { headers, status: res.status });
  });
}

const pinnedPem = config.certPem.replace(/\s+/g, '');

function pinCertificate(ses) {
  ses.setCertificateVerifyProc((request, callback) => {
    const presented = (request.certificate?.data ?? '').replace(/\s+/g, '');
    const pinned = request.hostname === '127.0.0.1' && presented === pinnedPem;
    record({
      kind: 'certificate-verify',
      hostname: request.hostname,
      verificationResult: request.verificationResult,
      errorCode: request.errorCode,
      pinned,
    });
    callback(pinned ? 0 : -3);
  });
}

function hardenedWebPreferences() {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    devTools: true,
    safeDialogs: true,
    partition: PARTITION,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: true,
  };
}

function legUrl(leg) {
  const url = new URL(leg.path, `${APP_ORIGIN}/`);
  url.searchParams.set('leg', leg.id);
  url.searchParams.set('targets', JSON.stringify(config.targets));
  url.searchParams.set('control', config.controlOrigin);
  if (leg.push !== undefined) url.searchParams.set('push', leg.push);
  return url.toString();
}

function attachConsole(contents, waiters) {
  contents.on('console-message', (...args) => {
    // Electron >= 37 passes one details object; the older signature is (event, level, message, …).
    const message = typeof args[2] === 'string' ? args[2] : (args[0]?.message ?? '');
    if (message.startsWith('[S03]')) {
      record({ kind: 'renderer', entry: JSON.parse(message.slice('[S03]'.length)) });
    } else if (message === '[S03-DONE]') {
      record({ kind: 'leg-done' });
      waiters.resolve?.();
    } else {
      record({ kind: 'renderer-console', message });
    }
  });
}

const LEG_TIMEOUT_MS = 45_000;

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const ses = session.fromPartition(PARTITION);
  pinCertificate(ses);
  installAppProtocolHandler(ses);

  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: hardenedWebPreferences(),
  });
  const waiters = {};
  attachConsole(window.webContents, waiters);

  for (const leg of config.legs) {
    const url = legUrl(leg);
    record({ kind: 'leg-start', leg: leg.id, url, reload: leg.reload === true });
    const first = new Promise((resolve) => {
      waiters.resolve = resolve;
    });
    // oxlint-disable-next-line no-await-in-loop -- the harness reuses one BrowserWindow across legs, so this leg's load must finish before the next leg reuses it
    await window.loadURL(url);
    // oxlint-disable-next-line no-await-in-loop -- waiters.resolve is a single shared slot, so this leg's done-signal must be awaited before the next leg reassigns it
    await Promise.race([first, timeout(LEG_TIMEOUT_MS)]);
    if (leg.reload === true) {
      const second = new Promise((resolve) => {
        waiters.resolve = resolve;
      });
      record({ kind: 'reload', leg: leg.id });
      window.webContents.reload();
      // oxlint-disable-next-line no-await-in-loop -- the reload reuses the same shared waiters.resolve slot and window, so it must finish before the next leg starts
      await Promise.race([second, timeout(LEG_TIMEOUT_MS)]);
    }
    record({ kind: 'leg-end', leg: leg.id, finalUrl: window.webContents.getURL() });
  }

  record({
    kind: 'versions',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    systemVersion: process.getSystemVersion?.() ?? null,
  });
  writeFileSync(config.outFile, JSON.stringify(events, null, 2));
  app.exit(0);
}

app.whenReady().then(run, (error) => {
  record({ kind: 'fatal', error: String(error) });
  writeFileSync(config.outFile, JSON.stringify(events, null, 2));
  app.exit(1);
});
