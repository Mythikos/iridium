/**
 * `guards.seq-is-number.guard` (10-testing-and-quality.md, "Guard tests"; 03-data-model.md §1.3;
 * D05-15).
 *
 * Every sequence counter — `note_docs.head_seq`, `snapshot_through_seq`, `projected_seq`,
 * `note_updates.seq`, `note_revisions.seq`, `note_projections.revision` — is a JS `number` end to
 * end. Mixing `number` and `bigint` is a runtime `TypeError` inside the durable acknowledgement
 * path. The persistence and note trees therefore reject bigint annotations, calls and literals.
 *
 * Kysely's driver row counts are a different domain: an exact comparison with `numUpdatedRows`
 * may use a bigint literal, and the named adapter unit fixtures must return Kysely's bigint
 * `numAffectedRows`. Only those fields and expressions are exempt, never a whole line or file.
 */
import { describe, expect, it } from 'vitest';

import { locate, sourceOf, sourcesUnder, type Source } from './source-scan.ts';

const SCANNED_DIRS: readonly string[] = [
  'apps/server/src/collab',
  'apps/server/src/notes',
  'apps/server/src/db/schema.ts',
];

const BIGINT_LITERAL = /(?<![\w$.])\d[\d_]*n\b/g;
const BIGINT_TYPE = /(?<![\w$])bigint\b/g;
const BIGINT_CALL = /(?<![\w$.])BigInt\s*\(/g;
const DRIVER_ADAPTER_TESTS = new Set([
  'apps/server/src/collab/persistence/kysely-store.unit.spec.ts',
  'apps/server/src/collab/persistence/prune.unit.spec.ts',
  'apps/server/src/collab/owner-lease.unit.spec.ts',
]);
const ROW_COUNT = String.raw`(?:\d[\d_]*n|BigInt\(\s*(?:[A-Za-z_$][\w$]*|\d[\d_]*)\s*\))`;
/** A literal count, a converted numeric count, or the fixture's successful/failed-write choice. */
const AFFECTED_ROWS = new RegExp(
  String.raw`[{,]\s*numAffectedRows\s*:\s*(` +
    ROW_COUNT +
    String.raw`|[A-Za-z_$][\w$]*\s*===\s*\d[\d_]*\s*\?\s*` +
    ROW_COUNT +
    String.raw`\s*:\s*` +
    ROW_COUNT +
    String.raw`)\s*(?=[,}])`,
  'g',
);
const UPDATED_ROWS_COMPARISON =
  /(?<![\w$])(?:[A-Za-z_$][\w$]*\.)*numUpdatedRows\s*(?:[!=]==?|[<>]=?)\s*\d[\d_]*n\b/g;

/** Accept only the matched count expression, leaving neighbouring sequence fields visible. */
function isDriverRowCount(source: Source, offset: number): boolean {
  for (const match of source.code.matchAll(UPDATED_ROWS_COMPARISON)) {
    if (offset >= match.index && offset < match.index + match[0].length) return true;
  }
  if (!DRIVER_ADAPTER_TESTS.has(source.path)) return false;
  for (const match of source.code.matchAll(AFFECTED_ROWS)) {
    if (offset >= match.index && offset < match.index + match[0].length) return true;
  }
  return false;
}

/** Every forbidden `bigint` spelling in one source, as `file:line: text`. */
function bigintUses(source: Source): string[] {
  const hits: string[] = [];
  for (const pattern of [BIGINT_LITERAL, BIGINT_TYPE, BIGINT_CALL]) {
    for (const match of source.code.matchAll(pattern)) {
      if (isDriverRowCount(source, match.index)) continue;
      hits.push(locate(source, match.index));
    }
  }
  return hits;
}

const SOURCES = sourcesUnder(SCANNED_DIRS);

describe('guards.seq-is-number.guard [area:collab]', () => {
  it('scans the persistence trees', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.map((source) => source.path)).toContain(
      'apps/server/src/collab/persistence/writer.ts',
    );
    expect(SOURCES.map((source) => source.path)).toContain('apps/server/src/db/schema.ts');
  });

  it('finds no bigint annotation, BigInt call or n-suffixed literal outside driver row counts', () => {
    const offenders = SOURCES.flatMap((source) => bigintUses(source));
    expect(
      offenders,
      'Every sequence counter is a JS number (03-data-model.md §1.3, D05-15). Remedy: keep the ' +
        'value a number. Only exact Kysely row-count comparisons and numAffectedRows values in ' +
        'the named driver adapter unit fixtures may use bigint.',
    ).toEqual([]);
  });

  it('refuses each sequence spelling while ignoring prose and an exact driver comparison', () => {
    const forbidden = sourceOf(
      'apps/server/src/collab/persistence/seq.ts',
      [
        'export const head: bigint = 1n;',
        'export const next = BigInt(2) + head;',
        "// a comment may say bigint or 3n; a string may too: 'BigInt(4)'",
        "export const prose = 'bigint 5n BigInt(6)';",
        'if (result.numUpdatedRows !== 1n) throw new Error();',
      ].join('\n'),
    );
    expect(bigintUses(forbidden)).toEqual([
      'apps/server/src/collab/persistence/seq.ts:1: export const head: bigint = 1n;',
      'apps/server/src/collab/persistence/seq.ts:1: export const head: bigint = 1n;',
      'apps/server/src/collab/persistence/seq.ts:2: export const next = BigInt(2) + head;',
    ]);
  });

  it('accepts exact driver fixture counts across formatting and conditional outcomes', () => {
    const source = [
      'return { numAffectedRows: 1n };',
      'return { rows: [], numAffectedRows:\n  BigInt(result) };',
      'return { numAffectedRows: writes === 1 ? 1n : 0n };',
    ].join('\n');
    for (const path of DRIVER_ADAPTER_TESTS) {
      expect(bigintUses(sourceOf(path, source))).toEqual([]);
    }
  });

  it.each([...DRIVER_ADAPTER_TESTS])(
    'still rejects sequence bigints beside driver counts in %s',
    (path) => {
      const source = [
        'return { numAffectedRows: 1n, head_seq: 2n };',
        'return { seq: BigInt(3), numAffectedRows: 1n };',
        'const head: bigint = 4n; if (row.numUpdatedRows === 1n) commit();',
        'const head = 5n; const numUpdatedRows = 1;',
        'return { numAffectedRows: (() => { const seq = 6n; return seq; })() };',
      ].join('\n');
      const hits = bigintUses(sourceOf(path, source));
      expect(hits).toHaveLength(6);
      expect(hits.filter((hit) => hit.includes('head_seq: 2n'))).toHaveLength(1);
      expect(hits.filter((hit) => hit.includes('seq: BigInt(3)'))).toHaveLength(1);
      expect(hits.filter((hit) => hit.includes('head: bigint = 4n'))).toHaveLength(2);
      expect(hits.filter((hit) => hit.includes('const head = 5n'))).toHaveLength(1);
      expect(hits.filter((hit) => hit.includes('const seq = 6n'))).toHaveLength(1);
    },
  );

  it('does not exempt production code, unrelated tests, or row-count lookalike fields', () => {
    for (const path of [
      'apps/server/src/collab/persistence/kysely-store.ts',
      'apps/server/src/collab/persistence/writer.unit.spec.ts',
    ]) {
      expect(bigintUses(sourceOf(path, 'return { numAffectedRows: 1n };'))).toHaveLength(1);
    }
    expect(
      bigintUses(
        sourceOf(
          'apps/server/src/collab/persistence/prune.unit.spec.ts',
          'return { numAffectedRowsSeq: 1n, numAffectedRows: BigInt(2) };',
        ),
      ),
    ).toHaveLength(1);
  });
});
