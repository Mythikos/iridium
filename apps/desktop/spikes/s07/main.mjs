/**
 * Spike S07 — the Electron harness.
 *
 * It reproduces the M0 shell's security-relevant surface exactly: `app.enableSandbox()` and
 * `protocol.registerSchemesAsPrivileged` at module top level with the same privilege set as
 * `src/main/scheme.ts`, a dedicated persistent partition, `session.protocol.handle('app', …)`
 * serving the probe page with a per-load CSP, and a `BrowserWindow` whose `webPreferences` are read
 * from the committed snapshot `src/main/__snapshots__/desktop.webPreferences.json` so the harness
 * cannot drift from the shipped hardening. Only `preload` and `partition` are overridden.
 *
 * Phases (one Electron launch each, so no certificate-verification cache is shared):
 *   --phase=trusted   the throwaway CA is in the Windows CurrentUser Root store; no verify proc
 *   --phase=pinned    the CA has been removed; a `pinnedCertSha256` proc scoped to one host
 *   --phase=pinmiss   the CA has been removed; the same proc with a deliberately wrong pin
 *
 * Throwaway harness for `docs/spikes/S07-electron-enterprise-ca.md`. Not part of the product build.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron';

import { ENDPOINTS, originOf, wsOriginOf } from './endpoints.mjs';

// ---------------------------------------------------------------------------------------------
// Module top level: both of these must run before `ready` (mirrors src/main/main.ts).
// ---------------------------------------------------------------------------------------------
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
  {
    scheme: 'iridium-attachment',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function argument(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const PHASE = argument('phase', 'trusted');
const PKI_DIR = argument('pki', '');
const OUT_FILE = argument('out', '');
const USER_DATA = argument('userdata', '');
if (USER_DATA !== '') app.setPath('userData', USER_DATA);
const HARNESS_DIR = import.meta.dirname;
const RENDERER_DIR = path.join(HARNESS_DIR, 'renderer');
const PARTITION = 'persist:iridium-s07';

const results = {
  phase: PHASE,
  startedAt: new Date().toISOString(),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
  },
  platform: `${process.platform}-${process.arch}`,
  webPreferences: null,
  pin: null,
  stages: {},
  mainProbes: [],
  certificateErrorEvents: [],
  verifyProcCalls: [],
  netErrors: [],
  cspViolations: [],
  notes: [],
};

// ---------------------------------------------------------------------------------------------
// Certificate helpers
// ---------------------------------------------------------------------------------------------
function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

function sha256OfPem(pem) {
  return createHash('sha256').update(pemToDer(pem)).digest('hex');
}

function leafSha256(leafName) {
  return sha256OfPem(readFileSync(path.join(PKI_DIR, `${leafName}.crt`), 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// The probe page, served from app://iridium with the packaged-shaped CSP
// ---------------------------------------------------------------------------------------------
/** A publicly trusted origin, used to prove a host-scoped pin does not break ordinary TLS. */
const PUBLIC_ORIGIN = 'https://example.com';

function connectSources() {
  return [
    ...ENDPOINTS.flatMap((endpoint) => [
      `https://${endpoint.host}:${endpoint.port}`,
      `wss://${endpoint.host}:${endpoint.port}`,
    ]),
    PUBLIC_ORIGIN,
  ].join(' ');
}

function csp(nonce) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob: https: iridium-attachment:",
    "font-src 'self'",
    `connect-src ${connectSources()}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

function installAppProtocol(appSession) {
  appSession.protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'iridium') return new Response('not found', { status: 404 });
    const name = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(RENDERER_DIR, path.basename(name));
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers();
    headers.set('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (path.extname(file) === '.html') {
      const nonce = randomBytes(16).toString('base64');
      headers.set('Content-Security-Policy', csp(nonce));
      return new Response(await response.text(), { headers, status: 200 });
    }
    return new Response(response.body, { headers, status: response.status });
  });
}

// ---------------------------------------------------------------------------------------------
// Probe definitions
// ---------------------------------------------------------------------------------------------
const P_TRUSTED = 'trustedCA_iridium';
const P_UNTRUSTED = 'untrustedCA_iridium';
const P_OTHER = 'untrustedCA_other';

const STAGES = {
  trusted: [
    {
      name: 'os-store',
      probes: [
        { id: 'renderer.fetch.osStoreCA', kind: 'fetch', url: `${originOf(P_TRUSTED)}/ok` },
        { id: 'renderer.ws.osStoreCA', kind: 'ws', url: `${wsOriginOf(P_TRUSTED)}/ws` },
        { id: 'renderer.img.osStoreCA', kind: 'img', url: `${originOf(P_TRUSTED)}/pixel.png` },
        { id: 'renderer.fetch.untrustedCA', kind: 'fetch', url: `${originOf(P_UNTRUSTED)}/ok` },
        { id: 'renderer.ws.untrustedCA', kind: 'ws', url: `${wsOriginOf(P_UNTRUSTED)}/ws` },
        { id: 'renderer.img.untrustedCA', kind: 'img', url: `${originOf(P_UNTRUSTED)}/pixel.png` },
      ],
    },
  ],
  pinned: [
    {
      name: 'control-no-pin',
      probes: [{ id: 'renderer.fetch.caRemoved', kind: 'fetch', url: `${originOf(P_TRUSTED)}/ok` }],
    },
    {
      name: 'pin-match',
      probes: [
        { id: 'renderer.fetch.pinnedHost', kind: 'fetch', url: `${originOf(P_UNTRUSTED)}/ok` },
        { id: 'renderer.ws.pinnedHost', kind: 'ws', url: `${wsOriginOf(P_UNTRUSTED)}/ws` },
        { id: 'renderer.img.pinnedHost', kind: 'img', url: `${originOf(P_UNTRUSTED)}/pixel.png` },
        { id: 'renderer.fetch.otherHost', kind: 'fetch', url: `${originOf(P_OTHER)}/ok` },
        { id: 'renderer.fetch.publicPki', kind: 'fetch', url: `${PUBLIC_ORIGIN}/` },
      ],
    },
  ],
  pinmiss: [
    {
      name: 'pin-mismatch',
      probes: [
        { id: 'renderer.fetch.pinMismatch', kind: 'fetch', url: `${originOf(P_UNTRUSTED)}/ok` },
      ],
    },
  ],
};

async function mainFetch(id, url, which, appSession) {
  const started = Date.now();
  try {
    const response = which === 'session' ? await appSession.fetch(url) : await net.fetch(url);
    const body = await response.text();
    return {
      id,
      url,
      api: which,
      ok: true,
      status: response.status,
      body,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      id,
      url,
      api: which,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ms: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Main-frame navigation baseline: does `certificate-error` fire for a top-level load?
// ---------------------------------------------------------------------------------------------
async function mainFrameNavigationBaseline(appSession, webPreferences) {
  const auxiliary = new BrowserWindow({ show: false, webPreferences });
  const url = `${originOf(P_UNTRUSTED)}/ok`;
  const failure = new Promise((resolve) => {
    auxiliary.webContents.once('did-fail-load', (_event, code, description) => {
      resolve({ ok: false, code, description });
    });
    auxiliary.webContents.once('did-finish-load', () => {
      resolve({ ok: true });
    });
    setTimeout(() => {
      resolve({ ok: false, code: null, description: 'timeout' });
    }, 10_000);
  });
  const before = results.certificateErrorEvents.length;
  auxiliary.loadURL(url).catch(() => {});
  const outcome = await failure;
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  const fired = results.certificateErrorEvents.slice(before);
  auxiliary.destroy();
  void appSession;
  return { url, outcome, certificateErrorEvents: fired.length, events: fired };
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
function finish(code) {
  results.finishedAt = new Date().toISOString();
  if (OUT_FILE !== '') writeFileSync(OUT_FILE, `${JSON.stringify(results, null, 2)}\n`);
  app.exit(code);
}

app.on(
  'certificate-error',
  (event, _webContents, url, error, certificate, callback, isMainFrame) => {
    results.certificateErrorEvents.push({
      url,
      error,
      isMainFrame,
      subjectName: certificate.subjectName,
      issuerName: certificate.issuerName,
      fingerprint: certificate.fingerprint,
      leafSha256: sha256OfPem(certificate.data),
    });
    // The shell never overrides a certificate error; the profile pin is the only sanctioned route.
    callback(false);
  },
);

async function start() {
  const snapshotPath = path.join(
    HARNESS_DIR,
    '..',
    '..',
    'src',
    'main',
    '__snapshots__',
    'desktop.webPreferences.json',
  );
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const webPreferences = {
    ...snapshot,
    partition: PARTITION,
    preload: path.join(HARNESS_DIR, 'preload.cjs'),
  };
  results.webPreferences = webPreferences;

  const appSession = session.fromPartition(PARTITION);
  installAppProtocol(appSession);

  appSession.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (details) => {
    results.netErrors.push({ url: details.url, error: details.error, type: details.resourceType });
  });

  const pin =
    PHASE === 'pinned'
      ? { hostname: 'iridium-test.localhost', sha256: leafSha256('leafB_iridium') }
      : PHASE === 'pinmiss'
        ? { hostname: 'iridium-test.localhost', sha256: `${'0'.repeat(63)}1` }
        : null;
  results.pin = pin;

  function installVerifyProc() {
    appSession.setCertificateVerifyProc((request, callback) => {
      const observedSha = sha256OfPem(request.certificate.data);
      const match = request.hostname === pin.hostname && observedSha === pin.sha256;
      results.verifyProcCalls.push({
        hostname: request.hostname,
        chromiumVerificationResult: request.verificationResult,
        chromiumErrorCode: request.errorCode,
        isIssuedByKnownRoot: request.isIssuedByKnownRoot,
        leafSha256: observedSha,
        electronFingerprint: request.certificate.fingerprint,
        subjectName: request.certificate.subjectName,
        issuerName: request.certificate.issuerName,
        decision: match ? 0 : -3,
      });
      callback(match ? 0 : -3);
    });
  }

  if (PHASE === 'pinmiss') installVerifyProc();

  const window = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences });
  const rendererReady = new Promise((resolve) => {
    ipcMain.handleOnce('s07:ready', () => {
      resolve();
      return true;
    });
  });
  window.loadURL('app://iridium/').catch((error) => {
    results.notes.push(`loadURL failed: ${String(error)}`);
  });
  await rendererReady;
  results.notes.push(`renderer origin: ${await window.webContents.executeJavaScript('origin')}`);

  async function runStage(stage) {
    const done = new Promise((resolve) => {
      ipcMain.handleOnce('s07:report', (_event, payload) => {
        resolve(payload);
        return true;
      });
    });
    window.webContents.send('s07:stage', stage);
    const payload = await done;
    results.stages[stage.name] = payload.probes;
    results.cspViolations.push(...payload.cspViolations);
  }

  const stages = STAGES[PHASE];

  if (PHASE === 'trusted') {
    await runStage(stages[0]);
    results.mainProbes.push(
      await mainFetch(
        'main.session.fetch.osStoreCA',
        `${originOf(P_TRUSTED)}/ok`,
        'session',
        appSession,
      ),
      await mainFetch(
        'main.default.fetch.osStoreCA',
        `${originOf(P_TRUSTED)}/ok`,
        'net',
        appSession,
      ),
      await mainFetch(
        'main.session.fetch.untrustedCA',
        `${originOf(P_UNTRUSTED)}/ok`,
        'session',
        appSession,
      ),
      await mainFetch(
        'main.default.fetch.untrustedCA',
        `${originOf(P_UNTRUSTED)}/ok`,
        'net',
        appSession,
      ),
    );
    results.mainFrameBaseline = await mainFrameNavigationBaseline(appSession, webPreferences);
  }

  if (PHASE === 'pinned') {
    await runStage(stages[0]);
    results.mainProbes.push(
      await mainFetch(
        'main.session.fetch.caRemoved',
        `${originOf(P_TRUSTED)}/ok`,
        'session',
        appSession,
      ),
    );
    installVerifyProc();
    results.notes.push(`verify proc installed, pin=${pin.hostname}/${pin.sha256}`);
    await runStage(stages[1]);
    results.mainProbes.push(
      await mainFetch(
        'main.session.fetch.pinnedHost',
        `${originOf(P_UNTRUSTED)}/ok`,
        'session',
        appSession,
      ),
      await mainFetch(
        'main.default.fetch.pinnedHost',
        `${originOf(P_UNTRUSTED)}/ok`,
        'net',
        appSession,
      ),
      await mainFetch(
        'main.session.fetch.otherHost',
        `${originOf(P_OTHER)}/ok`,
        'session',
        appSession,
      ),
      await mainFetch(
        'main.session.fetch.pinnedHostWrongCert',
        `${originOf(P_TRUSTED)}/ok`,
        'session',
        appSession,
      ),
      await mainFetch('main.session.fetch.publicPki', `${PUBLIC_ORIGIN}/`, 'session', appSession),
    );
  }

  if (PHASE === 'pinmiss') {
    await runStage(stages[0]);
    results.mainProbes.push(
      await mainFetch(
        'main.session.fetch.pinMismatch',
        `${originOf(P_UNTRUSTED)}/ok`,
        'session',
        appSession,
      ),
    );
  }

  // Let any trailing `certificate-error` / `onErrorOccurred` callbacks land before writing.
  await new Promise((resolve) => {
    setTimeout(resolve, 750);
  });
  finish(0);
}

app.on('window-all-closed', () => {});

void app.whenReady().then(start, (error) => {
  results.notes.push(`startup failed: ${String(error)}`);
  finish(1);
});

setTimeout(() => {
  results.notes.push('hard timeout reached');
  finish(2);
}, 120_000);
