/** Stable provenance and raw samples for the plan's server micro-budgets. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { arch, availableParallelism, platform } from 'node:os';
import { join, resolve } from 'node:path';

export function recordPerformance(
  metric: string,
  samples: readonly number[],
  details: Readonly<Record<string, unknown>>,
): number {
  if (samples.length === 0) throw new Error('A performance result must contain measured samples.');
  const ordered = samples.toSorted((left, right) => left - right);
  const p95 = ordered[Math.ceil(samples.length * 0.95) - 1];
  if (p95 === undefined) throw new Error('The nearest-rank percentile needs a sample.');
  const root = resolve(import.meta.dirname, '../../../../');
  const directory = join(root, 'reports/perf');
  mkdirSync(directory, { recursive: true });
  const record = {
    metric,
    value: p95,
    unit: 'milliseconds',
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runnerClass: `${platform()}/${arch()}/${String(availableParallelism())}-cpu-affinity`,
    date: new Date().toISOString(),
    node: process.version,
    mysqlImage: process.env['IRIDIUM_MYSQL_IMAGE'] ?? 'mysql:8.4.11',
    percentile: 'nearest rank ceil(0.95 * samples)',
    samples,
    ...details,
  };
  appendFileSync(
    join(directory, `${metric}-${String(process.pid)}.jsonl`),
    JSON.stringify(record) + '\n',
  );
  console.info(JSON.stringify({ metric, p95Ms: p95, samples: samples.length, ...details }));
  return p95;
}
