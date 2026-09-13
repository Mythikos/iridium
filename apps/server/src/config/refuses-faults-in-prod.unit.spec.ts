/**
 * `config.refuses-faults-in-prod.unit` (10-testing-and-quality.md, "Fault injection: `IRIDIUM_FAULT`").
 *
 * The fault registry lives in the product (`apps/server/src/ops/faults.ts`) and is inert unless
 * `NODE_ENV === 'test'`. That inertness is defence in depth; the control that matters is this one:
 * `config/env.ts` **refuses to start** when `IRIDIUM_FAULT` is set outside a test environment, so a
 * production image cannot be pointed at a fault point by an environment variable a stray Compose
 * block carried over.
 *
 * `IRIDIUM_E2E` gets the same treatment for a different reason: the server never reads it at all
 * (the desktop main process does), so its presence here is always a copied-configuration mistake and
 * is refused by name with a hint rather than ignored.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from './config-error.ts';
import { loadConfig, type RawEnv } from './env.ts';

function base(nodeEnv: string): RawEnv {
  return {
    NODE_ENV: nodeEnv,
    PUBLIC_ORIGIN: nodeEnv === 'production' ? 'https://iridium.example' : 'http://127.0.0.1:4000',
    DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
  };
}

function refusal(env: RawEnv): ConfigError {
  let thrown: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof ConfigError)) {
    throw new Error(`expected loadConfig to refuse this environment; it threw: ${String(thrown)}`);
  }
  return thrown;
}

describe('config.refuses-faults-in-prod.unit [area:ops]', () => {
  it('refuses IRIDIUM_FAULT when NODE_ENV=production', () => {
    const error = refusal({ ...base('production'), IRIDIUM_FAULT: 'store.throw' });
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('IRIDIUM_FAULT');
    expect(error.message).toContain('NODE_ENV=test');
  });

  it('refuses IRIDIUM_FAULT when NODE_ENV=development too: the registry is a test knob', () => {
    expect(refusal({ ...base('development'), IRIDIUM_FAULT: 'store.slow:3000' }).exitCode).toBe(2);
  });

  it('accepts IRIDIUM_FAULT only when NODE_ENV=test, and carries the raw spec through', () => {
    expect(loadConfig({ ...base('test'), IRIDIUM_FAULT: 'store.slow:3000' }).lifecycle.fault).toBe(
      'store.slow:3000',
    );
  });

  it('leaves the fault unset when the variable is absent', () => {
    expect(loadConfig(base('test')).lifecycle.fault).toBeNull();
  });

  it('refuses IRIDIUM_E2E in every environment, because the server never reads it', () => {
    for (const nodeEnv of ['production', 'development', 'test']) {
      const error = refusal({ ...base(nodeEnv), IRIDIUM_E2E: '1' });
      expect(error.code).toBe('config.rejected_key');
    }
  });
});
