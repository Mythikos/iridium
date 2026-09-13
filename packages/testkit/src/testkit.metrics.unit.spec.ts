import { describe, expect, it } from 'vitest';

import { metricTotal, parseMetricSamples, parseMetrics } from './server/metrics.ts';

/** A fragment in the shape `apps/server/src/ops` exposes (02-system-architecture.md, boot step 11). */
const EXPOSITION = [
  '# HELP iridium_http_requests_total Total HTTP requests',
  '# TYPE iridium_http_requests_total counter',
  'iridium_http_requests_total{method="GET",route="/readyz",status="200"} 12',
  'iridium_http_requests_total{route="/api/v1/vaults",method="GET",status="200"} 3',
  '# HELP iridium_http_duration_seconds Request duration',
  '# TYPE iridium_http_duration_seconds histogram',
  'iridium_http_duration_seconds_bucket{le="0.05"} 9',
  'iridium_http_duration_seconds_bucket{le="+Inf"} 15',
  'iridium_boot_timestamp 1.7893e+09',
  'compaction_failures_total 0',
  'projection_timeouts_total 0',
  'iridium_build_info{version="0.0.0",node="24.21.0",commit="abcdef0"} 1',
  '',
].join('\n');

describe('testkit.metrics.unit [area:testkit]', () => {
  it('keys a labelled series by its sorted labels, so two orderings are one key', () => {
    const snapshot = parseMetrics(EXPOSITION);
    expect(snapshot['iridium_http_requests_total{method="GET",route="/readyz",status="200"}']).toBe(
      12,
    );
    expect(
      snapshot['iridium_http_requests_total{method="GET",route="/api/v1/vaults",status="200"}'],
    ).toBe(3);
  });

  it('keys an unlabelled series by its bare name', () => {
    const snapshot = parseMetrics(EXPOSITION);
    expect(snapshot['compaction_failures_total']).toBe(0);
    expect(snapshot['projection_timeouts_total']).toBe(0);
  });

  it('skips comments and blank lines', () => {
    const samples = parseMetricSamples(EXPOSITION);
    expect(samples.every((s) => !s.name.startsWith('#'))).toBe(true);
    expect(samples).toHaveLength(8);
  });

  it('reads exponential notation and +Inf buckets', () => {
    const snapshot = parseMetrics(EXPOSITION);
    expect(snapshot['iridium_boot_timestamp']).toBe(1_789_300_000);
    expect(snapshot['iridium_http_duration_seconds_bucket{le="+Inf"}']).toBe(15);
  });

  it('sums every series of a name, which is what "did this counter move" needs', () => {
    expect(metricTotal(EXPOSITION, 'iridium_http_requests_total')).toBe(15);
    expect(metricTotal(EXPOSITION, 'compaction_failures_total')).toBe(0);
    expect(metricTotal(EXPOSITION, 'never_exported_total')).toBe(0);
  });

  it('keeps label values intact, including a build info line', () => {
    const sample = parseMetricSamples(EXPOSITION).find((s) => s.name === 'iridium_build_info');
    expect(sample?.labels).toStrictEqual({
      version: '0.0.0',
      node: '24.21.0',
      commit: 'abcdef0',
    });
    expect(sample?.value).toBe(1);
  });

  it('tolerates a trailing timestamp on a sample line', () => {
    expect(parseMetrics('a_total 4 1789300000')['a_total']).toBe(4);
  });
});
