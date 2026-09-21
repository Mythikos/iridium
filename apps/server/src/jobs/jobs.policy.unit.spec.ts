import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { monthPartition } from './partitions.ts';
import { removeManagedPath, revisionRetentionBucket } from './retention.ts';
import { JOB_SCHEDULE } from './schedule.ts';

describe('jobs.policy.unit [area:jobs]', () => {
  it('keeps every revision for 24h then uses UTC hour and day buckets through leap days', () => {
    const now = new Date('2028-03-31T00:00:00.000Z');
    expect(revisionRetentionBucket(new Date('2028-03-30T00:00:00.001Z'), now)).toBeNull();
    expect(revisionRetentionBucket(new Date('2028-03-30T00:00:00.000Z'), now)).toMatch(/^h:/);
    expect(revisionRetentionBucket(new Date('2028-03-01T00:00:00.000Z'), now)).toMatch(/^d:/);
    expect(revisionRetentionBucket(new Date('2028-02-29T01:00:00.000Z'), now)).toBe(
      revisionRetentionBucket(new Date('2028-02-29T23:59:59.000Z'), now),
    );
    expect(monthPartition(2028, 1)).toEqual({
      name: 'p2028_02',
      boundary: '2028-03-01 00:00:00.000000',
    });
    expect(monthPartition(2028, 12)).toEqual({
      name: 'p2029_01',
      boundary: '2029-02-01 00:00:00.000000',
    });
  });
  it('anchors daily, weekly and monthly schedules without local timezone or restart drift', () => {
    const now = new Date('2026-09-20T03:00:00.000Z');
    expect(
      JOB_SCHEDULE.find((row) => row.type === 'revision_thinning')
        ?.dueAt(now)
        .toISOString(),
    ).toBe('2026-09-19T03:10:00.000Z');
    expect(
      JOB_SCHEDULE.find((row) => row.type === 'audit_archive')
        ?.dueAt(now)
        .toISOString(),
    ).toBe('2026-09-13T04:00:00.000Z');
    expect(
      JOB_SCHEDULE.find((row) => row.type === 'attachment_unreferenced_report')
        ?.dueAt(now)
        .toISOString(),
    ).toBe('2026-09-01T00:00:00.000Z');
  });
  it('removes only a verified descendant while refusing root and traversal paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iridium-job-path-'));
    const managed = join(dir, 'managed');
    await mkdir(managed);
    await writeFile(join(dir, 'outside'), 'keep');
    await writeFile(join(managed, 'inside'), 'remove');
    try {
      await expect(removeManagedPath(managed, '..', true)).rejects.toThrow('escaped');
      await expect(removeManagedPath(managed, managed, true)).rejects.toThrow('escaped');
      await expect(removeManagedPath(managed, '../outside', false)).rejects.toThrow('escaped');
      expect(await readFile(join(dir, 'outside'), 'utf8')).toBe('keep');
      expect(await removeManagedPath(managed, 'inside', false)).toBe(true);
      expect(await removeManagedPath(managed, 'missing', false)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
