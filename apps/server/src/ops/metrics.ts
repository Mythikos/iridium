/**
 * The metrics registry (11-operations-and-deployment.md, "Metrics"; ARCH-15).
 *
 * Every name is prefixed `iridium_`, base units are seconds and bytes, counters end in `_total`, and
 * **no label is ever an id**: `route` is the Fastify route *template*, never the concrete path, so a
 * note id can never become a time series. `metrics.labels.test` asserts that, which is only
 * satisfiable if there is one place labels are chosen — this one.
 *
 * M0 exposed the catalogue's boot and HTTP rows (12-milestones.md section 4.3):
 * `iridium_build_info`, `iridium_boot_timestamp_seconds`, `iridium_http_requests_total`,
 * `iridium_http_duration_seconds`, plus the readiness and migration gauges the fail-closed contract
 * needs while a deployment is stuck — `/metrics` deliberately keeps answering while migrations are
 * pending, and a monitoring system that goes blind at that moment is the worse outcome.
 *
 * M1 adds the durability, collaboration, admission and login rows of 12-milestones.md section 5.2's
 * `ops` row. **They are declared here and published from boot even though the subsystems that move
 * them arrive in wave 2**, for the same reason `iridium_readyz_check_status` publishes every check
 * name before the first evaluation: a dashboard row and an alert selector that appear only after the
 * first event are missing exactly when they are first needed. The `collab`, `persistence` and `auth`
 * modules take these objects off `app.metrics` and set them; nothing outside this module chooses a
 * metric name, a label name or a bucket boundary.
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

/**
 * `iridium_persist_latency_seconds` buckets: enqueue to COMMIT per writer batch (11, "Metrics").
 *
 * One bucket short of the HTTP ladder, deliberately: a persistence batch that takes ten seconds is not
 * a latency observation, it is the `persist_backlog` readiness check failing.
 */
export const PERSIST_LATENCY_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
]);

/**
 * `iridium_note_state_bytes` buckets: the V2 snapshot size at compaction (11, "Metrics").
 *
 * 16 KiB to 64 MiB by powers of four, chosen so both the 8 MB alert (`SNAPSHOT_ALERT_BYTES`) and the
 * 64 MB refusal (`SNAPSHOT_REFUSE_BYTES`) fall on a boundary and read as a step in the histogram rather
 * than disappearing inside one wide bucket.
 */
export const NOTE_STATE_BYTES_BUCKETS: readonly number[] = Object.freeze([
  16_384, 65_536, 262_144, 1_048_576, 4_194_304, 8_388_608, 16_777_216, 67_108_864,
]);

/** `iridium_persist_failures_total` reasons (11, "Metrics"). A closed label set, never a free string. */
export const PERSIST_FAILURE_REASONS = [
  'db_unavailable',
  'db_error',
  'note_trashed',
  'too_large',
  'backpressure',
  'content_invalid',
  'cas_mismatch',
] as const;

/** `iridium_login_failures_total` reasons (11, "Metrics"). */
export const LOGIN_FAILURE_REASONS = [
  'unknown_user',
  'bad_password',
  'disabled',
  'throttled',
] as const;

/**
 * `iridium_token_auth_failures_total` reasons (11, "Metrics"): every `401` a bearer token earns,
 * at either MCP mount or a starred REST read. `wrong_kind_for_route` and `audience_mismatch` are
 * the two that mean "a working credential was pointed at the wrong URL".
 */
export const TOKEN_AUTH_FAILURE_REASONS = [
  'bad_format',
  'unknown',
  'revoked',
  'expired',
  'wrong_kind_for_route',
  'audience_mismatch',
  'consent_revoked',
  'client_disabled',
  'user_disabled',
] as const;

/** One `iridium_token_auth_failures_total{reason}` value. */
export type TokenAuthFailureReason = (typeof TOKEN_AUTH_FAILURE_REASONS)[number];

/** The pools `iridium_db_pool_*{pool}` describes (11, "Metrics": `app`, `persist`, `maint`). */
export const DB_POOL_LABELS = ['app', 'persist', 'maint'] as const;

/** `iridium_ws_connections{doc_kind}` values: one per open note, one per open vault channel. */
export const DOC_KINDS = ['note', 'vault'] as const;

/** `iridium_collab_messages_total{type}` values: frame volume by type, plus the one dropped kind. */
export const COLLAB_MESSAGE_TYPES = [
  'sync',
  'awareness',
  'awareness_dropped',
  'stateless',
  'auth',
  'query_awareness',
  'other',
] as const;

/** One `iridium_collab_messages_total{type}` value. */
export type CollabMessageType = (typeof COLLAB_MESSAGE_TYPES)[number];

/** `iridium_collab_hook_errors_total{hook}` values: the twelve Hocuspocus hooks Iridium registers. */
export const COLLAB_HOOK_NAMES = [
  'onAuthenticate',
  'onTokenSync',
  'onLoadDocument',
  'afterLoadDocument',
  'beforeHandleMessage',
  'beforeHandleAwareness',
  'onStateless',
  'onStoreDocument',
  'beforeUnloadDocument',
  'afterUnloadDocument',
  'connected',
  'onDisconnect',
] as const;

/** One `iridium_collab_hook_errors_total{hook}` value, and the name a hook is registered under. */
export type CollabHookName = (typeof COLLAB_HOOK_NAMES)[number];

/** `iridium_content_invalid_total{reason}` values: what the compaction scan found (A22). */
export const CONTENT_INVALID_REASONS = ['cr', 'attributes'] as const;

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

  // ---- collaboration and admission (11, "Metrics"; skeleton A50) --------------------------------
  /** Live `/collab` document connections, by document kind. */
  readonly wsConnections: Gauge<'doc_kind'>;
  /** `hocuspocus.documents.size`. */
  readonly docsLoaded: Gauge;
  /** `COLLAB_MAX_LOADED_DOCS`; the alert divides the two. */
  readonly docsLoadedMax: Gauge;
  /** Summed snapshot size of the loaded documents — the admission accounting of A50. */
  readonly collabStateBytes: Gauge;
  /** `COLLAB_MAX_STATE_BYTES_TOTAL`. */
  readonly collabStateBytesMax: Gauge;
  /** Document loads refused with close reason `capacity`, by which budget was full. */
  readonly collabAdmissionRefusedTotal: Counter<'reason'>;
  /** Inbound `/collab` frames by message type; `awareness_dropped` is the pre-dispatch cap. */
  readonly collabMessagesTotal: Counter<'type'>;
  /** Errors `safeHook` contained in a Hocuspocus hook body (D14-09); should stay at zero. */
  readonly collabHookErrorsTotal: Counter<'hook'>;

  // ---- durability (11, "Metrics"; A19, D05-04) ---------------------------------------------------
  /** Enqueue to COMMIT, per writer batch. */
  readonly persistLatencySeconds: Histogram;
  /** Every `persist-failed` broadcast, plus the `cas_mismatch` corruption alarm. */
  readonly persistFailuresTotal: Counter<'reason'>;
  /** Total queued updates across every `NoteWriter`. */
  readonly persistQueueDepth: Gauge;
  /** Age of the oldest un-committed update: the single best liveness signal for durability. */
  readonly persistBacklogAgeSeconds: Gauge;
  /** Writers in the `failed` state, which the `persist_backlog` readiness check reads. */
  readonly persistWritersFailed: Gauge;
  /** Compactions, by trigger and outcome. */
  readonly compactionsTotal: Counter<'trigger' | 'status'>;
  /** V2 snapshot size at compaction. */
  readonly noteStateBytes: Histogram;
  /** State vectors wider than `SV_STORED_MAX_BYTES`, stored zero length instead (D03-01). */
  readonly stateVectorOversizeTotal: Counter;
  /** Hostile-content detections at compaction, by reason (A22). */
  readonly contentInvalidTotal: Counter<'reason'>;
  /** Worker observations and committed-projection backlog. */
  readonly projectionDurationSeconds: Histogram<'status'>;
  readonly projectionTimeoutsTotal: Counter;
  readonly projectionLagSeconds: Gauge;
  /** Attachment observations use closed status labels and never attachment or vault ids. */
  readonly attachmentUploadsTotal: Counter<'status'>;
  readonly attachmentServedBytesTotal: Counter;
  readonly attachmentMissingTotal: Counter;
  readonly attachmentBytesTotal: Gauge;
  /** Persisted maintenance outcomes and health, with closed job-type labels. */
  readonly jobsTotal: Counter<'type' | 'status'>;
  readonly jobDurationSeconds: Histogram<'type'>;
  readonly jobLastSuccessTimestamp: Gauge<'type'>;
  readonly jobIntervalSeconds: Gauge<'type'>;

  // ---- authentication and pools -----------------------------------------------------------------
  /** Failed logins, by reason. Never an email address and never a user id. */
  readonly loginFailuresTotal: Counter<'reason'>;
  /** Refused bearer tokens, by reason. Never a token id. */
  readonly tokenAuthFailuresTotal: Counter<'reason'>;
  /** `AuthzBus` subscribers that threw (04 section 8.3): a silently failing revocation is visible. */
  readonly authzBusHandlerErrorsTotal: Counter;
  /** mysql2 pool introspection: connections checked out, per pool. */
  readonly dbPoolInUse: Gauge<'pool'>;
  /** The configured `connectionLimit`, per pool; the alert uses the ratio of the two. */
  readonly dbPoolSize: Gauge<'pool'>;

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
export function createMetrics(
  bootTimestampMs: number,
  observations: { readonly docsLoaded?: () => number } = {},
): Metrics {
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

  const wsConnections = new Gauge({
    name: 'iridium_ws_connections',
    help: 'Live /collab document connections, by document kind.',
    labelNames: ['doc_kind'] as const,
    registers: [registry],
  });
  for (const docKind of DOC_KINDS) wsConnections.set({ doc_kind: docKind }, 0);

  const docsLoaded = new Gauge({
    name: 'iridium_docs_loaded',
    help: 'Documents loaded in this process (hocuspocus.documents.size).',
    registers: [registry],
    collect() {
      // Hocuspocus publishes its map after afterLoadDocument. Read the authority at scrape time.
      if (observations.docsLoaded !== undefined) this.set(observations.docsLoaded());
    },
  });

  const docsLoadedMax = new Gauge({
    name: 'iridium_docs_loaded_max',
    help: 'The loaded-document admission budget (COLLAB_MAX_LOADED_DOCS).',
    registers: [registry],
  });

  const collabStateBytes = new Gauge({
    name: 'iridium_collab_state_bytes',
    help: 'Summed snapshot size of the loaded documents (the admission accounting of A50).',
    registers: [registry],
  });

  const collabStateBytesMax = new Gauge({
    name: 'iridium_collab_state_bytes_max',
    help: 'The loaded-state byte budget (COLLAB_MAX_STATE_BYTES_TOTAL).',
    registers: [registry],
  });

  const collabAdmissionRefusedTotal = new Counter({
    name: 'iridium_collab_admission_refused_total',
    help: 'Document loads refused with close reason capacity, by which budget was full.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const collabMessagesTotal = new Counter({
    name: 'iridium_collab_messages_total',
    help: 'Inbound /collab frames by message type; awareness_dropped is the pre-dispatch cap.',
    labelNames: ['type'] as const,
    registers: [registry],
  });
  for (const type of COLLAB_MESSAGE_TYPES) collabMessagesTotal.inc({ type }, 0);

  const collabHookErrorsTotal = new Counter({
    name: 'iridium_collab_hook_errors_total',
    help: 'Errors safeHook contained in a Hocuspocus hook body; should stay at zero.',
    labelNames: ['hook'] as const,
    registers: [registry],
  });
  for (const hook of COLLAB_HOOK_NAMES) collabHookErrorsTotal.inc({ hook }, 0);

  const persistLatencySeconds = new Histogram({
    name: 'iridium_persist_latency_seconds',
    help: 'Enqueue to COMMIT, per writer batch.',
    buckets: [...PERSIST_LATENCY_BUCKETS],
    registers: [registry],
  });

  const persistFailuresTotal = new Counter({
    name: 'iridium_persist_failures_total',
    help: 'Persistence failures by reason, including the cas_mismatch corruption alarm.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  // Published at zero for every reason, so an alert selector on `cas_mismatch` exists before the first
  // failure instead of appearing with it (11, "Metrics").
  for (const reason of PERSIST_FAILURE_REASONS) persistFailuresTotal.inc({ reason }, 0);

  const persistQueueDepth = new Gauge({
    name: 'iridium_persist_queue_depth',
    help: 'Total queued updates across every NoteWriter.',
    registers: [registry],
  });

  const persistBacklogAgeSeconds = new Gauge({
    name: 'iridium_persist_backlog_age_seconds',
    help: 'Age of the oldest un-committed update, in seconds.',
    registers: [registry],
  });

  const persistWritersFailed = new Gauge({
    name: 'iridium_persist_writers_failed',
    help: 'Writers in the failed state.',
    registers: [registry],
  });

  const compactionsTotal = new Counter({
    name: 'iridium_compactions_total',
    help: 'Compactions by trigger and outcome.',
    labelNames: ['trigger', 'status'] as const,
    registers: [registry],
  });

  const noteStateBytes = new Histogram({
    name: 'iridium_note_state_bytes',
    help: 'V2 snapshot size at compaction, in bytes.',
    buckets: [...NOTE_STATE_BYTES_BUCKETS],
    registers: [registry],
  });

  const stateVectorOversizeTotal = new Counter({
    name: 'iridium_state_vector_oversize_total',
    help: 'State vectors wider than SV_STORED_MAX_BYTES, stored zero length instead (D03-01).',
    registers: [registry],
  });

  const contentInvalidTotal = new Counter({
    name: 'iridium_content_invalid_total',
    help: 'Hostile-content detections at compaction, by reason.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  for (const reason of CONTENT_INVALID_REASONS) contentInvalidTotal.inc({ reason }, 0);

  const projectionDurationSeconds = new Histogram({
    name: 'iridium_projection_duration_seconds',
    help: 'Projection worker duration by outcome.',
    labelNames: ['status'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });
  const projectionTimeoutsTotal = new Counter({
    name: 'iridium_projection_timeouts_total',
    help: 'Projection workers terminated at their deadline.',
    registers: [registry],
  });
  const projectionLagSeconds = new Gauge({
    name: 'iridium_projection_lag_seconds',
    help: 'Age of the oldest committed head awaiting projection.',
    registers: [registry],
  });
  const attachmentUploadsTotal = new Counter({
    name: 'iridium_attachment_uploads_total',
    help: 'Attachment uploads by outcome.',
    labelNames: ['status'] as const,
    registers: [registry],
  });
  for (const status of ['created', 'deduplicated', 'rejected'])
    attachmentUploadsTotal.inc({ status }, 0);
  const attachmentServedBytesTotal = new Counter({
    name: 'iridium_attachment_served_bytes_total',
    help: 'Attachment bytes served by successful responses.',
    registers: [registry],
  });
  const attachmentMissingTotal = new Counter({
    name: 'iridium_attachment_missing_total',
    help: 'Reads whose persisted attachment bytes were missing.',
    registers: [registry],
  });
  const attachmentBytesTotal = new Gauge({
    name: 'iridium_attachment_bytes_total',
    help: 'Total bytes referenced by retained attachment metadata.',
    registers: [registry],
  });

  const jobsTotal = new Counter({
    name: 'iridium_jobs_total',
    help: 'Persisted job attempts by type and outcome.',
    labelNames: ['type', 'status'] as const,
    registers: [registry],
  });
  const jobDurationSeconds = new Histogram({
    name: 'iridium_job_duration_seconds',
    help: 'Maintenance job duration by type.',
    labelNames: ['type'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });
  const jobLastSuccessTimestamp = new Gauge({
    name: 'iridium_job_last_success_timestamp',
    help: 'Unix time of the latest completed job by type.',
    labelNames: ['type'] as const,
    registers: [registry],
  });
  const jobIntervalSeconds = new Gauge({
    name: 'iridium_job_interval_seconds',
    help: 'Configured maintenance cadence by type.',
    labelNames: ['type'] as const,
    registers: [registry],
  });

  const loginFailuresTotal = new Counter({
    name: 'iridium_login_failures_total',
    help: 'Failed logins by reason. Never an email address and never a user id.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  for (const reason of LOGIN_FAILURE_REASONS) loginFailuresTotal.inc({ reason }, 0);

  const tokenAuthFailuresTotal = new Counter({
    name: 'iridium_token_auth_failures_total',
    help: 'Refused bearer tokens by reason. Never a token id.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  for (const reason of TOKEN_AUTH_FAILURE_REASONS) tokenAuthFailuresTotal.inc({ reason }, 0);

  const authzBusHandlerErrorsTotal = new Counter({
    name: 'iridium_authz_bus_handler_errors_total',
    help: 'AuthzBus subscribers that threw; each is isolated and logged, none fails its request.',
    registers: [registry],
  });

  const dbPoolInUse = new Gauge({
    name: 'iridium_db_pool_in_use',
    help: 'Connections checked out of each mysql2 pool.',
    labelNames: ['pool'] as const,
    registers: [registry],
  });

  const dbPoolSize = new Gauge({
    name: 'iridium_db_pool_size',
    help: 'The configured connectionLimit of each mysql2 pool.',
    labelNames: ['pool'] as const,
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
    wsConnections,
    docsLoaded,
    docsLoadedMax,
    collabStateBytes,
    collabStateBytesMax,
    collabAdmissionRefusedTotal,
    collabMessagesTotal,
    collabHookErrorsTotal,
    persistLatencySeconds,
    persistFailuresTotal,
    persistQueueDepth,
    persistBacklogAgeSeconds,
    persistWritersFailed,
    compactionsTotal,
    noteStateBytes,
    stateVectorOversizeTotal,
    contentInvalidTotal,
    projectionDurationSeconds,
    projectionTimeoutsTotal,
    projectionLagSeconds,
    attachmentUploadsTotal,
    attachmentServedBytesTotal,
    attachmentMissingTotal,
    attachmentBytesTotal,
    jobsTotal,
    jobDurationSeconds,
    jobLastSuccessTimestamp,
    jobIntervalSeconds,
    loginFailuresTotal,
    tokenAuthFailuresTotal,
    authzBusHandlerErrorsTotal,
    dbPoolInUse,
    dbPoolSize,
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
