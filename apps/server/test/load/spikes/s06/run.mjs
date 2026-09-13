/**
 * Spike S6's one command: bundle, boot the S2 harness server, run k6 against it, shut it down and
 * write `results/s06-run.json`.
 *
 *   node run.mjs --k6 <path to k6.exe> [--no-build] [--markers 40]
 *
 * `S06_K6` is read when the flag is absent. The k6 binary is deliberately a path, never a `PATH`
 * lookup: the spike pins k6 2.2.0 and nothing is installed system-wide. The bundler is not a path —
 * esbuild is a `devDependency` of this package, so `build.mjs` needs nothing staged.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, env, exit, versions } from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_CWD = resolve(HERE, '..', '..', '..', '..');
const BUNDLE = join(HERE, 'dist', 's06-collab.bundle.js');
const RESULTS = join(HERE, 'results');

function argValue(flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

const k6Binary = argValue('--k6', env['S06_K6']);
const markers = argValue('--markers', env['S06_MARKERS'] ?? '40');
const vus = argValue('--vus', env['S06_VUS'] ?? '1');
const markerIntervalMs = argValue('--interval', env['S06_MARKER_INTERVAL_MS'] ?? '25');
const documentName = argValue('--document', env['S06_DOCUMENT'] ?? 's06-note');
const skipBuild = argv.includes('--no-build');

if (k6Binary === undefined) {
  console.error('run.mjs: pass --k6 <path to k6.exe> or set S06_K6');
  exit(2);
}

mkdirSync(RESULTS, { recursive: true });

/** Run a child to completion, streaming its stderr through. */
function run(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout }));
  });
}

if (!skipBuild) {
  const build = await run(process.execPath, [join(HERE, 'build.mjs')], { cwd: HERE });
  if (build.code !== 0) exit(build.code ?? 1);
}

// ---- boot the harness server and wait for its `ready` line
const server = spawn(process.execPath, [join(HERE, 'server.ts')], {
  cwd: SERVER_CWD,
  stdio: ['pipe', 'pipe', 'inherit'],
});
server.stdout.setEncoding('utf8');

const serverEvents = [];
let pendingLine = '';
const waiters = [];
server.stdout.on('data', (chunk) => {
  pendingLine += chunk;
  const parts = pendingLine.split('\n');
  pendingLine = parts.pop() ?? '';
  for (const line of parts) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(`server: ${line}\n`);
      continue;
    }
    serverEvents.push(parsed);
    const matched = waiters.filter((waiter) => waiter.event === parsed.event);
    for (const waiter of matched) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(parsed);
    }
  }
});

function waitForServerEvent(name, timeoutMs) {
  const existing = serverEvents.find((candidate) => candidate.event === name);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`timed out waiting for server ${name}`)),
      timeoutMs,
    );
    waiters.push({
      event: name,
      resolve: (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
    });
  });
}

const ready = await waitForServerEvent('ready', 60_000);
console.info(`run.mjs: harness server listening on ${ready.origin}`);

// ---- k6
const summaryPath = argValue(
  '--summary',
  `results/s06-k6-summary${vus === '1' ? '' : `-vus${vus}`}.json`,
);
const k6 = await run(k6Binary, ['run', '--no-usage-report', '--summary-mode=full', BUNDLE], {
  cwd: HERE,
  env: {
    ...env,
    K6_BINARY_PROVISIONING: 'false',
    S06_WS_URL: ready.wsUrl,
    S06_ORIGIN: ready.origin,
    S06_TOKEN: ready.token,
    S06_DOCUMENT: documentName,
    S06_MARKERS: String(markers),
    S06_VUS: String(vus),
    // Unique per run so a restart never reuses a `Y.Doc.clientID` against the same document.
    // `--yjs-client-id` passes 0, which reproduces the k6 `getRandomValues` defect instead.
    S06_CLIENT_ID_BASE: argv.includes('--yjs-client-id')
      ? '0'
      : String((Date.now() % 100_000) * 1000),
    S06_MARKER_INTERVAL_MS: String(markerIntervalMs),
    S06_SUMMARY: summaryPath,
  },
});

// ---- shut the server down and collect its counters
server.stdin.write('shutdown\n');
let shutdown = null;
try {
  shutdown = await waitForServerEvent('shutdown', 30_000);
} catch (error) {
  console.error(`run.mjs: ${String(error)}`);
  server.kill();
}

let k6Summary = null;
try {
  k6Summary = JSON.parse(readFileSync(join(HERE, summaryPath), 'utf8'));
} catch (error) {
  console.error(`run.mjs: no k6 summary at ${summaryPath}: ${String(error)}`);
}
let bundleMeta = null;
try {
  bundleMeta = JSON.parse(readFileSync(join(RESULTS, 's06-bundle-meta.json'), 'utf8'));
} catch {
  bundleMeta = null;
}

const record = {
  spike: 'S6',
  generatedAt: new Date().toISOString(),
  node: versions.node,
  k6: {
    binary: k6Binary,
    exitCode: k6.code,
    vusPerScenario: Number(vus),
    markers: Number(markers),
  },
  bundle: bundleMeta,
  server: { ready, shutdown },
  summary: k6Summary,
};
writeFileSync(
  join(RESULTS, vus === '1' ? 's06-run.json' : `s06-run-vus${vus}.json`),
  `${JSON.stringify(record, null, 2)}\n`,
  'utf8',
);
console.info(`run.mjs: k6 exit ${String(k6.code)}; results/s06-run.json written`);
exit(k6.code ?? 1);
