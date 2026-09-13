/**
 * `EnvSchema`, `loadConfig()` and `redactConfig()` — the whole runtime configuration model
 * (02-system-architecture.md, "Runtime configuration model"; 11-operations-and-deployment.md,
 * "Configuration and secrets").
 *
 * Six properties this module owns, each a decision rather than an implementation detail:
 *
 * 1. **Environment only, parsed once.** There is no configuration file. `process.env` is read
 *    exactly once (through `config/process-env.ts`), validated by one zod object, and frozen into
 *    `IridiumConfig`. A failure prints `z.prettifyError(error)` and exits `2` before a pool opens
 *    or a socket listens (ARCH-08).
 * 2. **`<NAME>_FILE` twins.** Every secret accepts one; setting both forms is an error, never a
 *    precedence question (`config/secrets.ts`).
 * 3. **Keyrings, not versions.** `<NAME>_V<n>` families load in full; the version in use lives in
 *    `schema_meta` and never in the environment (ARCH-09).
 * 4. **Unknown `IRIDIUM_*` keys are fatal, with reserved harness namespaces.** A typo in the most
 *    sensitive knobs exits `2`; the harness prefixes of ARCH-25 are known-and-ignored, because the
 *    `child` mode spawns this binary with a whole CI job's environment.
 * 5. **Env values are floors of strictness.** Nothing here computes an effective policy; the
 *    `SettingsStore` does that with `tighten(envFloor, adminValue)` (ARCH-10).
 * 6. **One redacted rendering.** `redactConfig()` produces the ARCH-28 form the `config.loaded` log
 *    line, `iridium config check` and every runbook print. A bare `***` is not an accepted
 *    rendering, because the fingerprint is the control an operator compares across hosts.
 *
 * Where 02-system-architecture.md and 11-operations-and-deployment.md spell a key differently, the
 * 11 spelling is canonical (it owns the `EnvSchema` key table, and `@iridium/testkit` is written
 * against it) and the 02 spelling is an accepted alias — see `KEY_ALIASES`.
 */
import { getHeapStatistics } from 'node:v8';

import { LIMITS } from '@iridium/contracts';
import { z } from 'zod';

import { formatBytes, InvalidByteSizeError, parseBytes } from './bytes.ts';
import { defaultProjectionWorkers, resolveCpuCeiling, type CpuCeiling } from './cgroup-cpu.ts';
import { ConfigError } from './config-error.ts';
import { DEFAULT_BIND_ADDRESS, DEFAULT_PORT } from './defaults.ts';
import { processEnv, type RawEnv } from './process-env.ts';
import {
  collectKeyring,
  EMPTY_KEYRING,
  renderKeyring,
  renderSecret,
  resolveSecret,
  type Keyring,
  type ResolvedSecret,
  type SecretWarning,
} from './secrets.ts';

export { ConfigError } from './config-error.ts';
export type { Keyring } from './secrets.ts';
export type { RawEnv } from './process-env.ts';

const SECONDS_PER_MINUTE = 60;
const HEAP_PRESSURE_FRACTION = 0.9;
const UV_THREADPOOL_FLOOR = 8;
const KEY_MATERIAL_BYTES = 32;
const PORT_MAX = 65_535;
const PASSWORD_LENGTH_FLOOR = 8;
const PASSWORD_LENGTH_CEILING = 128;
const ZSTD_LEVEL_MIN = 1;
const ZSTD_LEVEL_MAX = 19;
const POOL_APP_FLOOR = 5;
const POOL_PERSIST_FLOOR = 2;
const DEFAULT_POOL_APP = 20;
const DEFAULT_POOL_PERSIST = 4;

// -----------------------------------------------------------------------------------------------
// Reserved, rejected and aliased names
// -----------------------------------------------------------------------------------------------

/**
 * Harness, fixture, client and bridge namespaces the `child` mode inherits from a CI job's
 * environment (ARCH-25, 10-testing-and-quality.md D10-5). Known-and-ignored rather than fatal, and
 * printed by `iridium config check` under "ignored harness keys". No product key uses a prefix from
 * this list, which is what keeps the carve-out from weakening typo protection.
 */
export const RESERVED_HARNESS_PREFIXES: readonly string[] = Object.freeze([
  'IRIDIUM_TEST_',
  'IRIDIUM_PROP_',
  'IRIDIUM_CHAOS_',
  'IRIDIUM_E2E_',
  'IRIDIUM_FIXTURE_',
  'IRIDIUM_COVERAGE_',
]);

/** The exact harness, fixture, client and bridge names of ARCH-25. */
export const RESERVED_HARNESS_KEYS: readonly string[] = Object.freeze([
  'IRIDIUM_MYSQL_IMAGE',
  'IRIDIUM_USER_DATA',
  'IRIDIUM_SERVER_URL',
  'IRIDIUM_MCP_TOKEN',
]);

/** `IRIDIUM_*` names the schema refuses by name, each with the reason an operator needs. */
export const REJECTED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  IRIDIUM_ALLOW_NO_ORIGIN_WS:
    'there is no bypass for the absent-Origin rule on /collab (skeleton A24): an upgrade without an Origin header is refused, deliberately and permanently',
  IRIDIUM_E2E:
    'IRIDIUM_E2E is read by the desktop main process only (it disables the updater and the single-instance lock); the server never reads it, so setting it here is a copied-configuration mistake',
});

/**
 * Spellings 02-system-architecture.md uses for keys 11-operations-and-deployment.md — the owner of
 * the `EnvSchema` key table — spells differently. Accepted, mapped to the canonical name and
 * reported as a warning: silently ignoring a name the plan itself prints would turn a documentation
 * divergence into a silent misconfiguration. Setting both spellings is an error.
 */
export const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  STEP_UP_WINDOW_MINUTES: 'STEP_UP_WINDOW_MIN',
  METRICS_ALLOW_CIDRS: 'METRICS_ALLOW_CIDR',
  TRASH_RETENTION_DAYS_DEFAULT: 'TRASH_RETENTION_DAYS',
  COLLAB_MAX_CONNECTIONS: 'COLLAB_MAX_CONNECTIONS_PER_PROCESS',
});

/** Secret keys that accept a `<NAME>_FILE` twin but are single values, not keyrings. */
export const SINGLE_SECRET_KEYS: readonly string[] = Object.freeze([
  'DATABASE_PASSWORD',
  'DATABASE_MIGRATE_PASSWORD',
  'DATABASE_BACKUP_PASSWORD',
  'METRICS_TOKEN',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
]);

/** The keyring families of ARCH-09. */
export const KEYRING_NAMES: readonly string[] = Object.freeze([
  'AUTH_PASSWORD_PEPPER',
  'AUDIT_HMAC_KEY',
  'MCP_CURSOR_KEY',
]);

/** Reserved and refused: envelope encryption is not implemented (G4, answered 2026-09-12). */
export const RESERVED_KEYRING_NAME = 'ATTACHMENT_KEY';

/** The obviously fake fixture secrets of 10-testing-and-quality.md rule 9, refused in production. */
const TEST_SECRET_MARKER = /not-a-secret/;

// -----------------------------------------------------------------------------------------------
// Field helpers
// -----------------------------------------------------------------------------------------------

const rawField = z.string().optional();

function fail(ctx: z.RefinementCtx, message: string): never {
  ctx.addIssue({ code: 'custom', message });
  return z.NEVER;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function intField(fallback: number, bounds: { min?: number; max?: number } = {}) {
  return rawField.transform((value, ctx) => {
    if (!present(value)) return fallback;
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed)) {
      return fail(ctx, `expected an integer, received ${JSON.stringify(value)}`);
    }
    if (bounds.min !== undefined && parsed < bounds.min) {
      return fail(ctx, `must be at least ${String(bounds.min)}, received ${String(parsed)}`);
    }
    if (bounds.max !== undefined && parsed > bounds.max) {
      return fail(ctx, `must be at most ${String(bounds.max)}, received ${String(parsed)}`);
    }
    return parsed;
  });
}

function boolField(fallback: boolean) {
  return rawField.transform((value, ctx) => {
    if (!present(value)) return fallback;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return fail(ctx, `expected true or false, received ${JSON.stringify(value)}`);
  });
}

function bytesField(fallback: number) {
  return rawField.transform((value, ctx) => {
    if (!present(value)) return fallback;
    try {
      return parseBytes(value);
    } catch (error) {
      if (error instanceof InvalidByteSizeError) return fail(ctx, error.message);
      throw error;
    }
  });
}

function listField() {
  return rawField.transform((value): readonly string[] =>
    present(value)
      ? Object.freeze(
          value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ''),
        )
      : Object.freeze<string[]>([]),
  );
}

function stringField(fallback: string) {
  return rawField.transform((value) => (present(value) ? value.trim() : fallback));
}

function optionalStringField() {
  return rawField.transform((value): string | null => (present(value) ? value.trim() : null));
}

function enumField<T extends string>(values: readonly T[], fallback: T) {
  return rawField.transform((value, ctx) => {
    if (!present(value)) return fallback;
    const normalized = value.trim();
    // `find` rather than `includes` plus an assertion: the match *is* the narrowed value, so nothing
    // has to be asserted into the union.
    const match = values.find((candidate) => candidate === normalized);
    return (
      match ?? fail(ctx, `expected one of ${values.join(', ')}, received ${JSON.stringify(value)}`)
    );
  });
}

function requiredOriginField() {
  return rawField.transform((value, ctx) => {
    if (!present(value)) return fail(ctx, 'is required');
    try {
      return new URL(value.trim());
    } catch {
      return fail(ctx, `is not a URL: ${JSON.stringify(value)}`);
    }
  });
}

function requiredStringField() {
  return rawField.transform((value, ctx) =>
    present(value) ? value.trim() : fail(ctx, 'is required'),
  );
}

// -----------------------------------------------------------------------------------------------
// The schema
// -----------------------------------------------------------------------------------------------

/** `NODE_ENV`. The image sets `production`; the harness sets `test`. */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
/** A `NODE_ENV` value. */
export type NodeEnvName = (typeof NODE_ENVS)[number];

/** The pino levels `LOG_LEVEL` accepts. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
/** A pino level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Two defaults are measured at boot rather than written down: the projection worker count (host
 * parallelism versus the cgroup quota) and the heap pressure threshold (90 % of V8's real ceiling,
 * so it tracks `--max-old-space-size` across sizing profiles instead of being right for one).
 */
export interface BootMeasurements {
  readonly defaultProjectionWorkers: number;
  readonly defaultPressureHeapBytes: number;
  readonly cpuCeiling: CpuCeiling;
}

function measure(): BootMeasurements {
  const cpuCeiling = resolveCpuCeiling();
  return {
    cpuCeiling,
    defaultProjectionWorkers: defaultProjectionWorkers(cpuCeiling),
    defaultPressureHeapBytes: Math.floor(
      getHeapStatistics().heap_size_limit * HEAP_PRESSURE_FRACTION,
    ),
  };
}

/**
 * Every documented environment key, with its type, bounds and default.
 *
 * Defaults that are also members of the single limits policy are read from `@iridium/contracts`
 * `LIMITS` rather than re-typed: an environment name is never a constant name (ARCH-16), and a
 * duplicated number is exactly what `limits.single-source.guard` exists to prevent.
 */
export function envShape(measurements: BootMeasurements) {
  return {
    // ---- Process and network ------------------------------------------------------------------
    NODE_ENV: enumField(NODE_ENVS, 'production'),
    BIND_ADDRESS: stringField(DEFAULT_BIND_ADDRESS),
    PORT: intField(DEFAULT_PORT, { min: 0, max: PORT_MAX }),
    PUBLIC_ORIGIN: requiredOriginField(),
    // Defaults to `PUBLIC_ORIGIN`'s host, which is right whenever the proxy forwards the public name.
    // It is a key of its own because the two can legitimately differ: a proxy that rewrites `Host` to
    // an internal name would otherwise trip the Host guard on every request, with no way out but
    // changing the public origin.
    PUBLIC_HOST: optionalStringField(),
    TRUST_PROXY: listField(),
    TLS_CERT_FILE: optionalStringField(),
    TLS_KEY_FILE: optionalStringField(),
    DEV_ORIGINS: listField(),
    SHUTDOWN_DRAIN_MS: intField(LIMITS.SHUTDOWN_DRAIN_MS, { min: 0 }),
    PRESSURE_MAX_HEAP_BYTES: bytesField(measurements.defaultPressureHeapBytes),
    PRESSURE_MAX_EVENT_LOOP_DELAY_MS: intField(1_000, { min: 0 }),

    // ---- Database -----------------------------------------------------------------------------
    DATABASE_URL: requiredStringField(),
    DATABASE_PASSWORD: optionalStringField(),
    DATABASE_MIGRATE_URL: optionalStringField(),
    DATABASE_MIGRATE_PASSWORD: optionalStringField(),
    DATABASE_BACKUP_URL: optionalStringField(),
    DATABASE_BACKUP_PASSWORD: optionalStringField(),
    DB_POOL_APP: intField(DEFAULT_POOL_APP, { min: POOL_APP_FLOOR }),
    DB_POOL_PERSIST: intField(DEFAULT_POOL_PERSIST, { min: POOL_PERSIST_FLOOR }),
    DB_CONNECT_TIMEOUT_MS: intField(10_000, { min: 1 }),
    IRIDIUM_MIGRATE_ON_BOOT: boolField(false),
    IRIDIUM_ALLOW_NEWER_SCHEMA: boolField(false),
    IRIDIUM_ALLOW_UNTESTED_MYSQL: boolField(false),
    READYZ_STRICT_DURABILITY: boolField(true),

    // ---- Metrics credentials and the reserved encryption switch -------------------------------
    METRICS_TOKEN: optionalStringField(),
    METRICS_ALLOW_CIDR: listField(),
    ATTACHMENTS_ENCRYPTION: enumField(['none', 'aes256gcm'] as const, 'none'),

    // ---- Authentication policy floors ---------------------------------------------------------
    ARGON2_MEMORY_KIB: intField(65_536, { min: 8_192 }),
    ARGON2_TIME_COST: intField(3, { min: 1 }),
    SESSION_WEB_IDLE_HOURS: intField(24, { min: 1 }),
    SESSION_WEB_ABSOLUTE_DAYS: intField(14, { min: 1 }),
    SESSION_DESKTOP_IDLE_DAYS: intField(30, { min: 1 }),
    SESSION_DESKTOP_ABSOLUTE_DAYS: intField(90, { min: 1 }),
    STEP_UP_WINDOW_MIN: intField(10, { min: 1 }),
    PASSWORD_MIN_LENGTH: intField(15, { min: PASSWORD_LENGTH_FLOOR, max: PASSWORD_LENGTH_CEILING }),
    LOGIN_THROTTLE_MAX_FAILURES: intField(LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE, { min: 1 }),
    LOGIN_THROTTLE_BLOCK_MIN: intField(LIMITS.LOGIN_BLOCK_BASE_SECONDS / SECONDS_PER_MINUTE, {
      min: 1,
    }),
    LOGIN_THROTTLE_IP_PER_DAY: intField(LIMITS.LOGIN_FAILURES_PER_IP_PER_DAY, { min: 1 }),

    // ---- Integration tokens, MCP and the authorization server ---------------------------------
    PAT_DEFAULT_LIFETIME_DAYS: intField(90, { min: 1 }),
    PAT_MAX_LIFETIME_DAYS: intField(366, { min: 1 }),
    PAT_ALLOW_NO_EXPIRY: boolField(false),
    PAT_ROTATION_OVERLAP_MAX_HOURS: intField(24, { min: 0 }),
    MCP_ENABLED: boolField(true),
    MCP_OAUTH_ENABLED: boolField(true),
    MCP_RATE_LIMIT_PER_HOUR: intField(LIMITS.MCP_TOKEN_PER_HOUR, { min: 1 }),
    MCP_RATE_LIMIT_BURST_PER_MIN: intField(LIMITS.MCP_TOKEN_BURST_PER_MINUTE, { min: 1 }),
    MCP_PROCESS_CEILING_PER_MIN: intField(LIMITS.MCP_PROCESS_PER_MINUTE, { min: 1 }),
    MCP_REQUEST_TIMEOUT_MS: intField(30_000, { min: 1 }),
    OAUTH_ACCESS_TOKEN_TTL_MINUTES: intField(60, { min: 1 }),
    OAUTH_REFRESH_IDLE_DAYS: intField(30, { min: 1 }),
    OAUTH_REFRESH_ABSOLUTE_DAYS: intField(90, { min: 1 }),
    OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR: intField(LIMITS.MCP_TOKEN_PER_HOUR, {
      min: LIMITS.PAT_RATE_LIMIT_PER_HOUR_MIN,
      max: LIMITS.PAT_RATE_LIMIT_PER_HOUR_MAX,
    }),
    OAUTH_ALLOW_DYNAMIC_CLIENT_REGISTRATION: boolField(true),
    OAUTH_ALLOW_CLIENT_ID_METADATA_DOCUMENTS: boolField(true),
    OAUTH_ALLOW_CONSENT_WITHOUT_STEP_UP: boolField(false),

    // ---- Collaboration and persistence --------------------------------------------------------
    COLLAB_DEBOUNCE_MS: intField(LIMITS.COMPACTION_DEBOUNCE_MS, { min: 0 }),
    COLLAB_MAX_DEBOUNCE_MS: intField(LIMITS.COMPACTION_MAX_DEBOUNCE_MS, { min: 0 }),
    COLLAB_MAX_LOADED_DOCS: intField(LIMITS.LOADED_DOCS_MAX, { min: 1 }),
    COLLAB_MAX_STATE_BYTES_TOTAL: bytesField(LIMITS.LOADED_STATE_BYTES_MAX),
    COLLAB_MAX_CONNECTIONS_PER_USER: intField(LIMITS.CONNECTIONS_PER_USER, { min: 1 }),
    COLLAB_MAX_CONNECTIONS_PER_IP: intField(LIMITS.CONNECTIONS_PER_IP, { min: 1 }),
    COLLAB_MAX_CONNECTIONS_PER_PROCESS: intField(LIMITS.CONNECTIONS_PER_PROCESS, { min: 1 }),
    COLLAB_TICKET_TTL_S: intField(LIMITS.TICKET_TTL_S, { min: 1 }),
    WS_MAX_PAYLOAD_BYTES: bytesField(LIMITS.WS_MAX_PAYLOAD_BYTES),
    UPDATE_LOG_RETENTION_DAYS: intField(LIMITS.UPDATE_LOG_RETENTION_DAYS, { min: 1 }),
    PROJECTION_WORKERS: intField(measurements.defaultProjectionWorkers, { min: 1 }),
    PROJECTION_TIMEOUT_MS: intField(LIMITS.PROJECTION_TIMEOUT_SERVER_MS, { min: 1 }),
    TRANSFER_WORKERS: intField(1, { min: 1 }),

    // ---- Storage and transfer -----------------------------------------------------------------
    ATTACHMENTS_DRIVER: enumField(['fs', 's3'] as const, 'fs'),
    ATTACHMENTS_DIR: stringField('/data/attachments'),
    S3_ENDPOINT: optionalStringField(),
    S3_REGION: stringField('us-east-1'),
    S3_BUCKET: optionalStringField(),
    S3_FORCE_PATH_STYLE: boolField(true),
    S3_ACCESS_KEY_ID: optionalStringField(),
    S3_SECRET_ACCESS_KEY: optionalStringField(),
    STAGING_DIR: stringField('/data/staging'),
    EXPORTS_DIR: stringField('/data/exports'),
    DESKTOP_UPDATES_DIR: stringField('/data/desktop-updates'),
    EXPORT_TTL_HOURS: intField(24, { min: 1 }),
    IMPORT_STAGING_TTL_HOURS: intField(72, { min: 1 }),
    MAX_UPLOAD_BYTES: bytesField(LIMITS.UPLOAD_MAX_BYTES),
    MAX_IMPORT_BYTES: bytesField(LIMITS.IMPORT_MAX_BYTES),
    IRIDIUM_WEB_DIR: optionalStringField(),

    // ---- Retention and jobs -------------------------------------------------------------------
    TRASH_RETENTION_DAYS: intField(30, { min: 1 }),
    AUDIT_RETENTION_DAYS: intField(400, { min: 1 }),
    AUDIT_ARCHIVE_EXPORT_DIR: stringField('/data/exports/audit-archive'),
    ACCESS_LOG_RETENTION_DAYS: intField(90, { min: 1 }),
    ACCESS_LOG_PARTITION_LEAD_MONTHS: intField(3, { min: 1 }),
    JOBS_ENABLED: boolField(true),

    // ---- Backup -------------------------------------------------------------------------------
    BACKUP_AGE_RECIPIENTS: listField(),
    BACKUP_ZSTD_LEVEL: intField(12, { min: ZSTD_LEVEL_MIN, max: ZSTD_LEVEL_MAX }),
    BACKUP_ZSTD_THREADS: intField(2, { min: 0 }),
    MYSQL_BINLOG_DIR: optionalStringField(),

    // ---- Observability ------------------------------------------------------------------------
    LOG_LEVEL: enumField(LOG_LEVELS, 'info'),
    LOG_FORMAT: enumField(['json', 'pretty'] as const, 'json'),
    METRICS_ENABLED: boolField(true),

    // ---- Lifecycle and test-only --------------------------------------------------------------
    IRIDIUM_FAULT: optionalStringField(),
  };
}

/**
 * Every key `EnvSchema` declares. Written out rather than derived so it reads as the key table it
 * is, and asserted equal to `Object.keys(envShape(…))` by `config.env.unit`; the CI job
 * `check-env-lists` diffs it against the Turborepo `envMode: strict` lists in both directions.
 */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.freeze([
  'NODE_ENV',
  'BIND_ADDRESS',
  'PORT',
  'PUBLIC_ORIGIN',
  'PUBLIC_HOST',
  'TRUST_PROXY',
  'TLS_CERT_FILE',
  'TLS_KEY_FILE',
  'DEV_ORIGINS',
  'SHUTDOWN_DRAIN_MS',
  'PRESSURE_MAX_HEAP_BYTES',
  'PRESSURE_MAX_EVENT_LOOP_DELAY_MS',
  'DATABASE_URL',
  'DATABASE_PASSWORD',
  'DATABASE_MIGRATE_URL',
  'DATABASE_MIGRATE_PASSWORD',
  'DATABASE_BACKUP_URL',
  'DATABASE_BACKUP_PASSWORD',
  'DB_POOL_APP',
  'DB_POOL_PERSIST',
  'DB_CONNECT_TIMEOUT_MS',
  'IRIDIUM_MIGRATE_ON_BOOT',
  'IRIDIUM_ALLOW_NEWER_SCHEMA',
  'IRIDIUM_ALLOW_UNTESTED_MYSQL',
  'READYZ_STRICT_DURABILITY',
  'METRICS_TOKEN',
  'METRICS_ALLOW_CIDR',
  'ATTACHMENTS_ENCRYPTION',
  'ARGON2_MEMORY_KIB',
  'ARGON2_TIME_COST',
  'SESSION_WEB_IDLE_HOURS',
  'SESSION_WEB_ABSOLUTE_DAYS',
  'SESSION_DESKTOP_IDLE_DAYS',
  'SESSION_DESKTOP_ABSOLUTE_DAYS',
  'STEP_UP_WINDOW_MIN',
  'PASSWORD_MIN_LENGTH',
  'LOGIN_THROTTLE_MAX_FAILURES',
  'LOGIN_THROTTLE_BLOCK_MIN',
  'LOGIN_THROTTLE_IP_PER_DAY',
  'PAT_DEFAULT_LIFETIME_DAYS',
  'PAT_MAX_LIFETIME_DAYS',
  'PAT_ALLOW_NO_EXPIRY',
  'PAT_ROTATION_OVERLAP_MAX_HOURS',
  'MCP_ENABLED',
  'MCP_OAUTH_ENABLED',
  'MCP_RATE_LIMIT_PER_HOUR',
  'MCP_RATE_LIMIT_BURST_PER_MIN',
  'MCP_PROCESS_CEILING_PER_MIN',
  'MCP_REQUEST_TIMEOUT_MS',
  'OAUTH_ACCESS_TOKEN_TTL_MINUTES',
  'OAUTH_REFRESH_IDLE_DAYS',
  'OAUTH_REFRESH_ABSOLUTE_DAYS',
  'OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR',
  'OAUTH_ALLOW_DYNAMIC_CLIENT_REGISTRATION',
  'OAUTH_ALLOW_CLIENT_ID_METADATA_DOCUMENTS',
  'OAUTH_ALLOW_CONSENT_WITHOUT_STEP_UP',
  'COLLAB_DEBOUNCE_MS',
  'COLLAB_MAX_DEBOUNCE_MS',
  'COLLAB_MAX_LOADED_DOCS',
  'COLLAB_MAX_STATE_BYTES_TOTAL',
  'COLLAB_MAX_CONNECTIONS_PER_USER',
  'COLLAB_MAX_CONNECTIONS_PER_IP',
  'COLLAB_MAX_CONNECTIONS_PER_PROCESS',
  'COLLAB_TICKET_TTL_S',
  'WS_MAX_PAYLOAD_BYTES',
  'UPDATE_LOG_RETENTION_DAYS',
  'PROJECTION_WORKERS',
  'PROJECTION_TIMEOUT_MS',
  'TRANSFER_WORKERS',
  'ATTACHMENTS_DRIVER',
  'ATTACHMENTS_DIR',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_FORCE_PATH_STYLE',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'STAGING_DIR',
  'EXPORTS_DIR',
  'DESKTOP_UPDATES_DIR',
  'EXPORT_TTL_HOURS',
  'IMPORT_STAGING_TTL_HOURS',
  'MAX_UPLOAD_BYTES',
  'MAX_IMPORT_BYTES',
  'IRIDIUM_WEB_DIR',
  'TRASH_RETENTION_DAYS',
  'AUDIT_RETENTION_DAYS',
  'AUDIT_ARCHIVE_EXPORT_DIR',
  'ACCESS_LOG_RETENTION_DAYS',
  'ACCESS_LOG_PARTITION_LEAD_MONTHS',
  'JOBS_ENABLED',
  'BACKUP_AGE_RECIPIENTS',
  'BACKUP_ZSTD_LEVEL',
  'BACKUP_ZSTD_THREADS',
  'MYSQL_BINLOG_DIR',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'METRICS_ENABLED',
  'IRIDIUM_FAULT',
]);

/** `EnvSchema` for the measurements this boot observed. */
export function buildEnvSchema(
  measurements: BootMeasurements,
): z.ZodObject<ReturnType<typeof envShape>> {
  return z.object(envShape(measurements));
}

/** The flat, typed result of one `EnvSchema.parse`. */
export type ParsedEnv = z.infer<ReturnType<typeof buildEnvSchema>>;

// -----------------------------------------------------------------------------------------------
// The frozen configuration object
// -----------------------------------------------------------------------------------------------

/** `fs` or `s3`, validated as a group (02, cross-field refinements). */
export type StorageConfig =
  | { readonly driver: 'fs'; readonly dir: string }
  | {
      readonly driver: 's3';
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly forcePathStyle: boolean;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    };

/** The frozen configuration object every plugin receives a slice of. */
export interface IridiumConfig {
  readonly env: NodeEnvName;
  readonly server: {
    readonly bindAddress: string;
    readonly port: number;
    readonly publicOrigin: URL;
    readonly publicHost: string;
    readonly trustProxy: readonly string[] | false;
    readonly tls: { readonly certFile: string; readonly keyFile: string } | null;
    readonly devOrigins: readonly string[];
  };
  readonly db: {
    readonly appUrl: string;
    readonly migrateUrl: string | null;
    readonly backupUrl: string | null;
    readonly poolApp: number;
    readonly poolPersist: number;
    readonly connectTimeoutMs: number;
  };
  readonly keys: {
    readonly pepper: Keyring;
    readonly auditHmac: Keyring;
    readonly mcpCursor: Keyring;
    readonly attachment: Keyring | null;
  };
  readonly auth: {
    readonly sessionWebIdleHours: number;
    readonly sessionWebAbsoluteDays: number;
    readonly sessionDesktopIdleDays: number;
    readonly sessionDesktopAbsoluteDays: number;
    readonly stepUpWindowMinutes: number;
    readonly argon2MemoryKib: number;
    readonly argon2TimeCost: number;
    readonly passwordMinLength: number;
    readonly loginThrottleMaxFailures: number;
    readonly loginThrottleBlockMinutes: number;
    readonly loginThrottleIpPerDay: number;
  };
  readonly tokens: {
    readonly patDefaultLifetimeDays: number;
    readonly patMaxLifetimeDays: number;
    readonly patAllowNoExpiry: boolean;
    readonly patRotationOverlapMaxHours: number;
  };
  readonly mcp: {
    readonly enabled: boolean;
    readonly rateLimitPerHour: number;
    readonly burstPerMinute: number;
    readonly processCeilingPerMinute: number;
    readonly requestTimeoutMs: number;
    readonly oauthEnabled: boolean;
  };
  readonly oauth: {
    /** `<PUBLIC_ORIGIN>/oauth` — derived, never configurable (ARCH-09). */
    readonly issuer: string;
    /** `<PUBLIC_ORIGIN>/mcp/connect` — derived, never configurable. */
    readonly resource: string;
    readonly accessTokenTtlMinutes: number;
    readonly refreshIdleDays: number;
    readonly refreshAbsoluteDays: number;
    readonly defaultRateLimitPerHour: number;
    readonly allowDynamicClientRegistration: boolean;
    readonly allowClientIdMetadataDocuments: boolean;
    readonly allowConsentWithoutStepUp: boolean;
  };
  readonly collab: {
    readonly debounceMs: number;
    readonly maxDebounceMs: number;
    readonly maxLoadedDocs: number;
    readonly maxStateBytesTotal: number;
    readonly maxConnectionsPerUser: number;
    readonly maxConnectionsPerIp: number;
    readonly maxConnections: number;
    readonly ticketTtlSeconds: number;
    readonly wsMaxPayloadBytes: number;
    readonly updateLogRetentionDays: number;
  };
  readonly projection: { readonly workers: number; readonly timeoutMs: number };
  readonly transfer: {
    readonly workers: number;
    readonly stagingDir: string;
    readonly exportsDir: string;
    readonly exportTtlHours: number;
    readonly importStagingTtlHours: number;
    readonly maxUploadBytes: number;
    readonly maxImportBytes: number;
  };
  readonly storage: StorageConfig;
  readonly retention: {
    readonly trashDaysDefault: number;
    readonly auditDays: number;
    readonly auditArchiveExportDir: string;
    readonly accessLogDays: number;
    readonly accessLogPartitionLeadMonths: number;
  };
  readonly desktop: { readonly updatesDir: string };
  /** `IRIDIUM_WEB_DIR`; `null` means the server serves no UI (API-only). */
  readonly web: { readonly dir: string | null };
  readonly ops: {
    readonly logLevel: LogLevel;
    readonly logFormat: 'json' | 'pretty';
    readonly metricsEnabled: boolean;
    readonly metricsToken: string | null;
    readonly metricsAllowCidrs: readonly string[];
    readonly readyzStrictDurability: boolean;
    readonly shutdownDrainMs: number;
    readonly jobsEnabled: boolean;
    readonly pressureMaxHeapBytes: number;
    readonly pressureMaxEventLoopDelayMs: number;
  };
  readonly backup: {
    readonly ageRecipients: readonly string[];
    readonly zstdLevel: number;
    readonly zstdThreads: number;
    readonly binlogDir: string | null;
  };
  readonly lifecycle: {
    readonly migrateOnBoot: boolean;
    readonly allowNewerSchema: boolean;
    readonly allowUntestedMysql: boolean;
    readonly fault: string | null;
  };
}

// -----------------------------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------------------------

/** What `loadConfig` observed but did not fail on; `iridium config check` prints all of it. */
export interface ConfigDiagnostics {
  /** Reserved harness names present in the environment: recognised and deliberately not used. */
  readonly ignoredHarnessKeys: readonly string[];
  /** Non-fatal observations: a world-readable mount, a low `UV_THREADPOOL_SIZE`, an alias in use. */
  readonly warnings: readonly string[];
  /** The CPU ceiling `PROJECTION_WORKERS` defaulted against, and which bound won. */
  readonly cpuCeiling: CpuCeiling;
}

/** One parse: the frozen configuration, its redacted rendering and its diagnostics. */
export interface LoadedConfig {
  readonly config: IridiumConfig;
  readonly diagnostics: ConfigDiagnostics;
  readonly redacted: Readonly<Record<string, string>>;
}

/** Every secret the environment supplied, kept beside the config so redaction can name origins. */
interface SecretMaterial {
  readonly singles: ReadonlyMap<string, ResolvedSecret>;
  readonly keyrings: ReadonlyMap<string, Keyring>;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

function assertNoUnknownIridiumKeys(env: RawEnv): readonly string[] {
  const known = new Set<string>(ENV_SCHEMA_KEYS);
  for (const key of ENV_SCHEMA_KEYS) known.add(`${key}_FILE`);
  for (const alias of Object.keys(KEY_ALIASES)) known.add(alias);
  const ignored: string[] = [];

  for (const key of Object.keys(env)) {
    if (!key.startsWith('IRIDIUM_')) continue;
    const rejection = REJECTED_KEYS[key];
    if (rejection !== undefined) {
      throw new ConfigError('config.rejected_key', `${key} is refused: ${rejection}`, [key]);
    }
    if (
      RESERVED_HARNESS_KEYS.includes(key) ||
      RESERVED_HARNESS_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      ignored.push(key);
      continue;
    }
    if (known.has(key)) continue;
    throw new ConfigError(
      'config.unknown_key',
      `${key} is not a key this server reads. Every IRIDIUM_* variable the schema does not know is ` +
        `fatal, which is typo protection for the most sensitive knobs (ARCH-25). The reserved harness ` +
        `namespaces are ${RESERVED_HARNESS_PREFIXES.join(', ')} and the exact names ` +
        `${RESERVED_HARNESS_KEYS.join(', ')}.`,
      [key],
    );
  }
  return ignored.toSorted();
}

function applyAliases(env: RawEnv, warnings: string[]): Record<string, string | undefined> {
  const effective: Record<string, string | undefined> = { ...env };
  for (const [alias, canonical] of Object.entries(KEY_ALIASES)) {
    const aliasValue = env[alias];
    if (aliasValue === undefined) continue;
    if (env[canonical] !== undefined) {
      throw new ConfigError(
        'config.invalid',
        `${alias} and ${canonical} are both set, and they name one value. ${canonical} is the ` +
          `spelling 11-operations-and-deployment.md owns; ${alias} is the 02-system-architecture.md ` +
          `spelling, accepted as an alias.`,
        [alias, canonical],
      );
    }
    effective[canonical] = aliasValue;
    delete effective[alias];
    warnings.push(`${alias} is an accepted alias of ${canonical}; prefer ${canonical}`);
  }
  return effective;
}

function resolveAllSecrets(
  env: Record<string, string | undefined>,
  warnings: SecretWarning[],
): SecretMaterial {
  const singles = new Map<string, ResolvedSecret>();
  for (const name of SINGLE_SECRET_KEYS) {
    const resolved = resolveSecret(env, name, warnings);
    if (resolved === undefined) continue;
    singles.set(name, resolved);
    // The schema sees one spelling: the `_FILE` twin has already been read.
    env[name] = resolved.value;
    delete env[`${name}_FILE`];
  }

  const keyrings = new Map<string, Keyring>();
  for (const name of KEYRING_NAMES) keyrings.set(name, collectKeyring(env, name, warnings));
  return { singles, keyrings };
}

function withPassword(url: string, password: string | undefined): string {
  if (password === undefined) return url;
  try {
    const parsed = new URL(url);
    parsed.password = encodeURIComponent(password);
    return parsed.toString();
  } catch {
    return url;
  }
}

function checkKeyMaterial(keyrings: ReadonlyMap<string, Keyring>, issues: string[]): void {
  const decoder = new TextDecoder();
  for (const [name, keyring] of keyrings) {
    for (const [version, material] of keyring.versions) {
      const key = `${name}_V${String(version)}`;
      const decoded = Buffer.from(decoder.decode(material), 'base64');
      if (decoded.byteLength !== KEY_MATERIAL_BYTES) {
        issues.push(
          `${key} is not valid key material: expected ${String(KEY_MATERIAL_BYTES)} bytes of base64, ` +
            `got ${String(decoded.byteLength)} decoded bytes`,
        );
      }
    }
  }
}

/**
 * Whether a variable is one this server reads: a schema key, a `_FILE` twin of one, an accepted
 * alias, or a member of a keyring family. The keyring families are deliberately included, which is
 * the whole point of the predicate: `AUTH_PASSWORD_PEPPER_V1` is not a schema key (a keyring is
 * collected, not parsed), so a marker scan written against `ENV_SCHEMA_KEYS` alone would miss exactly
 * the values that matter most.
 */
export function isDocumentedKey(key: string): boolean {
  if (ENV_SCHEMA_KEYS.includes(key)) return true;
  if (key.endsWith('_FILE') && ENV_SCHEMA_KEYS.includes(key.slice(0, -'_FILE'.length))) return true;
  if (key in KEY_ALIASES) return true;
  const withoutFile = key.endsWith('_FILE') ? key.slice(0, -'_FILE'.length) : key;
  const family = withoutFile.replace(/_V\d+$/, '');
  return KEYRING_NAMES.includes(family) || family === RESERVED_KEYRING_NAME;
}

/** The cross-field refinement table of 02-system-architecture.md, "Loading pipeline". */
function refine(
  parsed: ParsedEnv,
  env: Record<string, string | undefined>,
  secrets: SecretMaterial,
  warnings: string[],
): void {
  const issues: string[] = [];
  const isProduction = parsed.NODE_ENV === 'production';

  const origin = parsed.PUBLIC_ORIGIN;
  if (isProduction && origin.protocol !== 'https:') {
    issues.push('PUBLIC_ORIGIN must use https outside development');
  }
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    issues.push('PUBLIC_ORIGIN must be a bare origin: no path, query or fragment');
  }

  if (env['TRUST_PROXY']?.trim().toLowerCase() === 'true') {
    issues.push(
      'TRUST_PROXY must be a comma-separated list of IPs or CIDRs; the literal true is rejected, ' +
        'because trusting every hop lets any client spoof X-Forwarded-For',
    );
  }

  const certSet = parsed.TLS_CERT_FILE !== null;
  const keySet = parsed.TLS_KEY_FILE !== null;
  if (certSet !== keySet) {
    issues.push('TLS_CERT_FILE and TLS_KEY_FILE are both set or both absent');
  }
  if (certSet && parsed.TRUST_PROXY.length > 0) {
    issues.push(
      'TLS_CERT_FILE/TLS_KEY_FILE (the air-gapped in-process TLS profile) and TRUST_PROXY are ' +
        'mutually exclusive: that profile has no proxy in front of it',
    );
  }

  if (parsed.IRIDIUM_FAULT !== null && parsed.NODE_ENV !== 'test') {
    issues.push(
      'IRIDIUM_FAULT is accepted only when NODE_ENV=test (config.test_knob_in_production)',
    );
  }
  if (parsed.DEV_ORIGINS.length > 0 && parsed.NODE_ENV !== 'development') {
    issues.push('DEV_ORIGINS is accepted only when NODE_ENV=development');
  }

  if (parsed.ATTACHMENTS_DRIVER === 's3') {
    for (const key of [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const) {
      if (parsed[key] === null) issues.push(`${key} is required when ATTACHMENTS_DRIVER=s3`);
    }
  } else if (parsed.ATTACHMENTS_DIR.trim() === '') {
    issues.push('ATTACHMENTS_DIR is required when ATTACHMENTS_DRIVER=fs');
  }

  if (parsed.ATTACHMENTS_ENCRYPTION === 'aes256gcm') {
    issues.push(
      'ATTACHMENTS_ENCRYPTION=aes256gcm is refused: application-level envelope encryption is not ' +
        'implemented (config.not_implemented). Encryption at rest is volume encryption plus, ' +
        'optionally, MySQL InnoDB tablespace encryption; the columns and the ATTACHMENT_KEY_V<n> ' +
        'keyring stay reserved (G4, answered 2026-09-12)',
    );
  }
  if (collectKeyring(env, RESERVED_KEYRING_NAME).versions.size > 0) {
    issues.push(
      `${RESERVED_KEYRING_NAME}_V<n> is refused: it is reserved for an envelope-encryption feature ` +
        'that is not implemented (config.not_implemented)',
    );
  }

  if (
    parsed.METRICS_ENABLED &&
    parsed.METRICS_TOKEN === null &&
    parsed.METRICS_ALLOW_CIDR.length === 0 &&
    !LOOPBACK_ADDRESSES.has(parsed.BIND_ADDRESS)
  ) {
    issues.push(
      'METRICS_ENABLED=true on a routable BIND_ADDRESS requires METRICS_TOKEN or METRICS_ALLOW_CIDR: ' +
        '/metrics is never anonymous on a routable interface (ARCH-04). On a loopback bind the route ' +
        'stays registered and answers 404 until one of them is configured',
    );
  }

  if (parsed.LOG_FORMAT === 'pretty' && isProduction) {
    issues.push(
      'LOG_FORMAT=pretty is refused when NODE_ENV=production (config.pretty_logs_in_production): ' +
        'production logs are machine-parsed JSON',
    );
  }

  const heapLimit = getHeapStatistics().heap_size_limit;
  if (parsed.PRESSURE_MAX_HEAP_BYTES !== 0 && parsed.PRESSURE_MAX_HEAP_BYTES >= heapLimit) {
    issues.push(
      `PRESSURE_MAX_HEAP_BYTES (${formatBytes(parsed.PRESSURE_MAX_HEAP_BYTES)}) is at or above V8's ` +
        `heap_size_limit (${formatBytes(heapLimit)}): the process would run out of memory before it ` +
        'ever shed load (config.pressure_above_heap_limit)',
    );
  }

  if (isProduction) {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && TEST_SECRET_MARKER.test(value) && isDocumentedKey(key)) {
        issues.push(
          `${key} carries the fixture marker "not-a-secret", which is refused when NODE_ENV=production ` +
            '(10-testing-and-quality.md rule 9: test secrets are never valid in production)',
        );
      }
    }
    checkKeyMaterial(secrets.keyrings, issues);
  }

  // Observed, never set. 11-operations-and-deployment.md's key table says `main.ts` sets this "before
  // any I/O if absent", and that is not implementable on Node 24: libuv sizes the threadpool the first
  // time anything uses it, and the ESM loader has already used it before the entry module's body runs.
  // Measured on Node 24.11.0 — eight concurrent `pbkdf2` calls, best of seven: 520 ms with nothing set,
  // 564 ms with `process.env.UV_THREADPOOL_SIZE = '8'` assigned at the top of the entry module (i.e. no
  // effect), 347 ms with the variable in the real environment. So the honest thing the schema can do is
  // observe it and tell the operator where it actually has to be set.
  const uvThreadpool = env['UV_THREADPOOL_SIZE'];
  if (uvThreadpool === undefined || Number(uvThreadpool) < UV_THREADPOOL_FLOOR) {
    warnings.push(
      `UV_THREADPOOL_SIZE is ${uvThreadpool ?? 'unset'}: argon2id at 150-300 ms serialises on the ` +
        `default libuv pool of 4. Set it to at least ${String(UV_THREADPOOL_FLOOR)} in the environment ` +
        'the process starts with (image ENV, Compose environment, systemd Environment=); a process ' +
        'cannot widen its own pool.',
    );
  }

  if (issues.length > 0) {
    const code = issues.some((issue) => issue.includes('not implemented'))
      ? 'config.not_implemented'
      : issues.some((issue) => issue.includes('NODE_ENV=production'))
        ? 'config.test_knob_in_production'
        : 'config.invalid';
    throw new ConfigError(code, issues.map((issue) => `✖ ${issue}`).join('\n'));
  }
}

function toConfig(parsed: ParsedEnv, secrets: SecretMaterial): IridiumConfig {
  const publicOrigin = new URL(parsed.PUBLIC_ORIGIN.origin);
  const storage: StorageConfig =
    parsed.ATTACHMENTS_DRIVER === 's3'
      ? {
          driver: 's3',
          endpoint: parsed.S3_ENDPOINT ?? '',
          region: parsed.S3_REGION,
          bucket: parsed.S3_BUCKET ?? '',
          forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
          accessKeyId: parsed.S3_ACCESS_KEY_ID ?? '',
          secretAccessKey: parsed.S3_SECRET_ACCESS_KEY ?? '',
        }
      : { driver: 'fs', dir: parsed.ATTACHMENTS_DIR };

  const password = (key: string): string | undefined => secrets.singles.get(key)?.value;
  const ring = (name: string): Keyring => secrets.keyrings.get(name) ?? EMPTY_KEYRING;

  return Object.freeze({
    env: parsed.NODE_ENV,
    server: Object.freeze({
      bindAddress: parsed.BIND_ADDRESS,
      port: parsed.PORT,
      publicOrigin,
      publicHost: parsed.PUBLIC_HOST ?? publicOrigin.host,
      trustProxy: parsed.TRUST_PROXY.length === 0 ? (false as const) : parsed.TRUST_PROXY,
      tls:
        parsed.TLS_CERT_FILE !== null && parsed.TLS_KEY_FILE !== null
          ? Object.freeze({ certFile: parsed.TLS_CERT_FILE, keyFile: parsed.TLS_KEY_FILE })
          : null,
      devOrigins: parsed.DEV_ORIGINS,
    }),
    db: Object.freeze({
      appUrl: withPassword(parsed.DATABASE_URL, password('DATABASE_PASSWORD')),
      migrateUrl:
        parsed.DATABASE_MIGRATE_URL === null
          ? null
          : withPassword(parsed.DATABASE_MIGRATE_URL, password('DATABASE_MIGRATE_PASSWORD')),
      backupUrl:
        parsed.DATABASE_BACKUP_URL === null
          ? null
          : withPassword(parsed.DATABASE_BACKUP_URL, password('DATABASE_BACKUP_PASSWORD')),
      poolApp: parsed.DB_POOL_APP,
      poolPersist: parsed.DB_POOL_PERSIST,
      connectTimeoutMs: parsed.DB_CONNECT_TIMEOUT_MS,
    }),
    keys: Object.freeze({
      pepper: ring('AUTH_PASSWORD_PEPPER'),
      auditHmac: ring('AUDIT_HMAC_KEY'),
      mcpCursor: ring('MCP_CURSOR_KEY'),
      attachment: null,
    }),
    auth: Object.freeze({
      sessionWebIdleHours: parsed.SESSION_WEB_IDLE_HOURS,
      sessionWebAbsoluteDays: parsed.SESSION_WEB_ABSOLUTE_DAYS,
      sessionDesktopIdleDays: parsed.SESSION_DESKTOP_IDLE_DAYS,
      sessionDesktopAbsoluteDays: parsed.SESSION_DESKTOP_ABSOLUTE_DAYS,
      stepUpWindowMinutes: parsed.STEP_UP_WINDOW_MIN,
      argon2MemoryKib: parsed.ARGON2_MEMORY_KIB,
      argon2TimeCost: parsed.ARGON2_TIME_COST,
      passwordMinLength: parsed.PASSWORD_MIN_LENGTH,
      loginThrottleMaxFailures: parsed.LOGIN_THROTTLE_MAX_FAILURES,
      loginThrottleBlockMinutes: parsed.LOGIN_THROTTLE_BLOCK_MIN,
      loginThrottleIpPerDay: parsed.LOGIN_THROTTLE_IP_PER_DAY,
    }),
    tokens: Object.freeze({
      patDefaultLifetimeDays: parsed.PAT_DEFAULT_LIFETIME_DAYS,
      patMaxLifetimeDays: parsed.PAT_MAX_LIFETIME_DAYS,
      patAllowNoExpiry: parsed.PAT_ALLOW_NO_EXPIRY,
      patRotationOverlapMaxHours: parsed.PAT_ROTATION_OVERLAP_MAX_HOURS,
    }),
    mcp: Object.freeze({
      enabled: parsed.MCP_ENABLED,
      rateLimitPerHour: parsed.MCP_RATE_LIMIT_PER_HOUR,
      burstPerMinute: parsed.MCP_RATE_LIMIT_BURST_PER_MIN,
      processCeilingPerMinute: parsed.MCP_PROCESS_CEILING_PER_MIN,
      requestTimeoutMs: parsed.MCP_REQUEST_TIMEOUT_MS,
      oauthEnabled: parsed.MCP_OAUTH_ENABLED,
    }),
    oauth: Object.freeze({
      issuer: `${publicOrigin.origin}/oauth`,
      resource: `${publicOrigin.origin}/mcp/connect`,
      accessTokenTtlMinutes: parsed.OAUTH_ACCESS_TOKEN_TTL_MINUTES,
      refreshIdleDays: parsed.OAUTH_REFRESH_IDLE_DAYS,
      refreshAbsoluteDays: parsed.OAUTH_REFRESH_ABSOLUTE_DAYS,
      defaultRateLimitPerHour: parsed.OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR,
      allowDynamicClientRegistration: parsed.OAUTH_ALLOW_DYNAMIC_CLIENT_REGISTRATION,
      allowClientIdMetadataDocuments: parsed.OAUTH_ALLOW_CLIENT_ID_METADATA_DOCUMENTS,
      allowConsentWithoutStepUp: parsed.OAUTH_ALLOW_CONSENT_WITHOUT_STEP_UP,
    }),
    collab: Object.freeze({
      debounceMs: parsed.COLLAB_DEBOUNCE_MS,
      maxDebounceMs: parsed.COLLAB_MAX_DEBOUNCE_MS,
      maxLoadedDocs: parsed.COLLAB_MAX_LOADED_DOCS,
      maxStateBytesTotal: parsed.COLLAB_MAX_STATE_BYTES_TOTAL,
      maxConnectionsPerUser: parsed.COLLAB_MAX_CONNECTIONS_PER_USER,
      maxConnectionsPerIp: parsed.COLLAB_MAX_CONNECTIONS_PER_IP,
      maxConnections: parsed.COLLAB_MAX_CONNECTIONS_PER_PROCESS,
      ticketTtlSeconds: parsed.COLLAB_TICKET_TTL_S,
      wsMaxPayloadBytes: parsed.WS_MAX_PAYLOAD_BYTES,
      updateLogRetentionDays: parsed.UPDATE_LOG_RETENTION_DAYS,
    }),
    projection: Object.freeze({
      workers: parsed.PROJECTION_WORKERS,
      timeoutMs: parsed.PROJECTION_TIMEOUT_MS,
    }),
    transfer: Object.freeze({
      workers: parsed.TRANSFER_WORKERS,
      stagingDir: parsed.STAGING_DIR,
      exportsDir: parsed.EXPORTS_DIR,
      exportTtlHours: parsed.EXPORT_TTL_HOURS,
      importStagingTtlHours: parsed.IMPORT_STAGING_TTL_HOURS,
      maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
      maxImportBytes: parsed.MAX_IMPORT_BYTES,
    }),
    storage: Object.freeze(storage),
    retention: Object.freeze({
      trashDaysDefault: parsed.TRASH_RETENTION_DAYS,
      auditDays: parsed.AUDIT_RETENTION_DAYS,
      auditArchiveExportDir: parsed.AUDIT_ARCHIVE_EXPORT_DIR,
      accessLogDays: parsed.ACCESS_LOG_RETENTION_DAYS,
      accessLogPartitionLeadMonths: parsed.ACCESS_LOG_PARTITION_LEAD_MONTHS,
    }),
    desktop: Object.freeze({ updatesDir: parsed.DESKTOP_UPDATES_DIR }),
    web: Object.freeze({ dir: parsed.IRIDIUM_WEB_DIR }),
    ops: Object.freeze({
      logLevel: parsed.LOG_LEVEL,
      logFormat: parsed.LOG_FORMAT,
      metricsEnabled: parsed.METRICS_ENABLED,
      metricsToken: parsed.METRICS_TOKEN,
      metricsAllowCidrs: parsed.METRICS_ALLOW_CIDR,
      readyzStrictDurability: parsed.READYZ_STRICT_DURABILITY,
      shutdownDrainMs: parsed.SHUTDOWN_DRAIN_MS,
      jobsEnabled: parsed.JOBS_ENABLED,
      pressureMaxHeapBytes: parsed.PRESSURE_MAX_HEAP_BYTES,
      pressureMaxEventLoopDelayMs: parsed.PRESSURE_MAX_EVENT_LOOP_DELAY_MS,
    }),
    backup: Object.freeze({
      ageRecipients: parsed.BACKUP_AGE_RECIPIENTS,
      zstdLevel: parsed.BACKUP_ZSTD_LEVEL,
      zstdThreads: parsed.BACKUP_ZSTD_THREADS,
      binlogDir: parsed.MYSQL_BINLOG_DIR,
    }),
    lifecycle: Object.freeze({
      migrateOnBoot: parsed.IRIDIUM_MIGRATE_ON_BOOT,
      allowNewerSchema: parsed.IRIDIUM_ALLOW_NEWER_SCHEMA,
      allowUntestedMysql: parsed.IRIDIUM_ALLOW_UNTESTED_MYSQL,
      fault: parsed.IRIDIUM_FAULT,
    }),
  });
}

/**
 * The whole loading pipeline of 02-system-architecture.md: `_FILE` twins, keyrings, the unknown-key
 * rule, `EnvSchema.parse`, the cross-field refinements, `Object.freeze`.
 *
 * @throws ConfigError with `exitCode` 2. Its `message` is already the operator-facing text —
 * `z.prettifyError` output for a schema failure, a named reason otherwise.
 */
export function loadConfigDetailed(env: RawEnv = processEnv()): LoadedConfig {
  const warnings: string[] = [];
  const ignoredHarnessKeys = assertNoUnknownIridiumKeys(env);
  const effective = applyAliases(env, warnings);
  const measurements = measure();

  const secretWarnings: SecretWarning[] = [];
  const secrets = resolveAllSecrets(effective, secretWarnings);
  for (const warning of secretWarnings) warnings.push(`${warning.key}: ${warning.message}`);

  const result = buildEnvSchema(measurements).safeParse(effective);
  if (!result.success) {
    throw new ConfigError('config.invalid', z.prettifyError(result.error));
  }
  const parsed = result.data;
  refine(parsed, effective, secrets, warnings);

  const config = toConfig(parsed, secrets);
  return {
    config,
    diagnostics: Object.freeze({
      ignoredHarnessKeys,
      warnings: Object.freeze(warnings),
      cpuCeiling: measurements.cpuCeiling,
    }),
    redacted: redactConfig(config, secrets),
  };
}

/**
 * `loadConfig(env): IridiumConfig` — the plain form of 02-system-architecture.md's module contract
 * for `config/`, which names `loadConfig(env)` and `redactConfig()` as what this module exposes.
 *
 * `serve` and every CLI command take `loadConfigDetailed` instead, because `iridium config check`
 * prints the diagnostics and the redacted summary that the detailed form carries; this overload is
 * what a caller that wants only the parsed object uses. In this repository those callers are the
 * programmatic surface in `src/index.ts` and the `config/**` unit suites, which assert one parse
 * outcome at a time and have no use for the diagnostics.
 *
 * @internal
 */
export function loadConfig(env: RawEnv = processEnv()): IridiumConfig {
  return loadConfigDetailed(env).config;
}

// -----------------------------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------------------------

/** A list for the summary, or `<unset>` when it is empty. */
function listOrUnset(values: readonly string[]): string {
  return values.length === 0 ? '<unset>' : values.join(',');
}

/** Strips the password component of a connection URL, keeping the role, host and schema. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparsable>';
  }
}

/**
 * The single redacted rendering of ARCH-28: every secret prints as
 * `<set: versions v1,v2; sha256:ab12cd34>`, a file-sourced value names its origin, an unset optional
 * secret prints `<unset>`, and nothing anywhere prints `***`.
 */
export function redactConfig(
  config: IridiumConfig,
  secrets?: SecretMaterial,
): Readonly<Record<string, string>> {
  const single = (name: string): string => renderSecret(secrets?.singles.get(name));
  const ring = (name: string): string =>
    renderKeyring(secrets?.keyrings.get(name) ?? EMPTY_KEYRING);

  return Object.freeze({
    NODE_ENV: config.env,
    BIND_ADDRESS: config.server.bindAddress,
    PORT: String(config.server.port),
    PUBLIC_ORIGIN: config.server.publicOrigin.origin,
    PUBLIC_HOST:
      config.server.publicHost === config.server.publicOrigin.host
        ? `${config.server.publicHost} (derived)`
        : `${config.server.publicHost} (set; PUBLIC_ORIGIN host is ${config.server.publicOrigin.host})`,
    TRUST_PROXY:
      config.server.trustProxy === false ? '<unset>' : config.server.trustProxy.join(','),
    TLS:
      config.server.tls === null
        ? '<unset>'
        : `${config.server.tls.certFile} + ${config.server.tls.keyFile}`,
    DEV_ORIGINS: listOrUnset(config.server.devOrigins),
    DATABASE_URL: redactUrl(config.db.appUrl),
    DATABASE_PASSWORD: single('DATABASE_PASSWORD'),
    DATABASE_MIGRATE_URL:
      config.db.migrateUrl === null ? '<unset>' : redactUrl(config.db.migrateUrl),
    DATABASE_MIGRATE_PASSWORD: single('DATABASE_MIGRATE_PASSWORD'),
    DATABASE_BACKUP_URL: config.db.backupUrl === null ? '<unset>' : redactUrl(config.db.backupUrl),
    DATABASE_BACKUP_PASSWORD: single('DATABASE_BACKUP_PASSWORD'),
    DB_POOL_APP: String(config.db.poolApp),
    DB_POOL_PERSIST: String(config.db.poolPersist),
    DB_CONNECT_TIMEOUT_MS: String(config.db.connectTimeoutMs),
    AUTH_PASSWORD_PEPPER: ring('AUTH_PASSWORD_PEPPER'),
    AUDIT_HMAC_KEY: ring('AUDIT_HMAC_KEY'),
    MCP_CURSOR_KEY: ring('MCP_CURSOR_KEY'),
    ATTACHMENT_KEY: '<unset> (reserved: envelope encryption is not implemented)',
    METRICS_TOKEN: single('METRICS_TOKEN'),
    METRICS_ALLOW_CIDR: listOrUnset(config.ops.metricsAllowCidrs),
    S3_ACCESS_KEY_ID: single('S3_ACCESS_KEY_ID'),
    S3_SECRET_ACCESS_KEY: single('S3_SECRET_ACCESS_KEY'),
    ATTACHMENTS_DRIVER: config.storage.driver,
    ATTACHMENTS_DIR: config.storage.driver === 'fs' ? config.storage.dir : '<unset>',
    STAGING_DIR: config.transfer.stagingDir,
    EXPORTS_DIR: config.transfer.exportsDir,
    DESKTOP_UPDATES_DIR: config.desktop.updatesDir,
    STEP_UP_WINDOW_MIN: String(config.auth.stepUpWindowMinutes),
    PASSWORD_MIN_LENGTH: String(config.auth.passwordMinLength),
    ARGON2_MEMORY_KIB: String(config.auth.argon2MemoryKib),
    ARGON2_TIME_COST: String(config.auth.argon2TimeCost),
    COLLAB_MAX_LOADED_DOCS: String(config.collab.maxLoadedDocs),
    COLLAB_MAX_STATE_BYTES_TOTAL: formatBytes(config.collab.maxStateBytesTotal),
    COLLAB_MAX_CONNECTIONS_PER_PROCESS: String(config.collab.maxConnections),
    COLLAB_TICKET_TTL_S: String(config.collab.ticketTtlSeconds),
    PROJECTION_WORKERS: String(config.projection.workers),
    TRANSFER_WORKERS: String(config.transfer.workers),
    MAX_UPLOAD_BYTES: formatBytes(config.transfer.maxUploadBytes),
    MAX_IMPORT_BYTES: formatBytes(config.transfer.maxImportBytes),
    IRIDIUM_WEB_DIR: config.web.dir ?? '<unset> (API-only: the server serves no UI)',
    LOG_LEVEL: config.ops.logLevel,
    LOG_FORMAT: config.ops.logFormat,
    METRICS_ENABLED: String(config.ops.metricsEnabled),
    READYZ_STRICT_DURABILITY: String(config.ops.readyzStrictDurability),
    SHUTDOWN_DRAIN_MS: String(config.ops.shutdownDrainMs),
    JOBS_ENABLED: String(config.ops.jobsEnabled),
    PRESSURE_MAX_HEAP_BYTES: formatBytes(config.ops.pressureMaxHeapBytes),
    PRESSURE_MAX_EVENT_LOOP_DELAY_MS: String(config.ops.pressureMaxEventLoopDelayMs),
    MCP_ENABLED: String(config.mcp.enabled),
    MCP_OAUTH_ENABLED: String(config.mcp.oauthEnabled),
    OAUTH_ISSUER: `${config.oauth.issuer} (derived from PUBLIC_ORIGIN)`,
    OAUTH_RESOURCE: `${config.oauth.resource} (derived from PUBLIC_ORIGIN)`,
    AUDIT_RETENTION_DAYS: String(config.retention.auditDays),
    ACCESS_LOG_RETENTION_DAYS: String(config.retention.accessLogDays),
    TRASH_RETENTION_DAYS: String(config.retention.trashDaysDefault),
    IRIDIUM_MIGRATE_ON_BOOT: String(config.lifecycle.migrateOnBoot),
    IRIDIUM_ALLOW_NEWER_SCHEMA: String(config.lifecycle.allowNewerSchema),
    IRIDIUM_ALLOW_UNTESTED_MYSQL: String(config.lifecycle.allowUntestedMysql),
    IRIDIUM_FAULT: config.lifecycle.fault ?? '<unset>',
  });
}
