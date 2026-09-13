/**
 * The metrics registry (11-operations-and-deployment.md, "Metrics"; ARCH-15).
 *
 * Every name is prefixed `iridium_`, base units are seconds and bytes, counters end in `_total`, and
 * **no label is ever an id**: `route` is the Fastify route *template*, never the concrete path, so a
 * note id can never become a time series. `metrics.labels.test` asserts that, which is only
 * satisfiable if there is one place labels are chosen — this one.
 *
 * M0 exposes the catalogue's boot and HTTP rows (12-milestones.md section 4.3):
 * `iridium_build_info`, `iridium_boot_timestamp_seconds`, `iridium_http_requests_total`,
 * `iridium_http_duration_seconds`, plus the readiness and migration gauges the fail-closed contract
 * needs while a deployment is stuck — `/metrics` deliberately keeps answering while migrations are
 * pending, and a monitoring system that goes blind at that moment is the worse outcome. The rest of
 * the catalogue is registered by the plugins that own the numbers, as those milestones land.
 */
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type MetricObjectWithValues,
  type MetricValue,
} from '@prometheus-io/client';

import { BUILD_INFO } from './build-info.ts';
import { READYZ_CHECK_NAMES, type ReadyzBody, type ReadyzStatus } from './readiness.ts';

/** Latency buckets of 11-operations-and-deployment.md, "Metrics". */
export const HTTP_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

const READYZ_STATUS_VALUE: Readonly<Record<ReadyzStatus, number>> = Object.freeze({
  ok: 1,
  warn: 0.5,
  fail: 0,
});

const MS_PER_SECOND = 1000;

/** The metric set this process publishes. One object so nothing reaches for a module global. */
export interface Metrics {
  readonly registry: Registry;
  readonly httpRequestsTotal: Counter<'route' | 'method' | 'status'>;
  readonly httpDurationSeconds: Histogram<'route' | 'method' | 'status'>;
  readonly buildInfo: Gauge<'version' | 'commit' | 'node'>;
  readonly bootTimestampSeconds: Gauge;
  readonly migrationsPending: Gauge;
  readonly readyzCheckStatus: Gauge<'check'>;
  readonly keyVersion: Gauge<'kind'>;
  /** Records one response. The route template is the label; the concrete path never is. */
  observeResponse(route: string, method: string, status: number, durationMs: number): void;
  /** Mirrors a `/readyz` evaluation onto the gauges a dashboard reads while a deploy is stuck. */
  observeReadiness(body: ReadyzBody, pendingMigrations: number): void;
  /** The exposition text, for `GET /metrics`. */
  render(): Promise<string>;
  /** Parsed values, for assertions in `metrics.integration`. */
  snapshot(): Promise<readonly MetricObjectWithValues<MetricValue<string>>[]>;
}

/** Builds the registry. Called once, by the ops plugin. */
export function createMetrics(bootTimestampMs: number): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: 'iridium_http_requests_total',
    help: 'HTTP responses, by route template, method and status.',
    labelNames: ['route', 'method', 'status'] as const,
    registers: [registry],
  });

  const httpDurationSeconds = new Histogram({
    name: 'iridium_http_duration_seconds',
    help: 'HTTP response latency in seconds, by route template, method and status.',
    labelNames: ['route', 'method', 'status'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });

  const buildInfo = new Gauge({
    name: 'iridium_build_info',
    help: 'The running build: always 1, identified entirely by its labels.',
    labelNames: ['version', 'commit', 'node'] as const,
    registers: [registry],
  });
  buildInfo.set(
    { version: BUILD_INFO.version, commit: BUILD_INFO.commit, node: BUILD_INFO.node },
    1,
  );

  const bootTimestampSeconds = new Gauge({
    name: 'iridium_boot_timestamp_seconds',
    help: 'Unix time at which this process finished booting.',
    registers: [registry],
  });
  bootTimestampSeconds.set(bootTimestampMs / MS_PER_SECOND);

  const migrationsPending = new Gauge({
    name: 'iridium_migrations_pending',
    help: 'Migrations the binary knows that are not recorded in kysely_migration.',
    registers: [registry],
  });

  const readyzCheckStatus = new Gauge({
    name: 'iridium_readyz_check_status',
    help: 'Per readiness check: 1 ok, 0.5 warn, 0 fail.',
    labelNames: ['check'] as const,
    registers: [registry],
  });
  // Published for every name from boot, so a dashboard row and an alert selector exist before the
  // first evaluation rather than appearing the first time a check happens to run.
  for (const check of READYZ_CHECK_NAMES) readyzCheckStatus.set({ check }, 0);

  const keyVersion = new Gauge({
    name: 'iridium_key_version',
    help: 'The key version currently used for new writes, per key kind. Never the material.',
    labelNames: ['kind'] as const,
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    httpDurationSeconds,
    buildInfo,
    bootTimestampSeconds,
    migrationsPending,
    readyzCheckStatus,
    keyVersion,
    observeResponse(route, method, status, durationMs) {
      const labels = { route, method, status: String(status) };
      httpRequestsTotal.inc(labels, 1);
      httpDurationSeconds.observe(labels, durationMs / MS_PER_SECOND);
    },
    observeReadiness(body, pendingMigrations) {
      for (const check of body.checks) {
        readyzCheckStatus.set({ check: check.name }, READYZ_STATUS_VALUE[check.status]);
      }
      migrationsPending.set(pendingMigrations);
    },
    render: () => registry.metrics(),
    snapshot: () => registry.getMetricsAsJSON(),
  };
}
