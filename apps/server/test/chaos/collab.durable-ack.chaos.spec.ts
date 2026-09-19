import { decodeServerNoteMessage } from '@iridium/contracts';
import { decodeStateVector, dominates, stateVector } from '@iridium/crdt';
import {
  connectToxiproxy,
  MYSQL_PROXY_NAME,
  workerSchemaName,
  FAULT,
  type NoteClient,
  type ToxicHandle,
} from '@iridium/testkit';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { describe, expect, inject, it } from 'vitest';

import { asStateVector } from '../../src/collab/persistence/testing/bytes.ts';
import {
  CRASH_ITERATIONS,
  FAULT_ITERATIONS,
  NIGHTLY_CHAOS,
  persistedCount,
  waitFault,
} from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

/** Recovery uses a new client before any old client is allowed to resend its unsaved updates. */
async function disconnectAll(clients: readonly NoteClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.disconnectSocket()));
}

describe('collab.durable-ack.chaos [hp:HP-1] [hp:HP-2]', () => {
  describe.each(['fault', 'kernel-signal'] as const)('kill after ack via %s', (method) => {
    it.each(Array.from({ length: CRASH_ITERATIONS }, (_, index) => index))(
      'recovers the actual acknowledged revision in kill iteration %i',
      async (iteration) => {
        const provided = inject('iridiumToxiproxy');
        const proxy = connectToxiproxy(provided.controlUrl).proxy(
          MYSQL_PROXY_NAME,
          provided.mysqlProxy.host,
          provided.mysqlProxy.port,
        );
        const harness = await startCollab({
          mode: 'child',
          db: {
            ...provided.mysqlProxy,
            schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1'),
          },
        });
        let toxic: ToxicHandle | undefined;
        try {
          await harness.server.waitReady();
          const cast = await harness.server.seed.kernel();
          const clients = await Promise.all(
            [cast.editorA, cast.editorB].map((user) =>
              harness.open(user, cast.note.id, { flushDelayMs: false }),
            ),
          );
          await expectConverged(harness, cast.note.id, clients);
          const editor = clients[iteration % clients.length];
          if (editor === undefined) throw new Error('The crash case needs its editor.');
          // Vary the committed prefix length without coupling shuffled Vitest cases to each other.
          for (let prefix = 0; prefix < iteration % 5; prefix++) {
            editor.marker(`prefix-${String(prefix)}`);
            // eslint-disable-next-line no-await-in-loop -- each prefix is independently committed before the fault
            await editor.waitFor('saved');
          }
          const before = await harness.committed(cast.note.id);
          if (NIGHTLY_CHAOS)
            toxic = await proxy.addToxic({
              type: 'latency',
              stream: 'upstream',
              attributes: { latency: 500 + ((iteration * 389) % 1501), jitter: 200 },
            });
          const kills: Promise<void>[] = [];
          const onAck = ({ payload }: { payload: string }): void => {
            const decoded = decodeServerNoteMessage(payload);
            if (
              decoded.ok &&
              decoded.message.t === 'persisted' &&
              decoded.message.seq > before.head &&
              kills.length === 0
            )
              kills.push(harness.server.kill('SIGKILL'));
          };
          if (method === 'fault') await harness.server.faults.arm(FAULT.storeKillAfterAck);
          else clients.forEach((client) => client.provider?.on('stateless', onAck));
          // The synchronous fault follows the first broadcast recipient, not necessarily the editor.
          const acknowledged = Promise.any(
            clients.map((client) => client.waitForAck(undefined, { timeoutMs: 30_000 })),
          );
          const marker = editor.marker(`durable-${String(iteration)}`);
          const editedVector = stateVector(editor.ydoc);
          const ack = await acknowledged;
          expect(ack.seq).toBeGreaterThan(before.head);
          expect(dominates(decodeStateVector(asStateVector(ack.sv)), editedVector)).toBe(true);
          clients.forEach((client) => client.provider?.off('stateless', onAck));
          await Promise.all(kills);
          await expect.poll(() => harness.server.lastExit).not.toBeNull();
          expect(harness.server.lastExit?.code).not.toBe(0);
          await disconnectAll(clients);
          const committed = await harness.committed(cast.note.id);
          expect(committed.head).toBe(ack.seq);
          expect(dominates(committed.sv, decodeStateVector(asStateVector(ack.sv)))).toBe(true);
          expect(committed.text.split(marker)).toHaveLength(2);
          const row = await harness.sql.rows(
            `SELECT HEX(sv_after) FROM ${harness.server.schema}.note_updates WHERE note_id=UNHEX('${cast.note.id.replaceAll('-', '')}') AND seq=${String(ack.seq)};`,
          );
          expect(row[0]?.[0]?.toLowerCase()).toBe(Buffer.from(ack.sv).toString('hex'));
          expect(
            await harness.sql.rows(
              `SELECT COUNT(*) FROM ${harness.server.schema}.note_revisions r JOIN ${harness.server.schema}.note_docs d ON d.note_id=r.note_id WHERE r.seq>d.head_seq;`,
            ),
          ).toEqual([['0']]);
          await toxic?.remove();
          toxic = undefined;
          await harness.server.restart();
          const fresh = await harness.open(cast.editorC, cast.note.id);
          await fresh.waitFor('saved');
          expect(fresh.text.toJSON()).toBe(committed.text);
          const baseline = fresh.stateless.find((message) => message.t === 'persisted');
          if (baseline?.t !== 'persisted')
            throw new Error('Fresh recovery requires its actual baseline.');
          expect(
            dominates(
              decodeStateVector(asStateVector(Buffer.from(baseline.sv, 'base64'))),
              decodeStateVector(asStateVector(ack.sv)),
            ),
          ).toBe(true);
          await fresh.close();
          await Promise.all(clients.map((client) => client.reconnectSocket()));
          await expectConverged(harness, cast.note.id, clients);
        } finally {
          await toxic?.remove();
          await harness.close();
        }
      },
      180_000,
    );
  });

  it.each([
    ...Array.from({ length: FAULT_ITERATIONS }, (_, iteration) => ({ delay: 3_000, iteration })),
    ...(NIGHTLY_CHAOS
      ? Array.from({ length: 200 }, (_, iteration) => ({ delay: 50, iteration }))
      : []),
  ])(
    'saved never precedes the real held COMMIT: $delay ms, iteration $iteration',
    async ({ delay, iteration }) => {
      const harness = await startCollab({ mode: 'child' });
      const observer = await createConnection(inject('iridiumMysql').rootUri);
      let unsubscribe: (() => void) | undefined;
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const editor = await harness.open(cast.editorA, cast.note.id, { flushDelayMs: false });
        await editor.waitFor('saved');
        const before = await harness.committed(cast.note.id);
        await observer.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
        const fault = await harness.server.faults.arm(FAULT.storeSlow, { arg: delay });
        let ackAt: number | null = null;
        let savedAt: number | null = null;
        let lastInvisibleAt = 0;
        let firstVisibleAt = 0;
        let absentAfterAck = false;
        let visibleVector = '';
        const provider = editor.provider;
        if (provider === null) throw new Error('The live provider must remain attached.');
        provider.on('stateless', ({ payload }: { payload: string }) => {
          const decoded = decodeServerNoteMessage(payload);
          if (decoded.ok && decoded.message.t === 'persisted' && decoded.message.seq > before.head)
            ackAt ??= performance.now();
        });
        const insertedAt = performance.now();
        unsubscribe = editor.session.subscribe(() => {
          if (editor.saveState === 'saved') savedAt ??= performance.now();
        });
        const visible = (async () => {
          await expect
            .poll(
              async () => {
                const began = performance.now();
                const [rows] = await observer.query<RowDataPacket[]>(
                  `SELECT HEX(sv_after) AS sv FROM ${harness.server.schema}.note_updates WHERE note_id=UNHEX(?) AND seq>? ORDER BY seq LIMIT 1`,
                  [cast.note.id.replaceAll('-', ''), before.head],
                );
                if (rows.length === 0) {
                  lastInvisibleAt = began;
                  absentAfterAck ||= ackAt !== null && ackAt < began;
                  return false;
                }
                firstVisibleAt = performance.now();
                visibleVector = String(rows[0]?.['sv']).toLowerCase();
                return true;
              },
              { timeout: delay + 10_000, interval: 10 },
            )
            .toBe(true);
        })();
        const nextAck = editor.waitForAck();
        editor.marker(`visibility-${String(iteration)}`);
        const [ack] = await Promise.all([nextAck, visible]);
        expect(ackAt).not.toBeNull();
        expect(savedAt).not.toBeNull();
        expect(ackAt ?? 0).toBeGreaterThanOrEqual(lastInvisibleAt);
        expect(savedAt ?? 0).toBeGreaterThanOrEqual(lastInvisibleAt);
        expect((ackAt ?? 0) - insertedAt).toBeGreaterThanOrEqual(delay);
        expect((savedAt ?? 0) - insertedAt).toBeGreaterThanOrEqual(delay);
        expect(firstVisibleAt - insertedAt).toBeGreaterThanOrEqual(delay);
        expect(absentAfterAck).toBe(false);
        expect(visibleVector).toBe(Buffer.from(ack.sv).toString('hex'));
        await fault.disarm();
        await expectConverged(harness, cast.note.id, [editor]);
      } finally {
        unsubscribe?.();
        await observer.end();
        await harness.close();
      }
    },
    60_000,
  );

  it.each(
    Array.from({ length: FAULT_ITERATIONS }, (_, iteration) => [
      { point: FAULT.storeCrashBeforeCommit, committedBeforeAck: false, iteration },
      { point: FAULT.storeCrashAfterCommitBeforeAck, committedBeforeAck: true, iteration },
    ]).flat(),
  )(
    'distinguishes rollback from committed recovery at $point, iteration $iteration',
    async ({ point, committedBeforeAck, iteration }) => {
      const harness = await startCollab({ mode: 'child' });
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const editor = await harness.open(cast.editorA, cast.note.id, { flushDelayMs: false });
        await editor.waitFor('saved');
        const before = await harness.committed(cast.note.id);
        const acknowledgements = persistedCount(editor);
        await harness.server.faults.arm(point);
        const marker = editor.marker(`unacked-${String(iteration)}`);
        // SIGKILL can discard the final piped log on Unix; observe the actual crash.
        await expect.poll(() => harness.server.lastExit, { timeout: 10_000 }).not.toBeNull();
        expect(harness.server.lastExit?.code).not.toBe(0);
        expect(harness.server.lastExit?.signal).toBe(
          process.platform === 'win32' ? null : 'SIGKILL',
        );
        await editor.disconnectSocket();
        expect(persistedCount(editor)).toBe(acknowledgements);
        const durable = await harness.committed(cast.note.id);
        expect(durable.text.includes(marker)).toBe(committedBeforeAck);
        expect(durable.head).toBe(before.head + (committedBeforeAck ? 1 : 0));
        await harness.server.restart();
        const fresh = await harness.open(cast.editorB, cast.note.id);
        await fresh.waitFor('saved');
        expect(fresh.text.toJSON()).toBe(durable.text);
        await editor.reconnectSocket();
        const recovered = await expectConverged(harness, cast.note.id, [editor, fresh]);
        expect(recovered.text.split(marker)).toHaveLength(2);
        await fresh.close();
      } finally {
        await harness.close();
      }
    },
    180_000,
  );

  it.each(Array.from({ length: FAULT_ITERATIONS }, (_, iteration) => iteration))(
    'keeps failures and delayed writes unsaved until commit and survives dropped ack: iteration %i',
    async (iteration) => {
      const harness = await startCollab({ mode: 'child' });
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const editor = await harness.open(cast.editorA, cast.note.id, { flushDelayMs: false });
        await editor.waitFor('saved');
        const failure = await harness.server.faults.arm(FAULT.storeThrow);
        const failed = editor.waitForStateless('persist-failed');
        const beforeCount = persistedCount(editor);
        const marker = editor.marker(`retry-${String(iteration)}`);
        expect((await failed).reason).toBe('db_error');
        expect(editor.saveState).not.toBe('saved');
        expect(persistedCount(editor)).toBe(beforeCount);
        expect((await harness.committed(cast.note.id)).text).not.toContain(marker);
        await failure.disarm();
        await expectConverged(harness, cast.note.id, [editor]);
        const slow = await harness.server.faults.arm(FAULT.storeSlow, { arg: 3_000 });
        const logStart = harness.logs.length;
        const slowMarker = editor.marker(`slow-${String(iteration)}`);
        await waitFault(harness, FAULT.storeSlow, logStart);
        expect(editor.saveState).not.toBe('saved');
        expect((await harness.committed(cast.note.id)).text).not.toContain(slowMarker);
        await slow.disarm();
        await expectConverged(harness, cast.note.id, [editor]);
        await harness.server.faults.arm(FAULT.wsDropAfterAck);
        const dropped = editor.waitClosed();
        const droppedMarker = editor.marker(`drop-${String(iteration)}`);
        await dropped;
        await editor.reconnectSocket();
        const recovered = await expectConverged(harness, cast.note.id, [editor]);
        expect(recovered.text.split(droppedMarker)).toHaveLength(2);
      } finally {
        await harness.close();
      }
    },
    180_000,
  );
});
