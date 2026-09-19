/** CPU-only mirror of the normative MySQL convergence property; identical commands and oracles. */
import { it } from '@fast-check/vitest';
import { applyV1, createNoteDoc, createUndoManager, encodeState, getContent } from '@iridium/crdt';
import { PROP, PROP_DB } from '@iridium/testkit';
import * as fc from 'fast-check';
import { describe, expect, it as test } from 'vitest';

import { ManualClock } from '../../../test/support/manual-clock.ts';
import {
  assertUndoIsolation,
  ClientReload,
  convergenceCommands,
  Insert,
  MAX_PEERS,
  runConvergenceModel,
} from './testing/convergence-model.ts';
import { recordingLogger } from './testing/harness.ts';
import { MemoryPersistenceStore } from './testing/memory-store.ts';
import { createModelReal, memoryModelStore } from './testing/model.ts';
import { createSimNet } from './testing/sim-net.ts';

describe('convergence.memory-model.prop [spec:concurrent-editing] [spec:initialization-reconnection] [hp:HP-1] [hp:HP-2]', () => {
  test('clamps edits away from the immutable initialization sentinel (seed 1587981890)', async () => {
    await expect(
      runConvergenceModel(2, [new Insert(0, 0.04, ''), new ClientReload(1)], (markdown) =>
        createModelReal({
          modelStore: memoryModelStore(new MemoryPersistenceStore()),
          clock: new ManualClock(),
          logger: recordingLogger(),
          markdown,
          random: () => 0.5,
        }),
      ),
    ).resolves.toBeUndefined();
  });
  test('demonstrates why marker sentinels exclude ordinary concurrent delete and undo (seed 1174724916)', () => {
    const docs = [0, 1, 2].map(() => createNoteDoc({ gc: true }));
    const undos = docs.map((doc) => createUndoManager(getContent(doc), { captureTimeout: 0 }));
    const remote = Symbol('regression.remote');
    const sync = (): void => {
      const updates = docs.map((doc) => encodeState(doc, 1));
      for (const doc of docs) for (const update of updates) applyV1(doc, update, remote);
    };
    const [author, first, second] = docs;
    if (author === undefined || first === undefined || second === undefined)
      throw new Error('missing docs');
    try {
      getContent(author).insert(0, '⟦p0:1⟧');
      sync();
      getContent(first).delete(0, 6);
      getContent(second).delete(0, 6);
      sync();
      undos[1]?.undo();
      undos[2]?.undo();
      sync();
      // Two independent local restorations legitimately allocate two new CRDT item ranges.
      expect(docs.map((doc) => getContent(doc).toJSON())).toEqual(Array(3).fill('⟦p0:1⟧⟦p0:1⟧'));
    } finally {
      for (const undo of undos) undo.destroy();
      for (const doc of docs) doc.destroy();
    }
  });
  it.prop(
    [
      fc.integer({ min: 2, max: MAX_PEERS }),
      fc.commands(convergenceCommands, { maxCommands: PROP_DB.maxCommands }),
    ],
    PROP,
  )(
    'N peers converge under every interleaving, without duplicated or lost content',
    (peers, sequence) =>
      runConvergenceModel(peers, sequence, (markdown) =>
        createModelReal({
          modelStore: memoryModelStore(new MemoryPersistenceStore()),
          clock: new ManualClock(),
          logger: recordingLogger(),
          markdown,
          random: () => 0.5,
        }),
      ),
  );
  test('allows undo to restore a deletion inside another author marker without losing foreign characters (seed 1174724916)', async () => {
    const real = await createModelReal({
      modelStore: memoryModelStore(new MemoryPersistenceStore()),
      clock: new ManualClock(),
      logger: recordingLogger(),
      markdown: '',
      random: () => 0.5,
    });
    const net = createSimNet({ real, peers: 2 });
    try {
      net.insert(1, 0, '<p1:1>');
      net.deliverAll();
      net.delete(0, 1, 1);
      net.deliverAll();
      net.insert(1, 1, 'p');
      net.deliverAll();
      expect(net.peers[0]?.text.toJSON()).toBe('<p1:1>');
      assertUndoIsolation(net, 0);
      expect(net.peers[0]?.text.toJSON()).toBe('<pp1:1>');
    } finally {
      net.dispose();
      real.dispose();
    }
  });
});
