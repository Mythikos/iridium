#!/usr/bin/env node
// S13 parameter sweep: finds an ARGON2_MEMORY_KIB / ARGON2_TIME_COST pair
// whose sequential p50 lands in the 150-300ms target window, on whatever
// host/container this runs in. Not part of the doctor seed — throwaway.

import { performance } from 'node:perf_hooks';

import { hash } from '@node-rs/argon2';

const SAMPLES = 5;
const secret = Buffer.from('s13-scratch-pepper-do-not-use-in-prod', 'utf8');

const candidates = process.argv.slice(2).length
  ? JSON.parse(process.argv[2])
  : [
      { memoryCost: 65536, timeCost: 3 },
      { memoryCost: 65536, timeCost: 6 },
      { memoryCost: 65536, timeCost: 9 },
      { memoryCost: 131072, timeCost: 6 },
      { memoryCost: 131072, timeCost: 9 },
      { memoryCost: 196608, timeCost: 6 },
    ];

function median(arr) {
  const s = arr.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

for (const c of candidates) {
  const options = {
    memoryCost: c.memoryCost,
    timeCost: c.timeCost,
    parallelism: 1,
    outputLen: 32,
    secret,
  };
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- a sequential p50 is the measurement: concurrent hashes would contend for the same memory and threadpool and time something else
    await hash(`sweep-${c.memoryCost}-${c.timeCost}-${i}`, options);
    samples.push(performance.now() - t0);
  }
  console.info(
    JSON.stringify({
      memoryCost: c.memoryCost,
      timeCost: c.timeCost,
      samplesMs: samples.map((v) => Math.round(v * 100) / 100),
      medianMs: Math.round(median(samples) * 100) / 100,
    }),
  );
}
