/** The promised harness policy scans executable syntax and proves its own refusals. */
import { describe, expect, it } from 'vitest';

import { harnessViolations } from './harness-policy.ts';
import { isTestPath, sourceOf, sourcesUnder } from './source-scan.ts';

const SOURCES = sourcesUnder(['apps', 'packages', 'tooling']).filter((source) =>
  isTestPath(source.path),
);

describe('guards.no-mocks-outside-unit.guard [area:testing]', () => {
  it('enforces the policy on the current selected source tree', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.flatMap((source) => harnessViolations(source, 'mocks'))).toEqual([]);
  });
  it.each([
    "import { vi as stub } from 'vitest'; stub.mock('../src/auth.ts');",
    "vi.spyOn(adapter, 'verify').mockResolvedValue(true);",
    "vi['doMock']('../src/service.ts');",
    "import { http } from 'msw';",
    "await import('msw/node');",
  ])('rejects an executable violation: %s', (code) => {
    expect(harnessViolations(sourceOf('fixture.ts', code), 'mocks').join('\n')).not.toContain(
      'parse failed',
    );
    expect(
      harnessViolations(
        sourceOf('apps/server/test/integration/refusal.integration.spec.ts', code),
        'mocks',
      ).length,
    ).toBeGreaterThan(0);
  });
  it.each([
    "const text = \"vi.mock('example')\"; // vi.spyOn(x, 'write')",
    'const result = await realServer.start();',
  ])('accepts a legitimate dependency or inert fixture: %s', (code) => {
    expect(
      harnessViolations(
        sourceOf('apps/server/test/integration/refusal.integration.spec.ts', code),
        'mocks',
      ),
    ).toEqual([]);
  });
  it('fails closed on malformed source', () => {
    expect(
      harnessViolations(
        sourceOf('apps/server/test/integration/refusal.integration.spec.ts', 'const ='),
        'mocks',
      )[0],
    ).toContain('parse failed');
  });

  it('permits isolated unit and component adapter mocks', () => {
    for (const path of [
      'apps/server/src/auth/adapter.unit.spec.ts',
      'packages/ui/src/status.component.spec.ts',
    ]) {
      expect(
        harnessViolations(
          sourceOf(path, "import { vi } from 'vitest'; vi.mock('node:fs');"),
          'mocks',
        ),
      ).toEqual([]);
    }
  });
});
