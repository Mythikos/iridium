/** SQL aggregates and bounded samples remain separate so a page never understates the impact. */
import type { Link } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { summariseAffectedLinks } from './rename-impact.ts';

const TARGET = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const SOURCE = '0199aaaa-bbbb-7ccc-8ddd-dddddddddddd';

function link(id: number): Link {
  return {
    id,
    fromNoteId: SOURCE,
    fromPath: '/Source',
    revision: 1,
    ordinal: id,
    kind: 'markdown',
    rawTarget: '/Target.md',
    resolvedNodeId: TARGET,
    resolvedAttachmentId: null,
    fragment: null,
    status: 'resolved',
    startOffset: 0,
    endOffset: 10,
    line: id + 1,
  };
}

describe('tree.rename-impact.unit [area:links]', () => {
  it('counts links rather than source notes and retains every closed status bucket', () => {
    expect(
      summariseAffectedLinks(
        [
          { status: 'resolved', total: '2' },
          { status: 'ambiguous', total: 1 },
          { status: 'broken', total: 1 },
          { status: 'external', total: 1 },
        ],
        [link(1)],
      ),
    ).toMatchObject({ total: 5, byStatus: { resolved: 2, ambiguous: 1, broken: 1, external: 1 } });
  });

  it('reports the aggregate count independently from its bounded sample', () => {
    const result = summariseAffectedLinks(
      [{ status: 'resolved', total: 100_000 }],
      [link(1), link(2)],
    );
    expect(result.total).toBe(100_000);
    expect(result.samples).toHaveLength(2);
    expect(summariseAffectedLinks([], [])).toEqual({
      total: 0,
      byStatus: { resolved: 0, ambiguous: 0, broken: 0, external: 0 },
      samples: [],
    });
  });

  it('caps samples at 50, preserves SQL order and includes only warning fields', () => {
    const rows = Array.from({ length: 60 }, (_, index) => link(index + 1));
    const original = structuredClone(rows);
    const summary = summariseAffectedLinks([{ status: 'resolved', total: 400 }], rows);
    expect(summary.samples).toHaveLength(50);
    expect(summary.samples[0]).toEqual({
      fromNoteId: SOURCE,
      fromPath: '/Source',
      line: 2,
      rawTarget: '/Target.md',
    });
    expect(summary.samples.at(-1)?.line).toBe(51);
    expect(rows).toEqual(original);
  });

  it('refuses invalid counts and statuses outside the closed protocol union', () => {
    const malformed = Object.assign(
      { status: 'resolved' as const, total: 1 },
      { status: 'future' },
    );
    expect(() => summariseAffectedLinks([malformed], [])).toThrow('Unknown link status');
    expect(() => summariseAffectedLinks([{ status: 'resolved', total: -1 }], [])).toThrow(
      'Invalid affected-link count',
    );
  });
});
