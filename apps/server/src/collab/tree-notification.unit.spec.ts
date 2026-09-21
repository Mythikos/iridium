import { LIMITS, NodeId, newId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { treeNotification } from './tree-notification.ts';

describe('tree.notification.unit [area:tree]', () => {
  const change = {
    nodeId: NodeId.parse(newId()),
    parentId: NodeId.parse(newId()),
    kind: 'note' as const,
    name: 'Note',
    path: '/Note',
    op: 'renamed' as const,
    version: 2,
  };
  it('retains a small delta and its committed tree version', () => {
    expect(treeNotification(8, [change])).toEqual({
      v: 1,
      t: 'tree-changed',
      treeVersion: 8,
      changes: [change],
    });
  });
  it('uses an empty invalidation for too many nodes or UTF-8 bytes', () => {
    expect(
      treeNotification(
        9,
        Array.from({ length: LIMITS.TREE_CHANGES_MAX + 1 }, () => change),
      ).changes,
    ).toEqual([]);
    const large = {
      ...change,
      path: '界'.repeat(Math.floor(LIMITS.STATELESS_PAYLOAD_MAX_BYTES / 2)),
    };
    expect(large.path.length).toBeLessThan(LIMITS.STATELESS_PAYLOAD_MAX_BYTES);
    expect(treeNotification(10, [large])).toEqual({
      v: 1,
      t: 'tree-changed',
      treeVersion: 10,
      changes: [],
    });
  });
});
