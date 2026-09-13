/**
 * Spike S3 — the runner. One command, one JSON verdict:
 *
 *   node apps/desktop/spikes/s03/run.mjs [--workdir <dir>]
 *
 * It starts the origin-logging listeners (plain `http://127.0.0.1` and TLS `https://127.0.0.1` with a
 * self-signed certificate generated into the work directory, each in a `ws`-library and a raw-socket
 * variant), launches the Electron harness shell at `app://iridium/`, waits for every leg, then prints
 * the `Origin` received per leg/target/request kind together with the register row's pass check.
 *
 * Nothing is installed and nothing in the repository is written: `ws` is loaded from the pnpm store at
 * the catalog pin, and the certificate, the Electron `userData` directory and the event log all live
 * in the work directory (default: the OS temp directory).
 */
/* eslint-disable no-console -- stdout is this runner's only output; it is not application code. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { readTls, startRawServer, startServer } from './server.mjs';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..', '..', '..', '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const workdir = path.resolve(arg('workdir', path.join(tmpdir(), 'iridium-spike-s03')));
mkdirSync(workdir, { recursive: true });

// ---------------------------------------------------------------------------------------------
// The self-signed certificate for the TLS legs.
// ---------------------------------------------------------------------------------------------
function opensslBinary() {
  const candidates = [
    'openssl',
    'C:/Program Files/Git/usr/bin/openssl.exe',
    'C:/Program Files/OpenSSL-Win64/bin/openssl.exe',
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (probe.status === 0) return { bin: candidate, version: probe.stdout.trim() };
  }
  throw new Error('s03: no openssl binary found; put one on PATH.');
}

function ensureCertificate() {
  const keyPath = path.join(workdir, 'key.pem');
  const certPath = path.join(workdir, 'cert.pem');
  const openssl = opensslBinary();
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const result = spawnSync(
      openssl.bin,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        '30',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`s03: openssl failed: ${result.stderr}`);
    }
  }
  return { openssl: openssl.version, certPem: readFileSync(certPath, 'utf8') };
}

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

const events = [];
const record = (event) => {
  events.push({ at: new Date().toISOString(), source: 'server', ...event });
};

const { openssl, certPem } = ensureCertificate();
const tlsOptions = readTls(workdir);
const plain = await startServer({ leg: 'plain', record, repoRoot });
const tls = await startServer({ leg: 'tls', record, repoRoot, tls: tlsOptions });
const rawPlain = await startRawServer({ leg: 'raw-plain', record });
const rawTls = await startRawServer({ leg: 'raw-tls', record, tls: tlsOptions });

const lan = lanAddress();
const targets = [
  { id: 'plain-loopback', http: plain.origin, ws: `ws://127.0.0.1:${plain.port}` },
  { id: 'tls-loopback', http: tls.origin, ws: `wss://127.0.0.1:${tls.port}` },
  { id: 'raw-plain', http: rawPlain.origin, ws: `ws://127.0.0.1:${rawPlain.port}` },
  { id: 'raw-tls', http: rawTls.origin, ws: `wss://127.0.0.1:${rawTls.port}` },
];
if (lan !== null) {
  // Not part of the register row: a plain-HTTP server on a non-loopback address, to see whether the
  // secure `app://iridium` origin treats it as mixed content.
  targets.push({
    id: 'plain-lan',
    http: `http://${lan}:${plain.port}`,
    ws: `ws://${lan}:${plain.port}`,
  });
}

const legs = [
  { id: 'root', path: '/' },
  { id: 'subpage-navigated', path: '/vault/notes/deep/child' },
  { id: 'subpage-pushstate', path: '/', push: '/vault/notes/deep/child' },
  { id: 'root-reload', path: '/', reload: true },
];

const outFile = path.join(workdir, 'renderer-events.json');
const configPath = path.join(workdir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify(
    {
      pagesDir: path.join(here, 'pages'),
      userData: path.join(workdir, 'userdata'),
      outFile,
      certPem,
      controlOrigin: plain.origin,
      targets,
      legs,
    },
    null,
    2,
  ),
);

const require = createRequire(path.join(repoRoot, 'apps', 'desktop', 'package.json'));
const electronBinary = require('electron');

const exitCode = await new Promise((resolve) => {
  const child = spawn(electronBinary, [path.join(here, 'main.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, IRIDIUM_S03_CONFIG: configPath, ELECTRON_ENABLE_LOGGING: '1' },
  });
  child.on('exit', (code) => resolve(code ?? -1));
  child.on('error', (error) => {
    console.error('s03: failed to launch electron', error);
    resolve(-1);
  });
});

await plain.close();
await tls.close();
await rawPlain.close();
await rawTls.close();

const rendererEvents = existsSync(outFile)
  ? JSON.parse(readFileSync(outFile, 'utf8')).map((event) =>
      Object.assign({ source: 'main' }, event),
    )
  : [];
const all = [...events, ...rendererEvents];

// ---------------------------------------------------------------------------------------------
// The summary: one row per (leg, target, request kind) with the Origin the server received.
// ---------------------------------------------------------------------------------------------
const REQUEST_KINDS = new Set(['fetch', 'ws-upgrade', 'preflight', 'raw-fetch', 'raw-ws-upgrade']);
const observed = [];
for (const event of all) {
  if (!REQUEST_KINDS.has(event.kind)) continue;
  if (event.probe === null || event.probe === undefined) continue;
  const [leg, target, kind] = event.probe.split(':');
  observed.push({
    leg,
    target,
    request: event.kind,
    kind,
    origin: event.origin,
    originPresent: event.originPresent,
    host: event.host ?? null,
    secFetchSite: event.secFetchSite ?? null,
    originLineHex: event.originLineHex ?? null,
  });
}

/** The literal request heads the raw listeners saw, one per (leg, target, kind). */
const rawHeads = all
  .filter((event) => event.kind === 'raw-fetch' || event.kind === 'raw-ws-upgrade')
  .map((event) => ({
    probe: event.probe,
    requestLine: event.requestLine,
    originLine: event.originLine,
    originLineHex: event.originLineHex,
    headerByteLength: event.headerByteLength,
    headerBytes: event.headerBytes,
  }));

const rendererViews = all
  .filter((event) => event.kind === 'renderer' && event.entry?.type === 'page')
  .map((event) => ({
    leg: event.entry.leg,
    phase: event.entry.phase,
    href: event.entry.href,
    locationOrigin: event.entry.locationOrigin,
    windowOrigin: event.entry.windowOrigin,
    isSecureContext: event.entry.isSecureContext,
  }));

const sameOrigin = all
  .filter((event) => event.kind === 'renderer' && event.entry?.type === 'same-origin-fetch')
  .map((event) => event.entry);

const cspViolations = all
  .filter((event) => event.kind === 'renderer' && event.entry?.type === 'csp-violation')
  .map((event) => ({ directive: event.entry.directive, blockedURI: event.entry.blockedURI }));

const failures = all
  .filter(
    (event) =>
      event.kind === 'renderer' &&
      event.entry?.type !== 'same-origin-fetch' &&
      (event.entry?.ok === false || event.entry?.type === 'ws-error'),
  )
  .map((event) => event.entry);

const registerTargets = observed.filter((row) => row.target !== 'plain-lan');
const verdict = {
  allOriginsExact:
    registerTargets.length > 0 &&
    registerTargets.every((row) => row.origin === 'app://iridium' && row.originPresent === true),
  distinctOrigins: [...new Set(observed.map((row) => `${row.target}=${String(row.origin)}`))],
  legsCovered: [...new Set(observed.map((row) => row.leg))],
  requestKinds: [...new Set(observed.map((row) => row.request))],
  count: observed.length,
};

const versionEvent = all.find((event) => event.kind === 'versions');
const summary = {
  versions: {
    ...versionEvent,
    openssl,
    ws: '8.21.3',
    runnerNode: process.versions.node,
  },
  electronExitCode: exitCode,
  targets,
  legs: legs.map((leg) => leg.id),
  observed,
  rawHeads,
  rendererViews,
  sameOrigin,
  cspViolations,
  failures,
  verdict,
};

writeFileSync(
  path.join(workdir, 'results.json'),
  JSON.stringify({ summary, events: all }, null, 2),
);

console.log(JSON.stringify({ versions: summary.versions, targets, verdict }, null, 2));
console.log('\nleg | target | request | Origin received | present');
for (const row of observed) {
  console.log(
    [row.leg, row.target, row.request, String(row.origin), String(row.originPresent)].join(' | '),
  );
}
for (const head of rawHeads.slice(0, 2)) {
  console.log(`\nexact request head — ${head.probe}\n${JSON.stringify(head.headerBytes)}`);
}
console.log(`\nsame-origin fetch of an app://iridium asset: ${JSON.stringify(sameOrigin)}`);
console.log(`CSP violations: ${JSON.stringify(cspViolations)}`);
if (failures.length > 0) console.log(`\nrenderer-side failures: ${JSON.stringify(failures)}`);
console.log(`\ns03: full event log -> ${path.join(workdir, 'results.json')}`);
process.exit(verdict.allOriginsExact ? 0 : 1);
