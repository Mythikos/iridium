/**
 * `startServer({ limits: … })` — the only knobs a suite may turn
 * (10-testing-and-quality.md, `StartServerOptions`: *"only the knobs `@iridium/contracts/limits`
 * exposes as env"*).
 *
 * The rule exists because of invariant 6: every numeric limit lives once, in
 * `packages/contracts/src/limits.ts`, and the only legitimate way to change one for a test is the
 * environment key an operator would use. A suite that needed a limit this table does not carry has
 * found a limit the product does not let an operator tune, which is a finding rather than a reason to
 * reach past the table.
 *
 * It is what makes the two budget suites affordable and honest at once: `collab.limits.integration`
 * and `collab.admission-budget.integration` refuse the 2001st document *"with the budget overridden
 * to 8 via `startServer({limits: {maxLoadedDocs: 8}})` rather than by opening 2 001 documents — the
 * production default of 2 000 is asserted only as a config-parsing case in `config.env.unit`."*
 *
 * Names are the server configuration's own (`config.collab.maxLoadedDocs` and its siblings), so a
 * reader of a test and a reader of `apps/server/src/config/env.ts` see the same word;
 * `testkit.limits-overrides.unit` holds this table's coverage equal to `LIMIT_ENV_OVERRIDES`, so a
 * limit that becomes tunable and is not added here fails there.
 */

import { LIMIT_ENV_OVERRIDES, type LimitEnvKey } from '@iridium/contracts';

/**
 * The name of one override. Written out rather than inferred from the table below because
 * `isolatedDeclarations` needs an explicit type on the table, and spelling the union here makes a
 * missing table entry a compile error rather than a silently absent knob.
 */
export type LimitOverrideName =
  | 'maxUploadBytes'
  | 'maxImportBytes'
  | 'debounceMs'
  | 'maxDebounceMs'
  | 'maxLoadedDocs'
  | 'maxStateBytesTotal'
  | 'maxConnections'
  | 'maxConnectionsPerUser'
  | 'maxConnectionsPerIp'
  | 'mcpRateLimitPerHour'
  | 'projectionTimeoutMs'
  | 'updateLogRetentionDays'
  | 'shutdownDrainMs';

/**
 * The overrides a suite may pass, and the `@iridium/contracts` environment key each one sets. The
 * value passed is a number, or the byte string an operator would write (`'2MiB'`), because
 * `EnvSchema`'s byte fields accept both.
 *
 * Name and key are two vocabularies on purpose: the names are the server configuration's own
 * (`config.collab.maxLoadedDocs` and its siblings), so a reader of a test and a reader of
 * `apps/server/src/config/env.ts` see the same word.
 */
export const LIMIT_OVERRIDE_ENV: Readonly<Record<LimitOverrideName, LimitEnvKey>> = Object.freeze({
  maxUploadBytes: 'MAX_UPLOAD_BYTES',
  maxImportBytes: 'MAX_IMPORT_BYTES',
  debounceMs: 'COLLAB_DEBOUNCE_MS',
  maxDebounceMs: 'COLLAB_MAX_DEBOUNCE_MS',
  maxLoadedDocs: 'COLLAB_MAX_LOADED_DOCS',
  maxStateBytesTotal: 'COLLAB_MAX_STATE_BYTES_TOTAL',
  maxConnections: 'COLLAB_MAX_CONNECTIONS_PER_PROCESS',
  maxConnectionsPerUser: 'COLLAB_MAX_CONNECTIONS_PER_USER',
  maxConnectionsPerIp: 'COLLAB_MAX_CONNECTIONS_PER_IP',
  mcpRateLimitPerHour: 'MCP_RATE_LIMIT_PER_HOUR',
  projectionTimeoutMs: 'PROJECTION_TIMEOUT_MS',
  updateLogRetentionDays: 'UPDATE_LOG_RETENTION_DAYS',
  shutdownDrainMs: 'SHUTDOWN_DRAIN_MS',
});

/**
 * What `startServer({ limits })` accepts.
 *
 * An explicit `undefined` is legal and means "leave this one alone", so a suite can build the object
 * from values it may or may not have without a conditional spread at every call site.
 */
export type LimitsOverrides = Partial<Record<LimitOverrideName, number | string | undefined>>;

/**
 * Every limit `@iridium/contracts` declares as environment-overridable, sorted.
 * `testkit.limits-overrides.unit` compares it with this module's own coverage.
 */
export const LIMIT_ENV_OVERRIDE_KEYS: readonly string[] = Object.freeze(
  Object.keys(LIMIT_ENV_OVERRIDES).toSorted(),
);

/**
 * The collaboration overrides `buildApp({ limits })` takes directly, as
 * `apps/server/src/collab/limits.ts` declares them (`seams/collab-server.md` §2): numbers only.
 *
 * `in-process` is the only mode that can use them, and it is the mode that needs them: the
 * environment is per **process**, so two servers booted in one Vitest worker would otherwise share
 * whatever the first one set, while `buildApp({ limits })` is per **boot**.
 */
export interface BuildAppLimits {
  readonly maxLoadedDocs?: number;
  readonly maxStateBytesTotal?: number;
  readonly maxConnectionsPerUser?: number;
  readonly maxConnectionsPerIp?: number;
  readonly maxConnections?: number;
  readonly compactionAwaitTimeoutMs?: number;
}

/** A value `CollabLimitOverrides` can take, or `undefined` for one the environment must carry. */
function asNumber(value: number | string | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * The `buildApp({ limits })` object for one boot, or `undefined` when nothing collaboration-shaped
 * was overridden.
 *
 * A byte **string** (`'2MiB'`) is deliberately left out: `CollabLimitOverrides` takes numbers, and
 * `EnvSchema` owns the parser that turns `'2MiB'` into one — so a string reaches the same knob
 * through the environment instead of through a second parser here.
 */
export function collabBootLimits(
  limits: LimitsOverrides = {},
  collab: { readonly compactionAwaitTimeoutMs?: number } = {},
): BuildAppLimits | undefined {
  const maxLoadedDocs = asNumber(limits.maxLoadedDocs);
  const maxStateBytesTotal = asNumber(limits.maxStateBytesTotal);
  const maxConnectionsPerUser = asNumber(limits.maxConnectionsPerUser);
  const maxConnections = asNumber(limits.maxConnections);
  const maxConnectionsPerIp = asNumber(limits.maxConnectionsPerIp);
  const { compactionAwaitTimeoutMs } = collab;

  const overrides: BuildAppLimits = {
    ...(maxLoadedDocs === undefined ? {} : { maxLoadedDocs }),
    ...(maxStateBytesTotal === undefined ? {} : { maxStateBytesTotal }),
    ...(maxConnectionsPerUser === undefined ? {} : { maxConnectionsPerUser }),
    ...(maxConnections === undefined ? {} : { maxConnections }),
    ...(maxConnectionsPerIp === undefined ? {} : { maxConnectionsPerIp }),
    ...(compactionAwaitTimeoutMs === undefined ? {} : { compactionAwaitTimeoutMs }),
  };
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

/** Every environment key this module can set, so a boot can clear the ones it does not set. */
export const LIMIT_OVERRIDE_ENV_KEYS: readonly string[] = Object.freeze(
  Object.values(LIMIT_OVERRIDE_ENV),
);

/** Name → environment key, for a lookup that needs no assertion over an index signature. */
const ENV_BY_NAME: ReadonlyMap<string, LimitEnvKey> = new Map(Object.entries(LIMIT_OVERRIDE_ENV));

/** Render the overrides as the environment the product parses. Unknown names are a caller bug. */
export function limitsEnv(overrides: LimitsOverrides): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const envKey = ENV_BY_NAME.get(name);
    if (envKey === undefined) {
      throw new Error(
        `@iridium/testkit: "${name}" is not an overridable limit. The overridable set is ${Object.keys(LIMIT_OVERRIDE_ENV).join(', ')} (LIMIT_ENV_OVERRIDES in @iridium/contracts). A limit that is not there is not one an operator can tune, and a test may not reach past that.`,
      );
    }
    env[envKey] = String(value);
  }
  return env;
}
