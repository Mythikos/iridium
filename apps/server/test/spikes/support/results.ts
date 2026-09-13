/** Measurement files the spike notes cite: `apps/server/test/spikes/results/<name>.json`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESULTS_DIR: string = join(import.meta.dirname, '..', 'results');

export function writeResult(name: string, value: unknown): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Linear-interpolation percentile over a sample, for the timing tables. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = samples.toSorted((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const low = sorted[lo] ?? Number.NaN;
  const high = sorted[hi] ?? low;
  return low + (high - low) * (rank - lo);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
