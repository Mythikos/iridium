/** The merged coverage gate must count one source file once across runner operating systems. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function evaluate(body: string): unknown {
  const stdout = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import { capture, prepare, relocateBlob } from './scripts/prepare-vitest-reports.ts';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
${body}
`,
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
  const result: unknown = JSON.parse(stdout);
  return result;
}

describe('guards.report-portability.guard', () => {
  it('relocates Windows, Unix and URL paths without changing references, results or counters', () => {
    expect(
      evaluate(`
const make = (root) => JSON.stringify([
  ['1', '2', '3', '4', 123.45, '5'], '5.0.0', ['6'], [],
  { [root + '/src/a.ts']: '7' }, [],
  { filepath: '8', state: '9', result: { duration: 72, retryCount: 0 } },
  { path: '8', s: { '0': 3 }, b: { '0': [2, 1] } }, root + '/src/a.ts', 'pass',
  root + '-neighbor/src/b.ts',
]);
const win = JSON.parse(relocateBlob(make('D:/a/repo'), 'D:\\\\a\\\\repo', '/merge/repo'));
const linux = JSON.parse(relocateBlob(make('/home/runner/repo'), '/home/runner/repo', '/merge/repo'));
const native = JSON.parse(relocateBlob(make('D:\\\\a\\\\repo'), 'D:/a/repo', '/merge/repo'));
const url = JSON.parse(relocateBlob(make('file:///D:/a/repo'), 'D:/a/repo', '/merge/repo'));
console.log(JSON.stringify({
  same: JSON.stringify(win.slice(0, 10)) === JSON.stringify(linux.slice(0, 10)),
  native: native[8], url: url[8], neighbor: win[10],
  coverage: win[4], counters: win[7], root: win[0], result: win[6].result,
}));
`),
    ).toEqual({
      same: true,
      native: '/merge/repo/src/a.ts',
      url: 'file:///merge/repo/src/a.ts',
      neighbor: 'D:/a/repo-neighbor/src/b.ts',
      coverage: { '/merge/repo/src/a.ts': '7' },
      counters: { path: '8', s: { '0': 3 }, b: { '0': [2, 1] } },
      root: ['1', '2', '3', '4', 123.45, '5'],
      result: { duration: 72, retryCount: 0 },
    });
  });

  it('refuses incompatible formats and normalization collisions', () => {
    expect(
      evaluate(`
const inputs = [[], [['1'], '5.0.0'], [['1','2','3','4',0,'5'], '6.0.0'],
  [['1','2','3','4',0,'5'], '5.0.0', { '/source/a.ts': 1, '/target/a.ts': 2 }]];
console.log(JSON.stringify(inputs.map(input => {
  try { relocateBlob(JSON.stringify(input), '/source', '/target'); return false; }
  catch { return true; }
})));
`),
    ).toEqual([true, true, true, true]);
  });

  it('preserves raw evidence and refuses stale, tampered or missing origins', () => {
    expect(
      evaluate(`
const root = mkdtempSync(join(tmpdir(), 'iridium-report-'));
try {
  const raw = join(root, 'raw'); mkdirSync(raw);
  const blob = JSON.stringify([['1','2','3','4',0,'5'], '5.0.0', [], [], {}, []]);
  const path = join(raw, 'unit.json'); writeFileSync(path, blob);
  capture(raw, '/source', 'commit-a');
  prepare(raw, join(root, 'merged'), '/target', 'commit-a');
  const unchanged = readFileSync(path, 'utf8') === blob;
  const refusals = [];
  for (const mode of ['stale', 'tampered', 'missing']) {
    capture(raw, '/source', 'commit-a');
    if (mode === 'tampered') writeFileSync(path, blob + ' ');
    if (mode === 'missing') rmSync(path + '.origin');
    try { prepare(raw, join(root, mode), '/target', mode === 'stale' ? 'commit-b' : 'commit-a'); refusals.push(false); }
    catch { refusals.push(true); }
    writeFileSync(path, blob);
  }
  console.log(JSON.stringify({ unchanged, refusals }));
} finally { rmSync(root, { recursive: true, force: true }); }
`),
    ).toEqual({ unchanged: true, refusals: [true, true, true] });
  });

  it('captures every Vitest lane and normalizes copies before the unchanged coverage gate', () => {
    const ci = readFileSync(
      new URL('../../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    expect(
      ci.match(/run: node scripts\/prepare-vitest-reports\.ts capture \.vitest-reports/g),
    ).toHaveLength(3);
    expect(ci).toContain(
      'node scripts/prepare-vitest-reports.ts merge .vitest-reports .vitest-merge',
    );
    expect(ci).toContain(
      'vitest --merge-reports=.vitest-merge --coverage --config vitest.config.ts',
    );
    expect(ci).toContain("IRIDIUM_COVERAGE_GATE: '1'");
    expect(ci).toContain('playwright merge-reports --config=playwright.config.ts');
    expect(ci).toMatch(/name: reports-integration-[^\n]+\r?\n\s+path: reports\//);
    expect(ci).toMatch(/name: mcp-conformance-[^\n]+\r?\n\s+path: results\//);
    expect(ci).toMatch(/pattern: reports-\*\r?\n\s+merge-multiple: true\r?\n\s+path: reports/);
  });
});
