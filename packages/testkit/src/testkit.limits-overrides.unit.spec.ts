import { LIMIT_ENV_OVERRIDES } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { buildServerEnv } from './server/env.ts';
import {
  LIMIT_ENV_OVERRIDE_KEYS,
  LIMIT_OVERRIDE_ENV,
  LIMIT_OVERRIDE_ENV_KEYS,
  collabBootLimits,
  limitsEnv,
} from './server/limits.ts';

/**
 * `startServer({ limits })` may turn exactly the knobs `@iridium/contracts` exposes as environment
 * keys, and no others (10-testing-and-quality.md, `StartServerOptions`). The table that maps a
 * harness name to an environment key is the only place the two vocabularies meet, so the first case
 * is the one that matters: it holds the table's coverage equal to `LIMIT_ENV_OVERRIDES`, which is
 * what makes a newly tunable limit a failure here rather than a knob no suite knows about.
 */

describe('testkit.limits-overrides.unit [area:testkit]', () => {
  it('covers every limit @iridium/contracts exposes as an environment key, and no other', () => {
    expect(Object.values(LIMIT_OVERRIDE_ENV).toSorted()).toStrictEqual([
      ...LIMIT_ENV_OVERRIDE_KEYS,
    ]);
    expect(LIMIT_ENV_OVERRIDE_KEYS).toStrictEqual(Object.keys(LIMIT_ENV_OVERRIDES).toSorted());
  });

  it('gives each limit exactly one name', () => {
    const keys = Object.values(LIMIT_OVERRIDE_ENV);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sends the canonical EnvSchema spelling for the three connection caps', () => {
    // `EnvSchema` declares the per-process cap as `COLLAB_MAX_CONNECTIONS_PER_PROCESS` and keeps the
    // short `COLLAB_MAX_CONNECTIONS` only as a warned `KEY_ALIASES` entry, so a harness that sent the
    // short form would boot a process complaining about its own environment.
    expect(LIMIT_OVERRIDE_ENV.maxConnections).toBe('COLLAB_MAX_CONNECTIONS_PER_PROCESS');
    expect(LIMIT_OVERRIDE_ENV.maxConnectionsPerUser).toBe('COLLAB_MAX_CONNECTIONS_PER_USER');
    expect(LIMIT_OVERRIDE_ENV.maxConnectionsPerIp).toBe('COLLAB_MAX_CONNECTIONS_PER_IP');
  });

  it('renders the budget override the admission-budget suite passes', () => {
    expect(limitsEnv({ maxLoadedDocs: 8, maxStateBytesTotal: '2MiB' })).toStrictEqual({
      COLLAB_MAX_LOADED_DOCS: '8',
      COLLAB_MAX_STATE_BYTES_TOTAL: '2MiB',
    });
  });

  it('renders nothing for an empty or all-undefined override set', () => {
    expect(limitsEnv({})).toStrictEqual({});
    expect(limitsEnv({ maxLoadedDocs: undefined })).toStrictEqual({});
  });

  it('hands the collaboration subset to buildApp for a per-boot override', () => {
    // `seams/collab-server.md` §2: `CollabLimitOverrides` takes numbers, and the environment is per
    // process while `buildApp({ limits })` is per boot.
    expect(
      collabBootLimits(
        { maxLoadedDocs: 8, maxConnections: 20 },
        { compactionAwaitTimeoutMs: 1_000 },
      ),
    ).toStrictEqual({
      maxLoadedDocs: 8,
      maxConnections: 20,
      compactionAwaitTimeoutMs: 1_000,
    });
  });

  it('leaves a byte string to the environment, which owns the parser for it', () => {
    // `'2MiB'` reaches the same knob through `COLLAB_MAX_STATE_BYTES_TOTAL`; parsing it here would be
    // a second implementation of `EnvSchema`'s byte field.
    expect(collabBootLimits({ maxStateBytesTotal: '2MiB' }, {})).toBeUndefined();
    expect(limitsEnv({ maxStateBytesTotal: '2MiB' })).toStrictEqual({
      COLLAB_MAX_STATE_BYTES_TOTAL: '2MiB',
    });
    expect(collabBootLimits({ maxStateBytesTotal: 2_097_152 }, {})).toStrictEqual({
      maxStateBytesTotal: 2_097_152,
    });
  });

  it('carries nothing to buildApp when nothing collaboration-shaped was overridden', () => {
    expect(collabBootLimits({}, {})).toBeUndefined();
    expect(collabBootLimits({ maxUploadBytes: 10 }, {})).toBeUndefined();
  });

  it('includes optional settings only in the environment of the boot that requests them', () => {
    const bare = buildServerEnv({ host: 'h', port: 1, schema: 's', publicOrigin: 'http://x' });
    const full = buildServerEnv({
      host: 'h',
      port: 1,
      schema: 's',
      publicOrigin: 'http://x',
      faults: 'store.throw',
      attachmentsDir: '/tmp/a',
      collab: { debounceMs: 1, maxDebounceMs: 2, ticketTtlS: 3 },
    });
    expect(full).toStrictEqual({
      ...bare,
      IRIDIUM_FAULT: 'store.throw',
      ATTACHMENTS_DIR: '/tmp/a',
      COLLAB_DEBOUNCE_MS: '1',
      COLLAB_MAX_DEBOUNCE_MS: '2',
      COLLAB_TICKET_TTL_S: '3',
    });
    expect(
      Object.keys(full)
        .filter((key) => !(key in bare))
        .toSorted(),
    ).toStrictEqual([
      'ATTACHMENTS_DIR',
      'COLLAB_DEBOUNCE_MS',
      'COLLAB_MAX_DEBOUNCE_MS',
      'COLLAB_TICKET_TTL_S',
      'IRIDIUM_FAULT',
    ]);
    expect(LIMIT_OVERRIDE_ENV_KEYS).toContain('COLLAB_MAX_LOADED_DOCS');
    expect(LIMIT_OVERRIDE_ENV_KEYS).toHaveLength(Object.keys(LIMIT_OVERRIDE_ENV).length);
  });

  it('refuses a name that is not an operator-tunable limit, and says what is', () => {
    // A suite reaching past the table has found a limit the product does not let an operator tune,
    // which is a finding about the product rather than a reason to widen the harness. The refusal is
    // a run-time one, so the call goes through a widened view of the same function rather than an
    // assertion that would only silence the checker.
    const anyName: (overrides: Record<string, number>) => Record<string, string> = limitsEnv;
    expect(() => anyName({ noteHardChars: 10 })).toThrow(/not an overridable limit/);
    expect(() => anyName({ noteHardChars: 10 })).toThrow(/maxLoadedDocs/);
  });
});
