/**
 * `config.env.unit` (12-milestones.md section 4.6; 10-testing-and-quality.md, "Server suite by area",
 * Ops row).
 *
 * What this file is the proof of, in the plan's own words: `EnvSchema` rejects unknown `IRIDIUM_*`
 * keys, boots on an environment carrying every reserved harness name of D10-5, loads `*_FILE`
 * secrets, prints the redacted summary, and parses **every documented default** — including
 * `COLLAB_MAX_LOADED_DOCS` 2 000 and `COLLAB_MAX_STATE_BYTES_TOTAL` 1 GiB, which is the only place
 * the production values of the capacity limits are asserted: reaching them in a live test would mean
 * 2 001 document loads, so the behaviour is proven at an overridden budget in
 * `collab.admission-budget.integration` and CH-10, and the *numbers* are proven here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIMITS } from '@iridium/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import { ConfigError } from './config-error.ts';
import {
  ENV_SCHEMA_KEYS,
  envShape,
  KEY_ALIASES,
  loadConfig,
  loadConfigDetailed,
  REJECTED_KEYS,
  RESERVED_HARNESS_KEYS,
  RESERVED_HARNESS_PREFIXES,
  type RawEnv,
} from './env.ts';

/** The two required keys, and nothing else, so every other value under test is a default. */
const MINIMAL: RawEnv = Object.freeze({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'http://127.0.0.1:4000',
  DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
});

const scratch = mkdtempSync(join(tmpdir(), 'iridium-config-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function secretFile(name: string, contents: string): string {
  const path = join(scratch, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

function expectConfigError(env: RawEnv): ConfigError {
  let thrown: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    thrown = error;
  }
  // A narrowing `if` rather than `expect(...).toBeInstanceOf()` plus a cast: the cast would assert a
  // type the compiler cannot check, and this form both proves the class and narrows `thrown` for the
  // assertions below.
  if (!(thrown instanceof ConfigError)) {
    throw new Error(`expected loadConfig to refuse this environment; it threw: ${String(thrown)}`);
  }
  expect(thrown.exitCode, 'every configuration failure exits 2 (OPS-16, ARCH-22)').toBe(2);
  return thrown;
}

describe('config.env.unit [area:ops]', () => {
  describe('unknown IRIDIUM_* keys', () => {
    it('rejects a typo in an IRIDIUM_* key with config.unknown_key', () => {
      const error = expectConfigError({ ...MINIMAL, IRIDIUM_MIGRATE_ON_BOT: 'true' });
      expect(error.code).toBe('config.unknown_key');
      expect(error.message).toContain('IRIDIUM_MIGRATE_ON_BOT');
    });

    it('ignores an unknown variable without the IRIDIUM_ prefix', () => {
      expect(() => loadConfig({ ...MINIMAL, SOME_OTHER_TOOL_SETTING: 'x' })).not.toThrow();
    });

    it('boots on an environment carrying every reserved harness name of D10-5', () => {
      const harness: Record<string, string> = {};
      for (const prefix of RESERVED_HARNESS_PREFIXES) harness[`${prefix}EXAMPLE`] = 'set';
      for (const key of RESERVED_HARNESS_KEYS) harness[key] = 'set';

      const loaded = loadConfigDetailed({ ...MINIMAL, ...harness });
      expect(loaded.diagnostics.ignoredHarnessKeys).toEqual(
        Object.keys(harness).toSorted((a, b) => a.localeCompare(b)),
      );
    });

    it('rejects IRIDIUM_ALLOW_NO_ORIGIN_WS by name, with the reason', () => {
      const error = expectConfigError({ ...MINIMAL, IRIDIUM_ALLOW_NO_ORIGIN_WS: 'true' });
      expect(error.code).toBe('config.rejected_key');
      expect(error.message).toContain('no bypass for the absent-Origin rule');
    });

    it('rejects IRIDIUM_E2E on the server with a hint naming the desktop main process', () => {
      const error = expectConfigError({ ...MINIMAL, IRIDIUM_E2E: '1' });
      expect(error.code).toBe('config.rejected_key');
      expect(error.message).toContain('desktop main process');
      expect(Object.keys(REJECTED_KEYS)).toContain('IRIDIUM_E2E');
    });
  });

  describe('*_FILE secrets', () => {
    it('reads a secret from its _FILE twin and trims one trailing newline', () => {
      const path = secretFile('db-password', 'pa:ss/word@1\n');
      const loaded = loadConfigDetailed({ ...MINIMAL, DATABASE_PASSWORD_FILE: path });
      // The password is applied to the connection URL, percent-encoded, and never printed.
      expect(loaded.config.db.appUrl).toContain(encodeURIComponent('pa:ss/word@1'));
      expect(loaded.redacted['DATABASE_PASSWORD']).toMatch(/^<set: file:.*; sha256:[0-9a-f]{8}>$/);
    });

    it('refuses both forms of one secret rather than choosing a precedence', () => {
      const path = secretFile('both-forms', 'from-the-file');
      const error = expectConfigError({
        ...MINIMAL,
        DATABASE_PASSWORD: 'from-the-value',
        DATABASE_PASSWORD_FILE: path,
      });
      expect(error.code).toBe('config.secret_both_forms');
    });

    it('loads a keyring from _V<n> twins and accepts the unversioned name as version 1', () => {
      const v2 = secretFile('audit-v2', 'second-version');
      const loaded = loadConfigDetailed({
        ...MINIMAL,
        AUDIT_HMAC_KEY: 'first-version',
        AUDIT_HMAC_KEY_V2_FILE: v2,
      });
      expect([...loaded.config.keys.auditHmac.versions.keys()].toSorted((a, b) => a - b)).toEqual([
        1, 2,
      ]);
      expect(loaded.config.keys.auditHmac.highest).toBe(2);
    });

    it('refuses the reserved ATTACHMENT_KEY keyring, because envelope encryption is not built', () => {
      const error = expectConfigError({ ...MINIMAL, ATTACHMENT_KEY_V1: 'reserved' });
      expect(error.code).toBe('config.not_implemented');
      expect(error.message).toContain('ATTACHMENT_KEY_V<n> is refused');
    });
  });

  describe('the redacted summary (ARCH-28)', () => {
    it('prints a fingerprint and an origin per secret, and never the material', () => {
      const pepper = secretFile('pepper-v1', 'material-nobody-should-see');
      const loaded = loadConfigDetailed({
        ...MINIMAL,
        AUTH_PASSWORD_PEPPER_V1_FILE: pepper,
        METRICS_TOKEN: 'a-metrics-token-of-at-least-32-characters',
      });

      const rendered = Object.values(loaded.redacted).join('\n');
      expect(rendered).not.toContain('material-nobody-should-see');
      expect(rendered).not.toContain('a-metrics-token-of-at-least-32-characters');
      // A bare `***` is explicitly not an accepted rendering: the fingerprint is the operator control.
      expect(rendered).not.toContain('***');

      expect(loaded.redacted['AUTH_PASSWORD_PEPPER']).toMatch(
        /^<set: versions v1; file:.*pepper-v1; sha256:[0-9a-f]{8}>$/,
      );
      expect(loaded.redacted['METRICS_TOKEN']).toMatch(/^<set: sha256:[0-9a-f]{8}>$/);
    });

    it('prints <unset> for an unset optional secret', () => {
      const loaded = loadConfigDetailed(MINIMAL);
      expect(loaded.redacted['METRICS_TOKEN']).toBe('<unset>');
      expect(loaded.redacted['AUDIT_HMAC_KEY']).toBe('<unset>');
    });

    it('strips the password from every connection URL it prints', () => {
      const loaded = loadConfigDetailed({ ...MINIMAL, DATABASE_PASSWORD: 'not-in-the-summary' });
      expect(loaded.redacted['DATABASE_URL']).not.toContain('not-in-the-summary');
      expect(loaded.redacted['DATABASE_URL']).toContain('iridium_app');
    });

    it('accepts PUBLIC_HOST as an override and says so, rather than deriving it silently', () => {
      // The two legitimately differ behind a proxy that rewrites Host to an internal name: without
      // the override that deployment trips the Host guard on every request with no way out but
      // changing the public origin.
      const loaded = loadConfigDetailed({ ...MINIMAL, PUBLIC_HOST: 'iridium.internal:4000' });
      expect(loaded.config.server.publicHost).toBe('iridium.internal:4000');
      expect(loaded.config.server.publicOrigin.host).toBe('127.0.0.1:4000');
      expect(loaded.redacted['PUBLIC_HOST']).toContain('iridium.internal:4000');
      expect(loaded.redacted['PUBLIC_HOST']).not.toContain('(derived)');
    });

    it('names the derived values as derived, so no operator looks for a key that does not exist', () => {
      const loaded = loadConfigDetailed(MINIMAL);
      expect(loaded.redacted['PUBLIC_HOST']).toContain('(derived)');
      expect(loaded.config.server.publicHost).toBe(loaded.config.server.publicOrigin.host);
      expect(loaded.redacted['OAUTH_ISSUER']).toBe(
        'http://127.0.0.1:4000/oauth (derived from PUBLIC_ORIGIN)',
      );
      expect(loaded.redacted['OAUTH_RESOURCE']).toBe(
        'http://127.0.0.1:4000/mcp/connect (derived from PUBLIC_ORIGIN)',
      );
    });
  });

  describe('every documented default', () => {
    const { config } = loadConfigDetailed(MINIMAL);

    it('parses the capacity budgets at their production values', () => {
      // The one place these two numbers are asserted (10-testing-and-quality.md, Ops row).
      expect(config.collab.maxLoadedDocs).toBe(2_000);
      expect(config.collab.maxStateBytesTotal).toBe(1_073_741_824);
    });

    it('parses the process and network defaults', () => {
      expect(config.env).toBe('test');
      expect(config.server.bindAddress).toBe('127.0.0.1');
      expect(config.server.port).toBe(4_000);
      expect(config.server.publicHost).toBe('127.0.0.1:4000');
      expect(config.server.trustProxy).toBe(false);
      expect(config.server.tls).toBeNull();
      expect(config.server.devOrigins).toEqual([]);
      expect(config.ops.shutdownDrainMs).toBe(20_000);
      expect(config.ops.pressureMaxEventLoopDelayMs).toBe(1_000);
      // Derived from V8's real ceiling rather than a constant, so it tracks --max-old-space-size.
      expect(config.ops.pressureMaxHeapBytes).toBeGreaterThan(0);
    });

    it('parses the database defaults', () => {
      expect(config.db.poolApp).toBe(20);
      expect(config.db.poolPersist).toBe(4);
      expect(config.db.connectTimeoutMs).toBe(10_000);
      expect(config.db.migrateUrl).toBeNull();
      expect(config.db.backupUrl).toBeNull();
      expect(config.lifecycle.migrateOnBoot).toBe(false);
      expect(config.lifecycle.allowNewerSchema).toBe(false);
      expect(config.lifecycle.allowUntestedMysql).toBe(false);
      expect(config.ops.readyzStrictDurability).toBe(true);
    });

    it('parses the authentication policy floors', () => {
      expect(config.auth).toMatchObject({
        argon2MemoryKib: 65_536,
        argon2TimeCost: 3,
        sessionWebIdleHours: 24,
        sessionWebAbsoluteDays: 14,
        sessionDesktopIdleDays: 30,
        sessionDesktopAbsoluteDays: 90,
        stepUpWindowMinutes: 10,
        passwordMinLength: 15,
        loginThrottleMaxFailures: 5,
        loginThrottleBlockMinutes: 15,
        loginThrottleIpPerDay: 100,
      });
    });

    it('parses the token, MCP and authorization-server defaults', () => {
      expect(config.tokens).toEqual({
        patDefaultLifetimeDays: 90,
        patMaxLifetimeDays: 366,
        patAllowNoExpiry: false,
        patRotationOverlapMaxHours: 24,
      });
      expect(config.mcp).toEqual({
        enabled: true,
        oauthEnabled: true,
        rateLimitPerHour: 3_000,
        burstPerMinute: 120,
        processCeilingPerMinute: 600,
        requestTimeoutMs: 30_000,
      });
      expect(config.oauth).toMatchObject({
        accessTokenTtlMinutes: 60,
        refreshIdleDays: 30,
        refreshAbsoluteDays: 90,
        defaultRateLimitPerHour: 3_000,
        allowDynamicClientRegistration: true,
        allowClientIdMetadataDocuments: true,
        allowConsentWithoutStepUp: false,
      });
    });

    it('parses the collaboration, projection and transfer defaults', () => {
      expect(config.collab).toMatchObject({
        debounceMs: 2_000,
        maxDebounceMs: 10_000,
        maxConnectionsPerUser: 20,
        maxConnectionsPerIp: 50,
        maxConnections: 5_000,
        ticketTtlSeconds: 60,
        wsMaxPayloadBytes: 2_097_152,
        updateLogRetentionDays: 7,
      });
      expect(config.projection.timeoutMs).toBe(10_000);
      expect(config.projection.workers).toBeGreaterThanOrEqual(1);
      expect(config.transfer).toMatchObject({
        workers: 1,
        stagingDir: '/data/staging',
        exportsDir: '/data/exports',
        exportTtlHours: 24,
        importStagingTtlHours: 72,
        maxUploadBytes: 52_428_800,
        maxImportBytes: 2_147_483_648,
      });
    });

    it('parses the storage, retention, backup and observability defaults', () => {
      expect(config.storage).toEqual({ driver: 'fs', dir: '/data/attachments' });
      expect(config.desktop.updatesDir).toBe('/data/desktop-updates');
      expect(config.web.dir).toBeNull();
      expect(config.retention).toEqual({
        trashDaysDefault: 30,
        auditDays: 400,
        auditArchiveExportDir: '/data/exports/audit-archive',
        accessLogDays: 90,
        accessLogPartitionLeadMonths: 3,
      });
      expect(config.backup).toEqual({
        ageRecipients: [],
        zstdLevel: 12,
        zstdThreads: 2,
        binlogDir: null,
      });
      expect(config.ops.logLevel).toBe('info');
      expect(config.ops.logFormat).toBe('json');
      expect(config.ops.metricsEnabled).toBe(true);
      expect(config.ops.jobsEnabled).toBe(true);
    });

    it('takes every overridable default from the single limits policy, never a second copy', () => {
      // An environment name is never a constant name (ARCH-16); this is what makes that testable.
      expect(config.collab.maxLoadedDocs).toBe(LIMITS.LOADED_DOCS_MAX);
      expect(config.collab.maxStateBytesTotal).toBe(LIMITS.LOADED_STATE_BYTES_MAX);
      expect(config.collab.debounceMs).toBe(LIMITS.COMPACTION_DEBOUNCE_MS);
      expect(config.collab.maxDebounceMs).toBe(LIMITS.COMPACTION_MAX_DEBOUNCE_MS);
      expect(config.collab.wsMaxPayloadBytes).toBe(LIMITS.WS_MAX_PAYLOAD_BYTES);
      expect(config.transfer.maxUploadBytes).toBe(LIMITS.UPLOAD_MAX_BYTES);
      expect(config.transfer.maxImportBytes).toBe(LIMITS.IMPORT_MAX_BYTES);
      expect(config.projection.timeoutMs).toBe(LIMITS.PROJECTION_TIMEOUT_SERVER_MS);
      expect(config.ops.shutdownDrainMs).toBe(LIMITS.SHUTDOWN_DRAIN_MS);
      expect(config.mcp.rateLimitPerHour).toBe(LIMITS.MCP_TOKEN_PER_HOUR);
    });

    it('freezes the result, so nothing can mutate configuration after boot', () => {
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.server)).toBe(true);
      expect(Object.isFrozen(config.collab)).toBe(true);
    });
  });

  describe('typed values and bounds', () => {
    it('parses byte sizes in both suffix families', () => {
      expect(loadConfig({ ...MINIMAL, MAX_UPLOAD_BYTES: '50MiB' }).transfer.maxUploadBytes).toBe(
        52_428_800,
      );
      expect(loadConfig({ ...MINIMAL, MAX_UPLOAD_BYTES: '50MB' }).transfer.maxUploadBytes).toBe(
        50_000_000,
      );
      expect(loadConfig({ ...MINIMAL, MAX_UPLOAD_BYTES: '1048576' }).transfer.maxUploadBytes).toBe(
        1_048_576,
      );
    });

    it('refuses a byte size with an ambiguous suffix rather than guessing', () => {
      expect(expectConfigError({ ...MINIMAL, MAX_UPLOAD_BYTES: '50M' }).code).toBe(
        'config.invalid',
      );
    });

    it('refuses a pool below the floor the writer fairness scheduler needs', () => {
      expect(expectConfigError({ ...MINIMAL, DB_POOL_APP: '4' }).message).toContain('at least 5');
      expect(expectConfigError({ ...MINIMAL, DB_POOL_PERSIST: '1' }).message).toContain(
        'at least 2',
      );
    });

    it('refuses a boolean that is neither true nor false', () => {
      expect(expectConfigError({ ...MINIMAL, JOBS_ENABLED: 'yes' }).message).toContain(
        'expected true or false',
      );
    });

    it('refuses the literal true for TRUST_PROXY, which would let any client spoof its address', () => {
      expect(expectConfigError({ ...MINIMAL, TRUST_PROXY: 'true' }).message).toContain(
        'the literal true is rejected',
      );
    });

    it('parses TRUST_PROXY as a list of addresses and CIDRs', () => {
      const config = loadConfig({ ...MINIMAL, TRUST_PROXY: '172.20.0.0/24, ::1/128' });
      expect(config.server.trustProxy).toEqual(['172.20.0.0/24', '::1/128']);
    });
  });

  describe('cross-field refinements', () => {
    it('requires https for PUBLIC_ORIGIN in production', () => {
      const error = expectConfigError({
        ...MINIMAL,
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'http://iridium.example',
      });
      expect(error.message).toContain('PUBLIC_ORIGIN must use https');
    });

    it('refuses a PUBLIC_ORIGIN that carries a path', () => {
      expect(
        expectConfigError({ ...MINIMAL, PUBLIC_ORIGIN: 'http://127.0.0.1:4000/iridium' }).message,
      ).toContain('bare origin');
    });

    it('requires TLS_CERT_FILE and TLS_KEY_FILE together, and never with TRUST_PROXY', () => {
      expect(expectConfigError({ ...MINIMAL, TLS_CERT_FILE: '/tls/cert.pem' }).message).toContain(
        'both set or both absent',
      );
      expect(
        expectConfigError({
          ...MINIMAL,
          TLS_CERT_FILE: '/tls/cert.pem',
          TLS_KEY_FILE: '/tls/key.pem',
          TRUST_PROXY: '127.0.0.1/32',
        }).message,
      ).toContain('mutually exclusive');
    });

    it('validates the s3 driver keys as a group', () => {
      const error = expectConfigError({ ...MINIMAL, ATTACHMENTS_DRIVER: 's3' });
      for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
        expect(error.message).toContain(key);
      }
    });

    it('refuses ATTACHMENTS_ENCRYPTION=aes256gcm as not implemented, not as undecided', () => {
      const error = expectConfigError({ ...MINIMAL, ATTACHMENTS_ENCRYPTION: 'aes256gcm' });
      expect(error.code).toBe('config.not_implemented');
      expect(error.message).toContain('volume encryption');
    });

    it('refuses IRIDIUM_FAULT outside NODE_ENV=test and DEV_ORIGINS outside development', () => {
      expect(
        expectConfigError({ ...MINIMAL, NODE_ENV: 'development', IRIDIUM_FAULT: 'store.throw' })
          .message,
      ).toContain('IRIDIUM_FAULT');
      expect(
        expectConfigError({ ...MINIMAL, DEV_ORIGINS: 'http://localhost:5173' }).message,
      ).toContain('DEV_ORIGINS');
    });

    it('accepts IRIDIUM_FAULT under NODE_ENV=test and DEV_ORIGINS under development', () => {
      expect(loadConfig({ ...MINIMAL, IRIDIUM_FAULT: 'store.throw' }).lifecycle.fault).toBe(
        'store.throw',
      );
      expect(
        loadConfig({
          ...MINIMAL,
          NODE_ENV: 'development',
          DEV_ORIGINS: 'http://localhost:5173',
        }).server.devOrigins,
      ).toEqual(['http://localhost:5173']);
    });

    it('refuses LOG_FORMAT=pretty in production', () => {
      const error = expectConfigError({
        ...MINIMAL,
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://iridium.example',
        LOG_FORMAT: 'pretty',
      });
      expect(error.message).toContain('machine-parsed JSON');
    });

    it('refuses an anonymous /metrics on a routable bind address only', () => {
      // Loopback: the route is registered and answers 404 until a credential is configured.
      expect(() => loadConfig({ ...MINIMAL, METRICS_ENABLED: 'true' })).not.toThrow();
      const error = expectConfigError({ ...MINIMAL, BIND_ADDRESS: '0.0.0.0' });
      expect(error.message).toContain('routable BIND_ADDRESS');
    });

    it('warns rather than fails when UV_THREADPOOL_SIZE is below the argon2id floor', () => {
      const loaded = loadConfigDetailed({ ...MINIMAL, UV_THREADPOOL_SIZE: '4' });
      expect(loaded.diagnostics.warnings.join('\n')).toContain('UV_THREADPOOL_SIZE');
    });
  });

  describe('the key table itself', () => {
    it('declares exactly the keys the schema shape carries', () => {
      const shape = Object.keys(
        envShape({
          defaultProjectionWorkers: 1,
          defaultPressureHeapBytes: 1,
          cpuCeiling: { cpus: 1, bound: 'host', hostParallelism: 1, cgroupCpus: 1 },
        }),
      );
      expect(ENV_SCHEMA_KEYS.toSorted((a, b) => a.localeCompare(b))).toEqual(
        shape.toSorted((a, b) => a.localeCompare(b)),
      );
    });

    it('accepts the 02-system-architecture spelling of an aliased key, and warns', () => {
      const loaded = loadConfigDetailed({ ...MINIMAL, STEP_UP_WINDOW_MINUTES: '20' });
      expect(loaded.config.auth.stepUpWindowMinutes).toBe(20);
      expect(loaded.diagnostics.warnings.join('\n')).toContain('STEP_UP_WINDOW_MINUTES');
    });

    it('refuses both spellings of an aliased key at once', () => {
      for (const [alias, canonical] of Object.entries(KEY_ALIASES)) {
        const error = expectConfigError({ ...MINIMAL, [alias]: '1', [canonical]: '1' });
        expect(error.message).toContain(alias);
        expect(error.message).toContain(canonical);
      }
    });

    it('names no product key inside a reserved harness namespace', () => {
      for (const key of ENV_SCHEMA_KEYS) {
        for (const prefix of RESERVED_HARNESS_PREFIXES) {
          expect(key.startsWith(prefix), `${key} collides with the reserved prefix ${prefix}`).toBe(
            false,
          );
        }
        expect(RESERVED_HARNESS_KEYS).not.toContain(key);
      }
    });
  });
});
