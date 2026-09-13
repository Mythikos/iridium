// Shared helpers for the S13 argon2 calibration harness.
// This is the seed of `iridium doctor --argon2`: percentile math, option
// parsing and JSON summarizing that the real doctor subcommand will reuse.

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function summarize(samplesMs) {
  const sorted = samplesMs.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

export function readArgon2Options(env = process.env) {
  const memoryCost = Number(env.ARGON2_MEMORY_KIB ?? 65536);
  const timeCost = Number(env.ARGON2_TIME_COST ?? 3);
  const parallelism = Number(env.ARGON2_PARALLELISM ?? 1);
  const outputLen = Number(env.ARGON2_HASH_LENGTH ?? 32);
  const pepper = env.ARGON2_PEPPER ?? 's13-scratch-pepper-do-not-use-in-prod';
  return {
    memoryCost,
    timeCost,
    parallelism,
    outputLen,
    secret: Buffer.from(pepper, 'utf8'),
  };
}

export function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
