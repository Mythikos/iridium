/** The promised harness policy scans executable syntax and proves its own refusals. */
import { describe, expect, it } from 'vitest';

import { harnessViolations } from './harness-policy.ts';
import { sourceOf, sourcesUnder } from './source-scan.ts';

const SOURCES = sourcesUnder(['apps', 'packages', 'tooling']).filter((source) =>
  /\.spec\.tsx?$/u.test(source.path),
);

describe('guards.no-sleep.guard [area:testing]', () => {
  it('enforces the policy on the current selected source tree', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.flatMap((source) => harnessViolations(source, 'sleep'))).toEqual([]);
  });
  it.each([
    'await new Promise((resolve) => setTimeout(resolve, 100));',
    "import { setTimeout as pause } from 'node:timers/promises'; await pause(100);",
    "globalThis['setTimeout'](finish, 100);",
    'await page.waitForTimeout(100);',
    'await delay(100);',
  ])('rejects an executable violation: %s', (code) => {
    expect(harnessViolations(sourceOf('fixture.ts', code), 'sleep').join('\n')).not.toContain(
      'parse failed',
    );
    expect(
      harnessViolations(
        sourceOf('apps/server/test/integration/wait.integration.spec.ts', code),
        'sleep',
      ).length,
    ).toBeGreaterThan(0);
  });
  it.each([
    "await expect.poll(read).toBe('ready');",
    "await clock.advance(100); await faults.delay('store.slow');",
    "const text = 'setTimeout(resolve, 100)';",
  ])('accepts a legitimate dependency or inert fixture: %s', (code) => {
    expect(
      harnessViolations(
        sourceOf('apps/server/test/integration/wait.integration.spec.ts', code),
        'sleep',
      ),
    ).toEqual([]);
  });
  it('fails closed on malformed source', () => {
    expect(
      harnessViolations(
        sourceOf('apps/server/test/integration/wait.integration.spec.ts', 'const ='),
        'sleep',
      )[0],
    ).toContain('parse failed');
  });
});
