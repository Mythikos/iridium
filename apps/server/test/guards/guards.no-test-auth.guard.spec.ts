/** The promised harness policy scans executable syntax and proves its own refusals. */
import { describe, expect, it } from 'vitest';

import { harnessViolations } from './harness-policy.ts';
import { isTestPath, sourceOf, sourcesUnder } from './source-scan.ts';

const SOURCES = sourcesUnder(['apps/server/src/auth']).filter((source) => !isTestPath(source.path));

describe('guards.no-test-auth.guard [area:testing]', () => {
  it('enforces the policy on the current selected source tree', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.flatMap((source) => harnessViolations(source, 'test-auth'))).toEqual([]);
  });
  it.each([
    "function check() { if (process.env.NODE_ENV === 'test') return true; }",
    "function check() { if (process.env['IRIDIUM_E2E']) return principal; }",
    'function check() { const { NODE_ENV } = process.env; if (NODE_ENV) return true; }',
    'function check() { if (environment.IRIDIUM_FAULT_AUTH) return true; }',
  ])('rejects an executable violation: %s', (code) => {
    expect(harnessViolations(sourceOf('fixture.ts', code), 'test-auth').join('\n')).not.toContain(
      'parse failed',
    );
    expect(
      harnessViolations(sourceOf('apps/server/src/auth/verify.ts', code), 'test-auth').length,
    ).toBeGreaterThan(0);
  });
  it.each([
    "function check() { if (principal.kind === 'user') return verify(principal); }",
    "const note = 'NODE_ENV=test is forbidden';",
  ])('accepts a legitimate dependency or inert fixture: %s', (code) => {
    expect(
      harnessViolations(sourceOf('apps/server/src/auth/verify.ts', code), 'test-auth'),
    ).toEqual([]);
  });
  it('fails closed on malformed source', () => {
    expect(
      harnessViolations(sourceOf('apps/server/src/auth/verify.ts', 'const ='), 'test-auth')[0],
    ).toContain('parse failed');
  });
});
