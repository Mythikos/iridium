#!/usr/bin/env node
// S13 argon2id calibration harness — seed of `iridium doctor --argon2`.
//
// Imports @node-rs/argon2 by walking up from this file's directory, so it
// resolves the version already installed for apps/server (2.2.1, catalog-pinned)
// on the host, and whatever a caller's own node_modules provides elsewhere
// (used unmodified inside the throwaway container run).
//
// Usage:
//   node measure.mjs --label=<name> [--mysql-url=mysql://user:pass@host:port/db]
//
// Env overrides: ARGON2_MEMORY_KIB, ARGON2_TIME_COST, ARGON2_PARALLELISM,
// ARGON2_HASH_LENGTH, ARGON2_PEPPER.
//
// Prints one JSON object to stdout.

import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { hash, verify, parseOptions } from '@node-rs/argon2';

import { readArgon2Options, summarize, round } from './lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);

const label = args.label ?? 'unlabeled';
const mysqlUrl = args['mysql-url'] ?? process.env.S13_MYSQL_URL ?? null;
const SEQUENTIAL_N = 20;
const CONCURRENT_N = 8;
const PROBE_INTERVAL_MS = 10;

const options = readArgon2Options();

async function timeOne(password) {
  const t0 = performance.now();
  const phc = await hash(password, options);
  const ms = performance.now() - t0;
  return { ms, phc };
}

async function runSequential() {
  const samples = [];
  let lastPhc = null;
  for (let i = 0; i < SEQUENTIAL_N; i++) {
    // oxlint-disable-next-line no-await-in-loop -- the sequential leg measures one hash at a time on purpose; `runConcurrentWithProbe` below is the concurrent leg
    const { ms, phc } = await timeOne(`s13-sequential-${i}-${label}`);
    samples.push(ms);
    lastPhc = phc;
  }
  return { samples, lastPhc };
}

async function makeProbe() {
  if (mysqlUrl) {
    const { createPool } = await import('mysql2/promise');
    const pool = createPool({ uri: mysqlUrl, connectionLimit: 8, waitForConnections: true });
    return {
      kind: 'mysql-select-1',
      tick: async () => {
        await pool.query('SELECT 1');
      },
      close: async () => pool.end(),
    };
  }
  return {
    kind: 'timer-setImmediate',
    tick: () => new Promise((resolve) => setImmediate(resolve)),
    close: async () => {},
  };
}

async function runProbeOnly(probe, durationMs) {
  const latencies = [];
  const start = performance.now();
  // A plain `let stop` here reads, to static analysis, as a condition that is
  // never reassigned inside the loop body — the reassignment below happens in
  // the enclosing function, after `loop()` has been started. Routing it
  // through a shared control object keeps the same two-task shape (a
  // background sampling loop stopped by its caller) while making the mutation
  // visible at its one call site.
  const control = { stop: false };
  const loop = async () => {
    while (!control.stop) {
      const scheduled = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- the interval between samples is the sampling rate; the loop runs until its caller stops it
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
      const t0 = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- one probe in flight at a time, or the latency this records is queueing on the probe itself
      await probe.tick();
      latencies.push(performance.now() - t0);
      void scheduled;
    }
  };
  const p = loop();
  await new Promise((r) => setTimeout(r, durationMs));
  control.stop = true;
  await p;
  return { latencies, wallMs: performance.now() - start };
}

async function runConcurrentWithProbe(probe) {
  const probeLatencies = [];
  let probeCount = 0;
  const control = { stop: false };

  const probeLoop = async () => {
    while (!control.stop) {
      // oxlint-disable-next-line no-await-in-loop -- as above: the interval is the sampling rate, and the loop ends when the hashing leg sets `control.stop`
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
      if (control.stop) break;
      const t0 = performance.now();
      try {
        // oxlint-disable-next-line no-await-in-loop -- as above: one probe in flight at a time, so the sample is the event loop's delay and not the probe's own queue
        await probe.tick();
        probeLatencies.push(performance.now() - t0);
      } catch {
        probeLatencies.push(-1);
      }
      probeCount++;
    }
  };

  const probePromise = probeLoop();
  const hashStart = performance.now();
  const hashPromises = Array.from({ length: CONCURRENT_N }, (_, i) =>
    (async () => {
      const t0 = performance.now();
      await hash(`s13-concurrent-${i}-${label}`, options);
      return performance.now() - t0;
    })(),
  );
  const hashDurations = await Promise.all(hashPromises);
  const totalWallMs = performance.now() - hashStart;
  control.stop = true;
  await probePromise;

  return {
    hashDurations,
    totalWallMs,
    probeLatencies: probeLatencies.filter((v) => v >= 0),
    probeErrors: probeLatencies.filter((v) => v < 0).length,
    probeCount,
  };
}

async function needsRehashDemo() {
  const current = await hash('s13-needs-rehash-subject', options);
  const parsedCurrent = parseOptions(current);
  const changedOptions = { ...options, timeCost: options.timeCost + 1 };
  const changed = await hash('s13-needs-rehash-subject', changedOptions);
  const parsedChanged = parseOptions(changed);

  const targetPolicy = {
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
    parallelism: options.parallelism,
  };
  const matchesCurrent =
    parsedCurrent.memoryCost === targetPolicy.memoryCost &&
    parsedCurrent.timeCost === targetPolicy.timeCost &&
    parsedCurrent.parallelism === targetPolicy.parallelism;
  const matchesChanged =
    parsedChanged.memoryCost === targetPolicy.memoryCost &&
    parsedChanged.timeCost === targetPolicy.timeCost &&
    parsedChanged.parallelism === targetPolicy.parallelism;

  return {
    targetPolicy,
    parsedCurrent,
    parsedChanged,
    needsRehashBeforeChange: !matchesCurrent,
    needsRehashAfterChange: !matchesChanged,
  };
}

async function main() {
  const probe = await makeProbe();

  const baseline = await runProbeOnly(
    probe,
    CONCURRENT_N * 20 /* rough headroom, not load-bearing */,
  );
  const { samples: sequentialSamples, lastPhc } = await runSequential();
  const verifyOk = await verify(lastPhc, `s13-sequential-${SEQUENTIAL_N - 1}-${label}`, options);
  const concurrent = await runConcurrentWithProbe(probe);
  const rehash = await needsRehashDemo();

  await probe.close();

  const result = {
    label,
    timestamp: new Date().toISOString(),
    platform: {
      os: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpus: os.cpus().length,
      totalMemGiB: round(os.totalmem() / 2 ** 30, 2),
    },
    node: process.version,
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? '(default: 4)',
    argon2Options: { ...options, secret: `<${options.secret.length} bytes>` },
    probeKind: probe.kind,
    sequential: {
      n: SEQUENTIAL_N,
      samplesMs: sequentialSamples.map((v) => round(v)),
      summary: summarizeRound(sequentialSamples),
    },
    verifyLastPhcOk: verifyOk,
    samplePhc: lastPhc,
    baselineProbe: {
      n: baseline.latencies.length,
      summary: summarizeRound(baseline.latencies),
    },
    concurrentWithHashing: {
      hashDurationsMs: concurrent.hashDurations.map((v) => round(v)),
      hashSummary: summarizeRound(concurrent.hashDurations),
      totalWallMs: round(concurrent.totalWallMs),
      probeLatencySummary: summarizeRound(concurrent.probeLatencies),
      probeSampleCount: concurrent.probeCount,
      probeErrorCount: concurrent.probeErrors,
    },
    needsRehash: rehash,
  };

  console.info(JSON.stringify(result, null, 2));
}

function summarizeRound(samples) {
  const s = summarize(samples);
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]),
  );
}

main().catch((err) => {
  console.error('S13 measurement failed:', err);
  process.exitCode = 1;
});
