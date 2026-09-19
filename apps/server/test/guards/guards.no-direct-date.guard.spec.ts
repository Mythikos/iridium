/** The promised harness policy scans executable syntax and proves its own refusals. */
import { describe, expect, it } from 'vitest';

import { harnessViolations } from './harness-policy.ts';
import { isTestPath, sourceOf, sourcesUnder } from './source-scan.ts';

const SOURCES = sourcesUnder(['apps/server/src']).filter(
  (source) => !isTestPath(source.path) && source.path !== 'apps/server/src/ops/clock.ts',
);

describe('guards.no-direct-date.guard [area:testing]', () => {
  it('enforces the policy on the current selected source tree', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.flatMap((source) => harnessViolations(source, 'clock'))).toEqual([]);
  });
  it.each([
    'const now = Date.now();',
    'const now = new Date();',
    "const now = globalThis.Date['now']();",
    'const now = Date();',
    'const now = globalThis.Date();',
    "const now = global['Date']();",
    "import { setTimeout as later } from 'node:timers'; later(work, 100);",
  ])('rejects an executable violation: %s', (code) => {
    expect(harnessViolations(sourceOf('fixture.ts', code), 'clock').join('\n')).not.toContain(
      'parse failed',
    );
    expect(
      harnessViolations(sourceOf('apps/server/src/auth/expiry.ts', code), 'clock').length,
    ).toBeGreaterThan(0);
  });
  it.each([
    'const date = new Date(timestamp); const now = clock.now();',
    'clock.after(100, work);',
    "const note = 'Date.now()'; // new Date()",
  ])('accepts a legitimate dependency or inert fixture: %s', (code) => {
    expect(harnessViolations(sourceOf('apps/server/src/auth/expiry.ts', code), 'clock')).toEqual(
      [],
    );
  });
  it('fails closed on malformed source', () => {
    expect(
      harnessViolations(sourceOf('apps/server/src/auth/expiry.ts', 'const ='), 'clock')[0],
    ).toContain('parse failed');
  });
});
