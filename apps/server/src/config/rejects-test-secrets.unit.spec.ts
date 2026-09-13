/**
 * `config.rejects-test-secrets.unit` (10-testing-and-quality.md, fixture policy rule 9).
 *
 * The harness's secrets are fixed and obviously fake — `test-pepper-not-a-secret`,
 * `test-audit-not-a-secret`, `test-cursor-not-a-secret` — precisely so that a copied `.env.test`,
 * a pasted Compose block or a restored bundle cannot quietly become a production deployment's key
 * material. `EnvSchema` refuses any value matching `/not-a-secret/` when `NODE_ENV=production`, and
 * this file is what keeps that rule from being deleted as redundant.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from './config-error.ts';
import { loadConfig, type RawEnv } from './env.ts';

/** The same spellings `@iridium/testkit`'s `TEST_SECRETS` exports, quoted rather than imported:
 * the testkit is a devDependency of this package, and a production-code rule must not depend on a
 * harness module to be testable. */
const FIXTURE_SECRETS: Readonly<Record<string, string>> = Object.freeze({
  AUTH_PASSWORD_PEPPER: 'test-pepper-not-a-secret',
  AUDIT_HMAC_KEY: 'test-audit-not-a-secret',
  MCP_CURSOR_KEY: 'test-cursor-not-a-secret',
});

const PRODUCTION: RawEnv = Object.freeze({
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://iridium.example',
  DATABASE_URL: 'mysql://iridium_app:pw@db:3306/iridium',
});

const TEST: RawEnv = Object.freeze({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'http://127.0.0.1:4000',
  DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
});

describe('config.rejects-test-secrets.unit [area:ops]', () => {
  for (const [key, value] of Object.entries(FIXTURE_SECRETS)) {
    it(`refuses ${key} carrying the fixture marker when NODE_ENV=production`, () => {
      let thrown: unknown;
      try {
        loadConfig({ ...PRODUCTION, [key]: value });
      } catch (error) {
        thrown = error;
      }
      if (!(thrown instanceof ConfigError)) {
        throw new Error(`expected loadConfig to reject ${key}; it threw: ${String(thrown)}`);
      }
      expect(thrown.exitCode).toBe(2);
      expect(thrown.message).toContain('not-a-secret');
      expect(thrown.message).toContain(key);
    });
  }

  it('accepts the same fixtures under NODE_ENV=test, which is what the harness relies on', () => {
    const config = loadConfig({ ...TEST, ...FIXTURE_SECRETS });
    expect(config.keys.pepper.versions.size).toBe(1);
    expect(config.keys.auditHmac.versions.size).toBe(1);
    expect(config.keys.mcpCursor.versions.size).toBe(1);
  });

  it('refuses the marker in any documented key, not only in the three keyrings', () => {
    let thrown: unknown;
    try {
      loadConfig({ ...PRODUCTION, METRICS_TOKEN: 'metrics-token-not-a-secret' });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof ConfigError)) {
      throw new Error(`expected loadConfig to reject METRICS_TOKEN; it threw: ${String(thrown)}`);
    }
    expect(thrown.message).toContain('METRICS_TOKEN');
  });

  it('requires real 32-byte base64 key material in production', () => {
    let thrown: unknown;
    try {
      loadConfig({ ...PRODUCTION, AUTH_PASSWORD_PEPPER_V1: 'too-short' });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof ConfigError)) {
      throw new Error(
        `expected loadConfig to reject AUTH_PASSWORD_PEPPER_V1; it threw: ${String(thrown)}`,
      );
    }
    expect(thrown.message).toContain('32 bytes of base64');
  });

  it('accepts real key material in production', () => {
    const material = Buffer.alloc(32, 7).toString('base64');
    const config = loadConfig({ ...PRODUCTION, AUTH_PASSWORD_PEPPER_V1: material });
    expect(config.keys.pepper.highest).toBe(1);
  });
});
