// oxlint-disable vitest/no-standalone-expect -- shared property assertions run in both test projects.
/** Scheduler-selected starts overlap actual MySQL operations, rather than only shuffling commands. */
import { dominates, projectMarkdown, stateVector } from '@iridium/crdt';
import type * as fc from 'fast-check';
import { expect } from 'vitest';

import { CompactionUnavailable } from '../errors.ts';
import { asStateVector } from './bytes.ts';
import { assertConverged } from './converge.ts';
import { INITIAL_MARKER } from './convergence-model.ts';
import {
  assertCoalescingPreservesSemantics,
  assertStoreInvariants,
  initialModel,
  type ModelReal,
} from './model.ts';
import { createSimNet } from './sim-net.ts';

export async function runScheduledPersistence(
  scheduler: fc.Scheduler,
  edits: readonly string[],
  create: (markdown: string) => Promise<ModelReal>,
): Promise<void> {
  const real = await create(`${INITIAL_MARKER} scheduled note\n`);
  const initialClientIds = [...real.document.store.clients.keys()];
  const net = createSimNet({ real, peers: 2 });
  const markers = edits.map((_text, index) => `⟦scheduled:${String(index)}⟧`);
  let crashing = false;
  const start = async (label: string): Promise<void> => {
    await scheduler.schedule(Promise.resolve(), label);
  };
  try {
    const enqueue = async (): Promise<void> => {
      for (const [index, text] of edits.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each client's ordered editing stream
        await start(`Enqueue ${String(index)}`);
        const peer = index % 2;
        net.insert(peer, 0, `${text}${markers[index] ?? ''}`);
        if (!crashing) net.deliverOne(peer);
      }
    };
    const compact = async (): Promise<void> => {
      await start('Compact');
      try {
        await net.compact();
      } catch (error) {
        // A process crash may dispose an outstanding flush. No other rejection is legitimate.
        if (!(error instanceof CompactionUnavailable) || error.writerState !== 'disposed')
          throw error;
      }
    };
    const load = async (): Promise<void> => {
      await start('Load');
      const before = await real.view();
      const doc = await real.loadFresh();
      try {
        for (const row of before.updates) {
          expect(
            dominates(stateVector(doc), asStateVector(row.svAfter)),
            'a racing load includes committed rows',
          ).toBe(true);
        }
      } finally {
        doc.destroy();
      }
    };
    const crash = async (): Promise<void> => {
      await start('Crash');
      crashing = true;
      try {
        await net.restartServer();
      } finally {
        crashing = false;
      }
    };
    const disconnect = async (): Promise<void> => {
      await start('Disconnect');
      net.disconnect(0);
      await start('Reconnect');
      // The final protocol exchange also covers a reconnect during the server's load interval.
      if (!crashing) net.reconnect(0);
    };
    // waitFor also sees work that a real DB completion schedules later; waitAll then proves no
    // generated task remains. A bare waitAll can return early across externally resolved I/O.
    await scheduler.waitFor(Promise.all([enqueue(), compact(), load(), crash(), disconnect()]));
    await scheduler.waitAll();
    for (const peer of net.peers) net.reconnect(peer.id);
    net.deliverAll();
    await net.persist();
    await net.compact();
    const text = projectMarkdown(real.document);
    for (const marker of markers) expect(text.split(marker)).toHaveLength(2);
    const model = initialModel(text);
    assertStoreInvariants(await real.view(), model, real);
    await assertCoalescingPreservesSemantics(real);
    await assertConverged({
      net,
      real,
      markerTags: ['scheduled'],
      initialMarker: INITIAL_MARKER,
      initialClientIds,
      headSeen: 1,
    });
  } finally {
    net.dispose();
    real.dispose();
  }
}
