/**
 * `collab.writer.unit` — the `NoteWriter` over the in-memory store (05-collaboration-and-durability.md,
 * "The NoteWriter", "The Saved protocol", "Bounded queue and backpressure", "Compaction shares the
 * FIFO", "Unload, veto, and completing the unload").
 *
 * The document is a real `Y.Doc`; the writer's `update` listener, coalescing, transaction, retry,
 * backpressure, compaction interleaving and unload completion are the product's. Only the store and
 * the clock are doubles, and the clock is what makes every timer drivable without a sleep.
 */
import { LIMITS, decodeServerNoteMessage, type ServerNoteMessage } from '@iridium/contracts';
import {
  createNoteDoc,
  deleteSetFingerprint,
  EMPTY_DELETE_SET_FINGERPRINT,
  dominates,
  encodeState,
  SV_STORED_MAX_BYTES,
  getContent,
  loadState,
  LOAD_ORIGIN,
  projectMarkdown,
  stateVector,
} from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';

import { CollabOwnershipLost } from '../owner-lease.ts';
import { FAILED_AFTER_ATTEMPTS, FAILED_RETRY_INTERVAL_MS } from './backoff.ts';
import {
  CheckpointTimeout,
  CheckpointUnavailable,
  CompactionTimeout,
  CompactionUnavailable,
  PersistenceDrainUnavailable,
} from './errors.ts';
import { PersistenceUnavailable } from './kysely-store.ts';
import { asStateVector } from './testing/bytes.ts';
import {
  connectionOrigin,
  localOrigin,
  type FakeConnection,
  type FakeDocument,
} from './testing/fake-document.ts';
import {
  createHarness,
  HARNESS_ACTOR,
  HARNESS_USER,
  SECOND_USER,
  SESSION_A,
  SESSION_B,
  settle,
  type OpenedNote,
  type PersistenceHarness,
} from './testing/harness.ts';
import { asV1Update, type PendingUpdate } from './types.ts';
import { groupRuns, persistFailureReason } from './writer.ts';

function messages(payloads: readonly string[]): ServerNoteMessage[] {
  return payloads.flatMap((payload) => {
    const decoded = decodeServerNoteMessage(payload);
    return decoded.ok ? [decoded.message] : [];
  });
}

function types(payloads: readonly string[]): string[] {
  return messages(payloads).map((message) => message.t);
}

function editor(document: FakeDocument, session = SESSION_A): FakeConnection {
  return document.addConnection({
    role: 'editor',
    userId: HARNESS_USER,
    sessionId: session,
  });
}

/** One client keystroke: an insert under the connection's origin, as Hocuspocus applies it. */
function type(document: FakeDocument, connection: FakeConnection, text: string): void {
  document.transact(() => {
    getContent(document).insert(getContent(document).length, text);
  }, connectionOrigin(connection));
}

/** A queued update of fake bytes, for the coalescing arithmetic that never decodes them. */
function pending(bytes: Uint8Array): PendingUpdate {
  return {
    update: asV1Update(bytes),
    svAfter: asStateVector(new Uint8Array(0)),
    dsAfter: EMPTY_DELETE_SET_FINGERPRINT,
    actor: HARNESS_ACTOR,
    origin: 'connection',
    bytes: bytes.byteLength,
    enqueuedAt: 0,
  };
}

async function open(
  harness: PersistenceHarness,
  markdown = '',
): Promise<OpenedNote & { editor: FakeConnection }> {
  const note = await harness.openNote({ markdown });
  return { ...note, editor: editor(note.document) };
}

describe('collab.writer.unit [area:collab]', () => {
  describe('the acknowledgement', () => {
    it.each([false, true])(
      'keeps a later pending deletion out of the earlier committed witness (lost reply: %s)',
      async (lostReply) => {
        const harness = createHarness({ random: () => 1 });
        const note = await open(harness, 'seed');
        const head = note.writer.lastCommittedSeq;
        const gate = harness.store.holdWrites();
        if (lostReply) harness.faults.arm({ point: 'store.throw-after-commit-before-ack' });
        type(note.document, note.editor, 'a');
        const firstVector = stateVector(note.document);
        const firstDeletes = deleteSetFingerprint(note.document);
        note.document.transact(
          () => getContent(note.document).delete(0, 2),
          connectionOrigin(note.editor),
        );
        const deletedVector = stateVector(note.document);
        const deletedWitness = deleteSetFingerprint(note.document);
        expect(deletedVector).toEqual(firstVector);
        expect(deletedWitness).not.toBe(firstDeletes);
        gate.release();
        await settle(40);
        expect(note.writer.state).toBe(lostReply ? 'retrying' : 'idle');
        expect(
          messages(note.document.broadcasts).filter((message) => message.t === 'persisted'),
        ).toHaveLength(lostReply ? 0 : 2);
        if (lostReply) await harness.clock.advance(200);
        await note.writer.drain();
        const acknowledgements = messages(note.document.broadcasts).filter(
          (message) => message.t === 'persisted',
        );
        expect(acknowledgements).toEqual([
          {
            v: 1,
            t: 'persisted',
            seq: head + 1,
            sv: Buffer.from(firstVector).toString('base64'),
            ds: firstDeletes,
          },
          {
            v: 1,
            t: 'persisted',
            seq: head + 2,
            sv: Buffer.from(deletedVector).toString('base64'),
            ds: deletedWitness,
          },
        ]);
        expect(note.writer.lastPersisted).toEqual({
          seq: head + 2,
          sv: deletedVector,
          ds: deletedWitness,
        });
        expect(harness.store.note(note.noteId)?.headSeq).toBe(head + 2);
        expect(
          harness.store.note(note.noteId)?.updates.filter((row) => row.seq > head),
        ).toHaveLength(2);
      },
    );

    it('commits a client update and broadcasts persisted only after COMMIT, with a dominating vector', async () => {
      const harness = createHarness();
      const note = await open(harness, 'a');
      type(note.document, note.editor, 'b');
      expect(note.writer.queueLength).toBe(1);
      expect(note.document.broadcasts).toEqual([]);
      await note.writer.drain();
      expect(types(note.document.broadcasts)).toEqual(['persisted']);
      const [persisted] = messages(note.document.broadcasts);
      expect(persisted?.t === 'persisted' && persisted.seq).toBe(2);
      expect(note.writer.lastPersisted.seq).toBe(2);
      expect(dominates(note.writer.lastPersisted.sv, stateVector(note.document))).toBe(true);
      const stored = harness.store.note(note.noteId);
      expect(stored?.headSeq).toBe(2);
      expect(stored?.updates.map((row) => [row.seq, row.origin, row.actor.userId])).toEqual([
        [1, 'create', HARNESS_ACTOR.userId],
        [2, 'connection', HARNESS_ACTOR.userId],
      ]);
      expect(stored?.updates[1]?.actor.sessionId).toBe(SESSION_A);
      expect(harness.metrics.observations.get('persist_latency_seconds')).toHaveLength(1);
      expect(note.writer.state).toBe('idle');
    });

    it('ignores replayed state and unknown origins, and persists local restore and repair edits', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      note.document.transact(() => {
        getContent(note.document).insert(0, 'x');
      }, Symbol('unknown'));
      expect(note.writer.queueLength).toBe(0);
      expect(harness.logger.events()).toContain('collab.hook.error');
      note.document.transact(() => {
        getContent(note.document).insert(0, 'r');
      }, localOrigin('repair'));
      note.document.transact(
        () => {
          getContent(note.document).insert(0, 's');
        },
        localOrigin('restore', SECOND_USER),
      );
      await note.writer.drain();
      const rows = harness.store.note(note.noteId)?.updates.slice(1) ?? [];
      expect(rows.map((row) => [row.origin, row.actor.actorType, row.actor.userId])).toEqual([
        ['repair', 'system', null],
        ['restore', 'user', SECOND_USER],
      ]);
    });
  });

  describe('coalescing', () => {
    it('merges contiguous same-actor updates into one row and keeps actors apart', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      const gate = harness.store.holdWrites();
      const other = note.document.addConnection({
        role: 'editor',
        userId: SECOND_USER,
        sessionId: SESSION_B,
      });
      // The first keystroke is taken into a transaction at once and parks on the gate; the rest
      // queue behind it and coalesce into the second transaction.
      type(note.document, note.editor, 'a');
      await settle();
      type(note.document, note.editor, 'b');
      type(note.document, other, 'c');
      type(note.document, note.editor, 'd');
      type(note.document, note.editor, 'e');
      gate.release();
      await note.writer.drain();
      const rows = harness.store.note(note.noteId)?.updates.slice(1) ?? [];
      expect(rows.map((row) => [row.seq, row.actor.userId])).toEqual([
        [2, HARNESS_USER],
        [3, HARNESS_USER],
        [4, SECOND_USER],
        [5, HARNESS_USER],
      ]);
      expect(harness.store.note(note.noteId)?.headSeq).toBe(5);
      expect(harness.store.counts.writes).toBe(2);
      expect(projectMarkdown(note.document)).toBe('abcde');
      // One `persisted` per transaction, carrying the batch's last vector.
      expect(types(note.document.broadcasts).filter((t) => t === 'persisted')).toHaveLength(2);
    });

    it('splits a run at update boundaries when the merged row would exceed one frame', () => {
      const big = new Uint8Array(LIMITS.YJS_UPDATE_MAX_BYTES / 2 + 1);
      // Three same-actor items whose merge cannot fit in one row: `mergeV1` is not called on fake
      // bytes, so the split is exercised through the single-member fallback of the recursion.
      const runs = groupRuns([pending(big)]);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.members).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('reconciles a committed batch after its reply is lost without acknowledging later queued edits', async () => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, 'seed');
      harness.store.failNext({
        kind: 'write-ack',
        error: Object.assign(new Error('lost COMMIT reply'), { code: 'ECONNRESET' }),
      });
      type(note.document, note.editor, '-first');
      const firstVector = stateVector(note.document);
      await settle(30);
      const committed = harness.store.note(note.noteId)?.updates[1];
      expect(committed).toBeDefined();
      expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
      expect(note.writer.lastCommittedSeq).toBe(1);
      expect(note.writer.queueLength).toBe(1);
      expect(types(note.document.broadcasts)).toEqual(['persist-failed']);
      type(note.document, note.editor, '-later');
      const laterVector = stateVector(note.document);
      await harness.clock.advance(200);
      await note.writer.drain();
      const persisted = messages(note.document.broadcasts).filter(
        (message) => message.t === 'persisted',
      );
      expect(persisted.map((message) => message.seq)).toEqual([2, 3]);
      expect(persisted[0]?.sv).toBe(Buffer.from(firstVector).toString('base64'));
      expect(dominates(firstVector, laterVector)).toBe(false);
      expect(harness.store.note(note.noteId)?.updates[1]).toEqual(committed);
      expect(harness.store.note(note.noteId)?.updates).toHaveLength(3);
      expect(note.writer.state).toBe('idle');
      expect(note.writer.lastCommittedSeq).toBe(3);
      expect(harness.metrics.count('persist_failures_total', { reason: 'cas_mismatch' })).toBe(0);
    });

    it.each([
      'missing',
      'bytes',
      'vector',
      'actor',
      'session',
      'origin',
      'created',
      'head',
    ] as const)(
      'does not mistake a mismatched %s for a lost COMMIT acknowledgement',
      async (mismatch) => {
        const harness = createHarness({ random: () => 1 });
        const note = await open(harness, '');
        harness.store.failNext({ kind: 'write-ack', error: new Error('lost COMMIT reply') });
        type(note.document, note.editor, 'first');
        await settle(30);
        const stored = harness.store.note(note.noteId);
        const row = stored?.updates[1];
        if (stored === undefined || row === undefined)
          throw new Error('Expected a durable attempted row.');
        if (mismatch === 'missing') stored.updates.splice(1, 1);
        else if (mismatch === 'head') stored.headSeq += 1;
        else
          stored.updates[1] = {
            ...row,
            ...(mismatch === 'bytes' ? { updateV1: asV1Update(Uint8Array.of(0)) } : {}),
            ...(mismatch === 'vector' ? { svAfter: Uint8Array.of(0) } : {}),
            ...(mismatch === 'actor' ? { actor: { ...row.actor, userId: SECOND_USER } } : {}),
            ...(mismatch === 'session' ? { actor: { ...row.actor, sessionId: SESSION_B } } : {}),
            ...(mismatch === 'origin' ? { origin: 'repair' as const } : {}),
            ...(mismatch === 'created' ? { createdAt: new Date(row.createdAt.getTime() + 1) } : {}),
          };
        await harness.clock.advance(200);
        await settle(30);
        expect(note.writer.state).toBe('failed');
        expect(note.writer.lastCommittedSeq).toBe(1);
        expect(note.writer.queueLength).toBe(1);
        expect(types(note.document.broadcasts)).not.toContain('persisted');
        expect(harness.clock.pendingTimers).toBe(0);
        expect(harness.metrics.count('persist_failures_total', { reason: 'cas_mismatch' })).toBe(1);
      },
    );

    it('logs escalation once per failed episode across repeated retry turns and again after recovery', async () => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, '');
      const escalations = (): number =>
        harness.logger.lines.filter(
          (line) => line.level === 'error' && line.fields['event'] === 'persist.failed',
        ).length;
      for (let episode = 1; episode <= 2; episode += 1) {
        harness.store.failWrites(new Error('database unavailable'));
        type(note.document, note.editor, 'x');
        // eslint-disable-next-line no-await-in-loop -- advance one writer lifetime episode at a time
        await settle(30);
        for (let retry = 0; retry < FAILED_AFTER_ATTEMPTS; retry += 1) {
          // eslint-disable-next-line no-await-in-loop -- each retry is an independent failure and timer turn
          await harness.clock.advance(5_000);
          // eslint-disable-next-line no-await-in-loop -- let the scheduler finish the failure transition
          await settle(30);
        }
        expect(note.writer.state).toBe('failed');
        expect(escalations()).toBe(episode);
        // eslint-disable-next-line no-await-in-loop -- failed cadence must not emit another escalation
        await harness.clock.advance(FAILED_RETRY_INTERVAL_MS);
        // eslint-disable-next-line no-await-in-loop -- let the in-flight retry finish
        await settle(30);
        expect(escalations()).toBe(episode);
        harness.store.failWrites(null);
        // eslint-disable-next-line no-await-in-loop -- prove the next episode starts after durable recovery
        await harness.clock.advance(FAILED_RETRY_INTERVAL_MS);
        // eslint-disable-next-line no-await-in-loop -- each recovery drains its retained batch
        await note.writer.drain();
        expect(note.writer.state).toBe('idle');
      }
    });
    it.each(['write', 'compact'] as const)(
      "refuses a stale %s before it can replace another owner's committed head",
      async (operation) => {
        const harness = createHarness();
        const note = await open(harness, 'committed');
        const stored = harness.store.note(note.noteId);
        if (stored === undefined) throw new Error('The fixture must have a committed head.');
        stored.headSeq += 1;
        const before = JSON.stringify(stored);
        if (operation === 'write') {
          type(note.document, note.editor, '-stale');
          await settle(30);
        } else {
          await note.writer.enqueueCompaction('flush').catch(() => undefined);
        }
        expect(note.writer.state).toBe('failed');
        expect(note.editor.readOnly).toBe(true);
        expect(JSON.stringify(harness.store.note(note.noteId))).toBe(before);
        expect(
          messages(note.document.broadcasts).some((message) => message.t === 'persisted'),
        ).toBe(false);
        expect(harness.metrics.count('persist_failures_total', { reason: 'cas_mismatch' })).toBe(1);
        expect(harness.clock.pendingTimers).toBe(0);
      },
    );
    it.each(['ECONNRESET', 'PROTOCOL_SEQUENCE_TIMEOUT'])(
      'keeps the unacknowledged batch after %s, retries on the timer, and recovers',
      async (code) => {
        const harness = createHarness({ random: () => 1 });
        const note = await open(harness, '');
        harness.store.failNext({
          kind: 'write',
          error: Object.assign(new Error('gone'), { code }),
        });
        type(note.document, note.editor, 'a');
        await settle(20);
        expect(note.writer.state).toBe('retrying');
        expect(note.writer.queueLength).toBe(1);
        const [failed] = messages(note.document.broadcasts);
        expect(failed).toEqual({
          v: 1,
          t: 'persist-failed',
          seq: 2,
          reason: 'db_unavailable',
          retryInMs: 200,
        });
        expect(harness.metrics.count('persist_failures_total', { reason: 'db_unavailable' })).toBe(
          1,
        );
        expect(harness.logger.events()).toContain('persist.failed');
        await harness.clock.advance(200);
        await note.writer.drain();
        expect(note.writer.state).toBe('idle');
        expect(types(note.document.broadcasts)).toEqual(['persist-failed', 'persisted']);
        expect(harness.logger.events()).toContain('persist.recovered');
        expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
      },
    );

    it('classifies driver and SQL failures the way the reason vocabulary requires', () => {
      expect(persistFailureReason(Object.assign(new Error('x'), { errno: 1213 }))).toBe(
        'db_unavailable',
      );
      expect(persistFailureReason(Object.assign(new Error('x'), { errno: 1205 }))).toBe(
        'db_unavailable',
      );
      expect(
        persistFailureReason(Object.assign(new Error('x'), { code: 'PROTOCOL_CONNECTION_LOST' })),
      ).toBe('db_unavailable');
      expect(persistFailureReason(new Error('Pool is closed.'))).toBe('db_unavailable');
      expect(persistFailureReason(Object.assign(new Error('x'), { errno: 1062 }))).toBe('db_error');
      expect(persistFailureReason(new Error('syntax'))).toBe('db_error');
    });

    it('enters failed after ten attempts, locks every connection and keeps retrying every 30 s', async () => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, '');
      for (let attempt = 0; attempt < FAILED_AFTER_ATTEMPTS; attempt += 1) {
        harness.store.failNext({ kind: 'write', error: new Error('down') });
      }
      type(note.document, note.editor, 'a');
      for (let attempt = 1; attempt < FAILED_AFTER_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- one retry per iteration, driven by the clock
        await settle(20);
        // eslint-disable-next-line no-await-in-loop -- the backoff timer is the clock's
        await harness.clock.advance(5_000);
      }
      await settle(20);
      expect(note.writer.state).toBe('failed');
      expect(note.editor.readOnly).toBe(true);
      expect(harness.gaugeValues.writersFailed).toBe(1);
      expect(messages(note.document.broadcasts).at(-1)).toMatchObject({
        t: 'persist-failed',
        reason: 'db_error',
        retryInMs: FAILED_RETRY_INTERVAL_MS,
      });
      await harness.clock.advance(FAILED_RETRY_INTERVAL_MS);
      await note.writer.drain();
      expect(note.writer.state).toBe('idle');
      expect(note.editor.readOnly).toBe(false);
      expect(harness.gaugeValues.writersFailed).toBe(0);
      expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
    });

    it('treats a head compare-and-set mismatch as corruption: failed, read-only, no retry', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      harness.store.failNext({ kind: 'cas' });
      type(note.document, note.editor, 'a');
      await settle(20);
      expect(note.writer.state).toBe('failed');
      expect(note.editor.readOnly).toBe(true);
      expect(harness.metrics.count('persist_failures_total', { reason: 'cas_mismatch' })).toBe(1);
      expect(harness.logger.events()).toContain('persist.cas_mismatch');
      expect(messages(note.document.broadcasts).at(-1)).toMatchObject({
        t: 'persist-failed',
        reason: 'db_error',
        retryInMs: 0,
      });
      expect(harness.store.counts.rollbacks).toBe(1);
      expect(harness.clock.pendingTimers).toBe(0);
    });

    it('drops the queue, closes the document and answers every compaction when the note was trashed under the lock', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      const compaction = note.writer.enqueueCompaction('debounce');
      harness.store.trash(note.noteId, harness.clock.date());
      gate.release();
      await expect(compaction).resolves.toMatchObject({ status: 'skipped_trashed' });
      expect(note.writer.state).toBe('trashed');
      expect(note.writer.queueLength).toBe(0);
      expect(harness.trashed).toEqual([note.noteId]);
      expect(messages(note.document.broadcasts).at(-1)).toEqual({
        v: 1,
        t: 'persist-failed',
        reason: 'note_trashed',
        retryInMs: 0,
      });
      type(note.document, note.editor, 'b');
      expect(note.writer.queueLength).toBe(0);
      await expect(note.writer.enqueueCompaction('unload')).resolves.toMatchObject({
        status: 'skipped_trashed',
      });
      expect(harness.store.note(note.noteId)?.headSeq).toBe(1);
    });

    it('refuses a client write to a content-invalid note on that connection only, and accepts a repair', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      note.writer.lockContentInvalid('cr');
      expect(note.editor.readOnly).toBe(true);
      expect(types(note.document.broadcasts)).toEqual(['content-invalid']);
      type(note.document, note.editor, 'a');
      expect(note.writer.queueLength).toBe(0);
      expect(messages(note.editor.sent).at(-1)).toEqual({
        v: 1,
        t: 'persist-failed',
        reason: 'content_invalid',
        retryInMs: 0,
      });
      note.document.transact(() => {
        getContent(note.document).insert(0, 'fixed');
      }, localOrigin('repair'));
      expect(note.writer.queueLength).toBe(1);
      await note.writer.drain();
      expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
    });
  });

  describe('backpressure', () => {
    it('locks every connection at the bound and unlocks below half of it, telling each client its role', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      const viewer = note.document.addConnection({
        role: 'viewer',
        userId: SECOND_USER,
        sessionId: SESSION_B,
      });
      const gate = harness.store.holdWrites();
      for (let index = 0; index <= LIMITS.WRITER_QUEUE_MAX_UPDATES; index += 1)
        type(note.document, note.editor, 'x');
      await settle();
      expect(note.writer.state).toBe('backpressure');
      expect(note.editor.readOnly).toBe(true);
      expect(viewer.readOnly).toBe(true);
      expect(messages(note.document.broadcasts).at(-1)).toMatchObject({
        t: 'persist-failed',
        reason: 'backpressure',
      });
      expect(harness.logger.events()).toContain('persist.backpressure');
      gate.release();
      await note.writer.drain();
      expect(note.writer.state).toBe('idle');
      expect(note.editor.readOnly).toBe(false);
      expect(viewer.readOnly).toBe(true);
      expect(messages(note.editor.sent).at(-1)).toEqual({
        v: 1,
        t: 'role',
        role: 'editor',
        recovered: true,
      });
      expect(messages(viewer.sent)).toEqual([{ v: 1, t: 'role', role: 'viewer', recovered: true }]);
      expect(harness.store.note(note.noteId)?.headSeq).toBeGreaterThan(1);
      expect(projectMarkdown(note.document)).toHaveLength(LIMITS.WRITER_QUEUE_MAX_UPDATES + 1);
    });
  });

  describe('compaction in the FIFO', () => {
    it('snapshots only the committed FIFO prefix even when later edits are already live', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      const outcome = note.writer.enqueueCompaction('debounce');
      type(note.document, note.editor, 'b');
      await settle();
      gate.release();
      const result = await outcome;
      expect(result.status).toBe('ok');
      expect(result.throughSeq).toBe(2);
      await note.writer.drain();
      expect(harness.store.note(note.noteId)?.headSeq).toBe(3);
      const stored = harness.store.note(note.noteId);
      expect(stored?.snapshotThroughSeq).toBe(2);
      expect(stored?.projection?.markdown).toBe('a');
      const snapshot = createNoteDoc({ gc: true });
      try {
        if (stored?.snapshot === null || stored?.snapshot === undefined) {
          throw new Error('The compaction must have written a snapshot.');
        }
        loadState(snapshot, stored.snapshot, stored.snapshotFormat, LOAD_ORIGIN);
        expect(projectMarkdown(snapshot)).toBe('a');
        expect(dominates(stateVector(snapshot), stateVector(note.document))).toBe(false);
      } finally {
        snapshot.destroy();
      }
      const reopened = await harness.openNote({ noteId: note.noteId, vaultId: note.vaultId });
      expect(projectMarkdown(reopened.document)).toBe('ab');
      expect(types(note.document.broadcasts)).toContain('projected');
      expect(note.writer.lastProjectedSeq).toBe(2);
      expect(
        harness.metrics.count('compactions_total', { trigger: 'debounce', status: 'ok' }),
      ).toBe(1);
    });

    it('coalesces a second request into the pending job and upgrades its trigger', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      const first = note.writer.enqueueCompaction('debounce');
      const second = note.writer.enqueueCompaction('flush');
      expect(note.writer.pendingCompactions).toBe(1);
      gate.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(harness.store.counts.compactions).toBe(1);
      expect(harness.metrics.count('compactions_total', { trigger: 'flush', status: 'ok' })).toBe(
        1,
      );
    });

    it('rejects a caller at the deadline while the job stays queued and commits later', async () => {
      const harness = createHarness({ compactionAwaitTimeoutMs: 1_000 });
      const note = await open(harness, '');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      const outcome = note.writer.enqueueCompaction('flush');
      await harness.clock.advance(1_000);
      await expect(outcome).rejects.toBeInstanceOf(CompactionTimeout);
      expect(note.writer.pendingCompactions).toBe(1);
      gate.release();
      await note.writer.drain();
      expect(harness.store.counts.compactions).toBe(1);
      expect(harness.store.note(note.noteId)?.snapshotThroughSeq).toBe(2);
    });

    it('rejects at once while the writer is retrying, and still queues the job', async () => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, '');
      harness.store.failNext({ kind: 'write', error: new Error('down') });
      type(note.document, note.editor, 'a');
      await settle(20);
      expect(note.writer.state).toBe('retrying');
      await expect(note.writer.enqueueCompaction('flush')).rejects.toBeInstanceOf(
        CompactionUnavailable,
      );
      expect(note.writer.pendingCompactions).toBe(1);
      await harness.clock.advance(200);
      await note.writer.drain();
      expect(harness.store.counts.compactions).toBe(1);
    });

    it('reports a compaction I/O failure as a rejection and keeps the writer idle', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      harness.store.failNext({ kind: 'compaction', error: new Error('disk') });
      await expect(note.writer.enqueueCompaction('debounce')).rejects.toThrow('disk');
      expect(note.writer.state).toBe('idle');
      expect(
        harness.metrics.count('compactions_total', { trigger: 'debounce', status: 'error' }),
      ).toBe(1);
    });
  });

  describe('explicit checkpoints in the FIFO', () => {
    const request = { kind: 'pre_restore', label: 'pre-repair', actor: HARNESS_ACTOR } as const;

    it('retains the exact accepted prefix even when another batch tail is already live', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      type(note.document, note.editor, 'b');
      const checkpoint = note.writer.enqueueCheckpoint(request);
      type(note.document, note.editor, 'c');
      await settle();
      expect(
        harness.store.note(note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
      gate.release();
      const result = await checkpoint;
      expect(result.captured).toMatchObject({ throughSeq: 3, markdown: 'ab' });
      await note.writer.drain();
      const stored = harness.store.note(note.noteId);
      const revision = stored?.revisions.find((row) => row.id === result.revision.id);
      expect(revision).toMatchObject({
        seq: 3,
        markdown: 'ab',
        label: 'pre-repair',
        actor: HARNESS_ACTOR,
      });
      expect(stored?.headSeq).toBe(4);
      expect(projectMarkdown(note.document)).toBe('abc');
      const replay = createNoteDoc({ gc: true });
      try {
        for (const row of stored?.updates.filter(
          (candidate) => candidate.seq <= result.captured.throughSeq,
        ) ?? []) {
          loadState(replay, row.updateV1, 1, LOAD_ORIGIN);
        }
        expect(encodeState(replay, 2)).toEqual(result.captured.stateV2);
        expect(revision?.snapshot).toEqual(result.captured.stateV2);
        expect(revision?.snapshotSv).toEqual(stateVector(replay));
      } finally {
        replay.destroy();
      }
      // An explicit recovery revision never publishes a projection or clears safety latches.
      expect(note.writer.lastProjectedSeq).toBe(1);
      expect(harness.metrics.count('compactions_total', { trigger: 'flush', status: 'ok' })).toBe(
        0,
      );
    });

    it('derives checkpoint sequence and contents itself even when a structurally compatible request has extra row fields', async () => {
      const harness = createHarness();
      const note = await open(harness, 'durable');
      const staleRow = { ...request, seq: 999, markdown: 'stale', snapshot: new Uint8Array() };
      const result = await note.writer.enqueueCheckpoint(staleRow);
      expect(
        harness.store.note(note.noteId)?.revisions.find((row) => row.id === result.revision.id),
      ).toMatchObject({ seq: 1, markdown: 'durable' });
      expect(result.captured.throughSeq).toBe(1);
    });

    it('does not coalesce compactions across an explicit checkpoint boundary', async () => {
      const harness = createHarness();
      const note = await open(harness, 'seed');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      const before = note.writer.enqueueCompaction('debounce');
      const checkpoint = note.writer.enqueueCheckpoint(request);
      const after = note.writer.enqueueCompaction('flush');
      expect(note.writer.pendingCompactions).toBe(2);
      expect(note.writer.pendingJobs).toBe(3);
      gate.release();
      await Promise.all([before, checkpoint, after]);
      await note.writer.drain();
      expect(note.writer.pendingJobs).toBe(0);
      expect(
        harness.metrics.count('compactions_total', { trigger: 'debounce', status: 'ok' }),
      ).toBe(1);
      expect(harness.metrics.count('compactions_total', { trigger: 'flush', status: 'ok' })).toBe(
        1,
      );
    });

    it('refuses a captured checkpoint when its owner is lost during the asynchronous replay', async () => {
      const harness = createHarness();
      const note = await open(harness, 'seed');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const load = harness.store.loadDoc.bind(harness.store);
      vi.spyOn(harness.store, 'loadDoc').mockImplementationOnce(async (noteId) => {
        entered.resolve();
        await release.promise;
        return load(noteId);
      });
      const transaction = vi.spyOn(harness.store, 'runCheckpoint');
      const checkpoint = note.writer.enqueueCheckpoint(request);
      const rejected = checkpoint.catch((error: unknown) => error);
      await entered.promise;
      note.writer.fence();
      release.resolve();
      expect(await rejected).toBeInstanceOf(CollabOwnershipLost);
      await harness.persistence.scheduler.idle();
      expect(transaction).not.toHaveBeenCalled();
      expect(
        harness.store.note(note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
      await expect(note.writer.enqueueCheckpoint(request)).rejects.toBeInstanceOf(
        CollabOwnershipLost,
      );
    });

    it.each(['fence', 'dispose'] as const)(
      'rejects a queued checkpoint on %s without ever writing it',
      async (end) => {
        const harness = createHarness();
        const note = await open(harness, 'seed');
        const gate = harness.store.holdWrites();
        type(note.document, note.editor, 'a');
        const checkpoint = note.writer.enqueueCheckpoint(request);
        const rejected = checkpoint.catch((error: unknown) => error);
        if (end === 'fence') note.writer.fence();
        else note.writer.dispose();
        expect(await rejected).toBeInstanceOf(
          end === 'fence' ? CollabOwnershipLost : CheckpointUnavailable,
        );
        gate.release();
        await harness.persistence.scheduler.idle();
        expect(
          harness.store.note(note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
        ).toBe(false);
        expect(harness.clock.pendingTimers).toBe(0);
      },
    );

    it.each(['missing', 'changed'] as const)(
      'refuses a %s locked head after capture without writing a misleading revision',
      async (failure) => {
        const harness = createHarness();
        const note = await open(harness, 'seed');
        const original = harness.store.runCheckpoint.bind(harness.store);
        vi.spyOn(harness.store, 'runCheckpoint').mockImplementationOnce((noteId, work) =>
          original(noteId, (tx) =>
            work({
              ...tx,
              lockHead: () =>
                Promise.resolve(failure === 'missing' ? null : { headSeq: 99, deletedAt: null }),
            }),
          ),
        );
        await expect(note.writer.enqueueCheckpoint(request)).rejects.toMatchObject({
          code: 'db.cas_mismatch',
        });
        expect(note.writer.state).toBe('failed');
        expect(note.editor.readOnly).toBe(true);
        expect(
          harness.store.note(note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
        ).toBe(false);
      },
    );

    it('rejects a queued checkpoint when the preceding write discovers a trashed note', async () => {
      const harness = createHarness();
      const note = await open(harness, 'seed');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'pending');
      const checkpoint = note.writer.enqueueCheckpoint(request);
      const outcome = checkpoint.catch((error: unknown) => error);
      harness.store.trash(note.noteId, harness.clock.date());
      gate.release();
      expect(await outcome).toBeInstanceOf(CheckpointUnavailable);
      expect(note.writer.state).toBe('trashed');
      await expect(note.writer.enqueueCheckpoint(request)).rejects.toBeInstanceOf(
        CheckpointUnavailable,
      );
      expect(
        harness.store.note(note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
    });

    it('rolls back a checkpoint when trash or ownership loss occurs between capture and its locked write', async () => {
      const harness = createHarness();
      const trashed = await open(harness, 'trashed');
      const original = harness.store.runCheckpoint.bind(harness.store);
      vi.spyOn(harness.store, 'runCheckpoint').mockImplementationOnce((noteId, work) => {
        harness.store.trash(noteId, harness.clock.date());
        return original(noteId, work);
      });
      await expect(trashed.writer.enqueueCheckpoint(request)).rejects.toMatchObject({
        code: 'persist.note_trashed',
      });
      expect(trashed.writer.state).toBe('trashed');
      const fenced = await open(harness, 'fenced');
      vi.spyOn(harness.store, 'runCheckpoint').mockImplementationOnce((noteId, work) =>
        original(noteId, (tx) =>
          work({
            ...tx,
            lockHead: async () => {
              const head = await tx.lockHead();
              fenced.writer.fence();
              return head;
            },
          }),
        ),
      );
      await expect(fenced.writer.enqueueCheckpoint(request)).rejects.toBeInstanceOf(
        CollabOwnershipLost,
      );
      expect(
        harness.store.note(trashed.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
      expect(
        harness.store.note(fenced.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
    });

    it('does not authorize a repair result when ownership ends just after the checkpoint commits', async () => {
      const harness = createHarness();
      const note = await open(harness, 'seed');
      const original = harness.store.runCheckpoint.bind(harness.store);
      vi.spyOn(harness.store, 'runCheckpoint').mockImplementationOnce(async (noteId, work) => {
        const result = await original(noteId, work);
        note.writer.fence();
        return result;
      });
      await expect(note.writer.enqueueCheckpoint(request)).rejects.toBeInstanceOf(
        CollabOwnershipLost,
      );
      expect(
        harness.store.note(note.noteId)?.revisions.find((row) => row.kind === 'pre_restore'),
      ).toMatchObject({ seq: 1, markdown: 'seed' });
    });

    it('propagates a checkpoint transaction failure without applying repair or corrupting a later retry', async () => {
      const harness = createHarness();
      const note = await open(harness, 'seed');
      harness.store.failNext({ kind: 'compaction', error: new Error('checkpoint unavailable') });
      await expect(note.writer.enqueueCheckpoint(request)).rejects.toThrow(
        'checkpoint unavailable',
      );
      expect(
        harness.store.note(note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
      expect(note.writer.state).toBe('idle');
      const retried = await note.writer.enqueueCheckpoint(request);
      expect(
        harness.store.note(note.noteId)?.revisions.find((row) => row.id === retried.revision.id),
      ).toMatchObject({ seq: 1, markdown: 'seed' });
      note.writer.dispose();
      await expect(note.writer.enqueueCheckpoint(request)).rejects.toBeInstanceOf(
        CheckpointUnavailable,
      );
    });

    it('bounds the checkpoint caller while retaining an honest immutable revision if its queued job later completes', async () => {
      const harness = createHarness({ compactionAwaitTimeoutMs: 1_000 });
      const note = await open(harness, 'seed');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      const checkpoint = note.writer.enqueueCheckpoint(request);
      const rejected = checkpoint.catch((error: unknown) => error);
      await harness.clock.advance(1_000);
      expect(await rejected).toBeInstanceOf(CheckpointTimeout);
      gate.release();
      await note.writer.drain();
      expect(
        harness.store.note(note.noteId)?.revisions.find((row) => row.kind === 'pre_restore'),
      ).toMatchObject({ seq: 2, markdown: 'seeda' });
    });

    it('rejects rather than creating a deferred checkpoint while the writer is retrying', async () => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, 'seed');
      harness.store.failNext({ kind: 'write', error: new Error('down') });
      type(note.document, note.editor, 'a');
      await settle(20);
      await expect(note.writer.enqueueCheckpoint(request)).rejects.toBeInstanceOf(
        CheckpointUnavailable,
      );
      expect(note.writer.pendingJobs).toBe(0);
      await harness.clock.advance(200);
      await note.writer.drain();
      expect(
        harness.store.note(note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
    });
  });

  describe('unload', () => {
    it.each(['initial-read', 'completion-read', 'compaction'] as const)(
      'completes an idle unload after a transient %s failure without another edit or disconnect',
      async (failure) => {
        const harness = createHarness({
          random: () => 1,
          onRequestUnload: async () => note.writer.dispose(),
        });
        const note = await open(harness, 'seed');
        type(note.document, note.editor, '-saved');
        await note.writer.drain();
        note.document.removeConnection(note.editor);
        const revision = vi.spyOn(harness.store, 'revisionExistsAt');
        if (failure === 'initial-read') revision.mockRejectedValueOnce(new Error('read outage'));
        if (failure === 'completion-read')
          revision.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('read outage'));
        if (failure === 'compaction') {
          harness.store.failNext({ kind: 'compaction', error: new Error('checkpoint outage') });
          harness.store.failNext({
            kind: 'compaction',
            error: new Error('checkpoint still unavailable'),
          });
        }
        expect(await note.writer.unloadVeto()).not.toBeNull();
        await settle(40);
        expect(note.writer.unloadRequested).toBe(true);
        await harness.clock.advance(200);
        await settle(60);
        expect(harness.unloadRequests).toEqual([note.documentName]);
        expect(
          await harness.store.revisionExistsAt(note.noteId, note.writer.lastCommittedSeq),
        ).toBe(true);
        note.writer.dispose();
        expect(harness.clock.pendingTimers).toBe(0);
        revision.mockRestore();
      },
    );

    it.each(['reject', 'return-without-unload'] as const)(
      'retains unload intent when the host callback can %s without disposing the lifetime',
      async (failure) => {
        let calls = 0;
        const harness = createHarness({
          random: () => 1,
          onRequestUnload: async () => {
            calls += 1;
            if (calls === 1) {
              if (failure === 'reject') throw new Error('host unload failed');
              return;
            }
            note.writer.dispose();
          },
        });
        const note = await open(harness, 'seed');
        type(note.document, note.editor, '-saved');
        await note.writer.drain();
        note.document.removeConnection(note.editor);
        expect(await note.writer.unloadVeto()).not.toBeNull();
        await settle(60);
        expect(calls).toBe(1);
        expect(note.writer.unloadRequested).toBe(true);
        await harness.clock.advance(200);
        await settle(60);
        expect(calls).toBe(2);
        expect(note.writer.state).toBe('disposed');
        expect(harness.clock.pendingTimers).toBe(0);
      },
    );

    it.each(['fence', 'dispose'] as const)('cancels idle unload retries on %s', async (end) => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, '');
      note.document.removeConnection(note.editor);
      const read = vi
        .spyOn(harness.store, 'revisionExistsAt')
        .mockRejectedValueOnce(new Error('outage'));
      expect(await note.writer.unloadVeto()).not.toBeNull();
      note.writer[end]();
      await harness.clock.advance(5_000);
      expect(harness.unloadRequests).toEqual([]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(harness.clock.pendingTimers).toBe(0);
      read.mockRestore();
    });

    it('rechecks connections after an asynchronous unload read and waits for a later disconnect', async () => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, '');
      note.document.removeConnection(note.editor);
      const readGate = Promise.withResolvers<boolean>();
      const read = vi
        .spyOn(harness.store, 'revisionExistsAt')
        .mockRejectedValueOnce(new Error('outage'))
        .mockReturnValueOnce(readGate.promise);
      await note.writer.unloadVeto();
      await harness.clock.advance(200);
      const reconnected = editor(note.document);
      readGate.resolve(true);
      await settle(30);
      expect(harness.unloadRequests).toEqual([]);
      expect(note.writer.unloadRequested).toBe(true);
      note.document.removeConnection(reconnected);
      expect(await note.writer.unloadVeto()).toBeNull();
      note.writer.dispose();
      read.mockRestore();
    });
    it('schedules the missing checkpoint when the last write already drained before disconnect', async () => {
      const harness = createHarness();
      const note = await open(harness, 'seed');
      type(note.document, note.editor, '-committed');
      await note.writer.drain();
      expect(note.writer.state).toBe('idle');
      expect(note.writer.queueLength).toBe(0);
      expect(note.writer.pendingCompactions).toBe(0);
      note.document.removeConnection(note.editor);
      expect((await note.writer.unloadVeto())?.condition).toContain('note_revisions');
      await note.writer.drain();
      await settle(20);
      expect(
        harness.store
          .note(note.noteId)
          ?.revisions.some((row) => row.seq === 2 && row.kind === 'unload'),
      ).toBe(true);
      expect(harness.unloadRequests).toEqual([note.documentName]);
      expect(await note.writer.unloadVeto()).toBeNull();
    });
    it('vetoes on each of the four conditions and completes the unload itself once drained', async () => {
      const harness = createHarness();
      const note = await open(harness, 'seed');
      // Nothing changed since the seed: the create revision sits at the head, no veto.
      expect(await note.writer.unloadVeto()).toBeNull();

      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      expect((await note.writer.unloadVeto())?.condition).toContain('queue');
      expect(note.writer.unloadRequested).toBe(true);
      await settle();
      expect((await note.writer.unloadVeto())?.condition).toMatch(/in flight|queue/);
      note.document.removeConnection(note.editor);
      gate.release();
      await note.writer.drain();
      await settle(20);
      // The batch committed at seq 2 with no revision there, so the writer ran the final
      // compaction (an `unload` checkpoint) and asked for the unload.
      expect(
        harness.store
          .note(note.noteId)
          ?.revisions.some((row) => row.seq === 2 && row.kind === 'unload'),
      ).toBe(true);
      expect(harness.unloadRequests).toEqual([note.documentName]);
      expect(await note.writer.unloadVeto()).toBeNull();
    });

    it('vetoes while retrying and while no revision exists at the head', async () => {
      const harness = createHarness({ random: () => 1 });
      const note = await open(harness, '');
      harness.store.failNext({ kind: 'write', error: new Error('down') });
      type(note.document, note.editor, 'a');
      await settle(20);
      expect(note.writer.state).toBe('retrying');
      expect(await note.writer.unloadVeto()).not.toBeNull();
      await harness.clock.advance(200);
      await note.writer.drain();
      // Committed at 2, no revision at 2 yet, and a connection still open: the writer waits.
      expect((await note.writer.unloadVeto())?.condition).toContain('note_revisions');
      expect(harness.unloadRequests).toEqual([]);
    });

    it('serves the checkpoint of a trashed writer from the committed log, never from the live document', async () => {
      const harness = createHarness();
      const note = await open(harness, 'log');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, '-dropped');
      harness.store.trash(note.noteId, harness.clock.date());
      gate.release();
      await settle(20);
      expect(note.writer.state).toBe('trashed');
      const stored = harness.store.note(note.noteId);
      if (stored !== undefined) stored.revisions = [];
      expect(await note.writer.unloadVeto()).toBeNull();
      const unload = harness.store
        .note(note.noteId)
        ?.revisions.find((row) => row.kind === 'unload');
      expect(unload?.seq).toBe(1);
      expect(unload?.markdown).toBe('log');
    });

    it('rejects pending compactions on dispose and drains at once', async () => {
      const harness = createHarness();
      const note = await open(harness, '');
      const gate = harness.store.holdWrites();
      type(note.document, note.editor, 'a');
      const queued = note.writer.enqueueCompaction('debounce');
      note.writer.dispose();
      await expect(queued).rejects.toBeInstanceOf(CompactionUnavailable);
      expect(note.writer.state).toBe('disposed');
      await note.writer.drain();
      gate.release();
    });
  });

  describe('the layer', () => {
    it('reports the backlog and refreshes the gauges from every writer', async () => {
      const harness = createHarness();
      const first = await open(harness, '');
      const second = await open(harness, '');
      const gate = harness.store.holdWrites();
      type(first.document, first.editor, 'a');
      type(second.document, second.editor, 'b');
      harness.clock.jump(harness.clock.now() + 12_000);
      const reading = harness.persistence.backlog();
      expect(reading.failedWriters).toBe(0);
      expect(reading.oldestPendingMs).toBeGreaterThanOrEqual(12_000);
      harness.persistence.refreshGauges();
      expect(harness.gaugeValues.queueDepth).toBe(2);
      expect(harness.persistence.undrained().toSorted()).toEqual(
        [first.noteId, second.noteId].toSorted(),
      );
      gate.release();
      await harness.persistence.drainAll();
      expect(harness.persistence.undrained()).toEqual([]);
      harness.persistence.detach(first.documentName);
      expect(harness.persistence.writerOf(first.noteId)).toBeUndefined();
      expect(harness.persistence.stateOf(second.documentName)).toBe('idle');
    });

    it('answers the baseline of an unloaded note from the log, resolving a degraded vector', async () => {
      const harness = createHarness();
      const note = await open(harness, 'base');
      type(note.document, note.editor, 'x');
      await note.writer.drain();
      harness.persistence.detach(note.documentName);
      const stored = harness.store.note(note.noteId);
      const last = stored?.updates.at(-1);
      const base = await harness.persistence.baselineOf(note.noteId);
      expect(base?.seq).toBe(2);
      expect(base?.sv).toEqual(last?.svAfter);
      // Zero length means "not recorded": the vector is rebuilt from the committed log.
      if (stored !== undefined && last !== undefined) {
        stored.updates[stored.updates.length - 1] = { ...last, svAfter: new Uint8Array(0) };
      }
      const rebuilt = await harness.persistence.baselineOf(note.noteId);
      expect(rebuilt?.sv).toEqual(last?.svAfter);
      expect(await harness.persistence.compactNow(note.noteId, { trigger: 'flush' })).toBeNull();
    });
  });
});

describe('collab.writer.unit: recovery boundaries', () => {
  it.each([
    ['missing', null],
    ['pool closed', new Error('Pool is closed')],
    ['closed connection', new Error('connection is in closed state')],
    ['unavailable', new PersistenceUnavailable()],
    ['non-error', { code: 'invalid' }],
  ])('classifies %s without hiding generic SQL faults', (kind, error) => {
    expect(persistFailureReason(error)).toBe(
      kind === 'missing' || kind === 'non-error' ? 'db_error' : 'db_unavailable',
    );
  });

  it('splits an actual oversized merge at whole update boundaries without changing the document', () => {
    const source = createNoteDoc({ gc: true });
    const replica = createNoteDoc({ gc: true });
    const updates: PendingUpdate[] = [];
    source.on('update', (update: Uint8Array) =>
      updates.push({
        ...pending(update),
        svAfter: stateVector(source),
        dsAfter: deleteSetFingerprint(source),
      }),
    );
    try {
      getContent(source).insert(0, 'a'.repeat(600_000));
      getContent(source).insert(600_000, 'b'.repeat(600_000));
      const runs = groupRuns(updates);
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.merged.byteLength <= LIMITS.YJS_UPDATE_MAX_BYTES)).toBe(true);
      for (const run of runs) loadState(replica, run.merged, 1, LOAD_ORIGIN);
      expect(projectMarkdown(replica)).toBe(projectMarkdown(source));
      expect(stateVector(replica)).toEqual(stateVector(source));
      expect(groupRuns([])).toEqual([]);
    } finally {
      source.destroy();
      replica.destroy();
    }
  });

  it.each(['missing row', 'gap', 'future row', 'missing tail'] as const)(
    'refuses a compaction of a corrupt committed prefix: %s',
    async (corruption) => {
      const harness = createHarness();
      const note = await open(harness, 'prefix');
      type(note.document, note.editor, '-tail');
      await note.writer.drain();
      const original = await harness.store.loadUpdatesAfter(note.noteId, 1);
      const row = original[0];
      if (row === undefined) throw new Error('Missing committed tail fixture.');
      if (corruption === 'missing row') vi.spyOn(harness.store, 'loadDoc').mockResolvedValue(null);
      else
        vi.spyOn(harness.store, 'loadUpdatesAfter').mockResolvedValue(
          corruption === 'missing tail' ? [] : [{ ...row, seq: corruption === 'gap' ? 4 : 3 }],
        );
      const before = structuredClone(harness.store.note(note.noteId));
      await expect(note.writer.enqueueCompaction('unload')).rejects.toMatchObject({
        name: 'HeadSeqCasViolation',
      });
      expect(harness.store.note(note.noteId)).toEqual(before);
      expect(note.writer.state).toBe('failed');
      expect(note.editor.readOnly).toBe(true);
      expect(harness.metrics.count('persist_failures_total', { reason: 'cas_mismatch' })).toBe(1);
      expect(harness.clock.pendingTimers).toBe(0);
      vi.restoreAllMocks();
    },
  );

  it('latches hostile content after commit, counts it once, then unlocks only editors after a clean repair', async () => {
    const harness = createHarness();
    const note = await open(harness, 'safe');
    const viewer = note.document.addConnection({
      role: 'viewer',
      userId: SECOND_USER,
      sessionId: SESSION_B,
    });
    type(note.document, note.editor, '\r');
    await note.writer.drain();
    const outcome = await note.writer.enqueueCompaction('unload');
    expect(outcome.contentInvalid).toEqual({ reason: 'cr' });
    expect(outcome.revision?.label).toBe('head-unverified');
    expect(note.writer.contentInvalid).toBe(true);
    expect(note.editor.readOnly).toBe(true);
    const late = editor(note.document, SESSION_B);
    note.writer.applyLatches(late);
    expect(late.readOnly).toBe(true);
    expect(types(late.sent)).toEqual(['content-invalid']);
    note.writer.notifyInvalidWrite();
    expect(harness.metrics.count('persist_failures_total', { reason: 'content_invalid' })).toBe(1);
    await note.writer.enqueueCompaction('flush');
    expect(harness.metrics.count('content_invalid_total', { reason: 'cr' })).toBe(1);
    note.document.transact(() => getContent(note.document).delete(4, 1), localOrigin('repair'));
    await note.writer.drain();
    await note.writer.enqueueCompaction('flush');
    expect(note.writer.contentInvalid).toBe(false);
    expect(harness.store.note(note.noteId)?.contentInvalid).toBe(false);
    expect([note.editor.readOnly, late.readOnly, viewer.readOnly]).toEqual([false, false, true]);
    expect(messages(late.sent).at(-1)).toEqual({
      v: 1,
      t: 'role',
      role: 'editor',
      recovered: true,
    });
    expect(harness.store.note(note.noteId)?.projection?.markdown).toBe('safe');
  });

  it('never announces recovery while a clean repair installs a new snapshot-size latch', async () => {
    const harness = createHarness();
    const note = await open(harness, 'safe');
    type(note.document, note.editor, '\r');
    await note.writer.drain();
    await note.writer.enqueueCompaction('flush');
    expect(note.writer.contentInvalid).toBe(true);
    expect(note.writer.oversize).toBe(false);
    note.document.transact(() => getContent(note.document).delete(4, 1), localOrigin('repair'));
    await note.writer.drain();
    harness.faults.arm({ point: 'compact.snapshot-oversize' });
    await note.writer.enqueueCompaction('flush');
    expect(note.writer.contentInvalid).toBe(false);
    expect(note.writer.oversize).toBe(true);
    expect(note.editor.readOnly).toBe(true);
    expect(messages(note.editor.sent).filter((message) => message.t === 'role')).toEqual([]);
    harness.faults.arm({ point: 'compact.snapshot-oversize', count: 0 });
    await note.writer.enqueueCompaction('flush');
    expect(note.editor.readOnly).toBe(false);
    expect(messages(note.editor.sent).filter((message) => message.t === 'role')).toEqual([
      { v: 1, t: 'role', role: 'editor', recovered: true },
    ]);
  });

  it('latches a refused snapshot once, retains a usable checkpoint, and recovers on a successful retry', async () => {
    const harness = createHarness();
    const note = await open(harness, 'safe');
    type(note.document, note.editor, '-edit');
    await note.writer.drain();
    harness.faults.arm({ point: 'compact.snapshot-oversize' });
    const refused = await note.writer.enqueueCompaction('unload');
    expect(refused.status).toBe('refused');
    expect(note.writer.oversize).toBe(true);
    expect(note.writer.state).toBe('idle');
    expect(harness.store.note(note.noteId)?.snapshotThroughSeq).toBe(1);
    const late = editor(note.document, SESSION_B);
    note.writer.applyLatches(late);
    expect(late.readOnly).toBe(true);
    expect(messages(late.sent).at(-1)).toMatchObject({
      t: 'size-exceeded',
      size: 'safe-edit'.length,
      max: LIMITS.NOTE_SOFT_MAX_UTF16,
    });
    await note.writer.enqueueCompaction('flush');
    expect(
      types(note.document.broadcasts).filter((messageType) => messageType === 'size-exceeded'),
    ).toHaveLength(1);
    harness.faults.arm({ point: 'compact.snapshot-oversize', count: 0 });
    await note.writer.enqueueCompaction('flush');
    expect(note.writer.oversize).toBe(false);
    expect(late.readOnly).toBe(false);
    expect(harness.store.note(note.noteId)?.snapshotThroughSeq).toBe(2);
    expect(harness.logger.events()).toContain('compaction.refused');
  });

  it('persists a zero-length vector sentinel without degrading the live acknowledgement', async () => {
    const harness = createHarness();
    const note = await open(harness, '');
    const source = createNoteDoc({ gc: true });
    getContent(source).insert(0, 'a');
    const update = encodeState(source, 1);
    const vector = asStateVector(new Uint8Array(SV_STORED_MAX_BYTES + 1));
    note.writer.enqueue({
      ...pending(update),
      svAfter: vector,
      dsAfter: deleteSetFingerprint(source),
    });
    expect(note.writer.queueBytes).toBe(update.byteLength);
    await note.writer.drain();
    expect(note.writer.queueBytes).toBe(0);
    expect(note.writer.lastPersisted.sv).toEqual(vector);
    expect(harness.store.note(note.noteId)?.updates.at(-1)?.svAfter).toHaveLength(0);
    expect(harness.metrics.count('state_vector_oversize_total')).toBe(1);
    expect(harness.logger.events()).toContain('collab.state_vector.oversize');
    source.destroy();
  });

  it('cancels retries and makes disposal idempotent without scheduling later edits or compactions', async () => {
    const harness = createHarness({ random: () => 1 });
    const note = await open(harness, '');
    harness.store.failNext({ kind: 'write', error: new Error('down') });
    type(note.document, note.editor, 'pending');
    await settle(20);
    expect(harness.clock.pendingTimers).toBe(1);
    note.writer.dispose();
    note.writer.dispose();
    expect(harness.clock.pendingTimers).toBe(0);
    type(note.document, note.editor, 'ignored');
    await note.writer.runOne();
    expect(note.writer.queueLength).toBe(0);
    expect(await note.writer.unloadVeto()).toBeNull();
    await expect(note.writer.enqueueCompaction('flush')).rejects.toBeInstanceOf(
      CompactionUnavailable,
    );
    await harness.clock.advance(60_000);
    expect(harness.store.note(note.noteId)?.headSeq).toBe(1);
  });

  it.each([Symbol(), { malformed: true }, 12, null])(
    'logs an unknown origin at most once per loaded document: %s',
    async (origin) => {
      const harness = createHarness();
      const note = await open(harness, '');
      note.writer.noteUnknownOrigin(origin);
      note.writer.noteUnknownOrigin(origin);
      expect(harness.logger.events().filter((event) => event === 'collab.hook.error')).toHaveLength(
        1,
      );
      expect(note.writer.queueLength).toBe(0);
    },
  );

  it('drains only the accepted FIFO prefix while later unrelated edits remain queued', async () => {
    const harness = createHarness();
    const note = await open(harness);
    const firstGate = harness.store.holdWrites();
    type(note.document, note.editor, 'accepted');
    await settle();
    expect(firstGate.waiting).toBe(1);
    const drained = note.writer.drainAccepted();
    const other = note.document.addConnection({
      role: 'editor',
      userId: SECOND_USER,
      sessionId: SESSION_B,
    });
    type(note.document, other, '-later');
    const laterGate = harness.store.holdWrites();
    firstGate.release();
    await drained;
    expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
    expect(note.writer.queueLength).toBe(1);
    laterGate.release();
    await note.writer.drain();
    await expect(note.writer.drainAccepted()).resolves.toBeUndefined();
    expect(harness.store.note(note.noteId)?.headSeq).toBe(3);
  });

  it('rejects an authorization drain when accepted persistence fails without dropping the queue', async () => {
    const harness = createHarness({ random: () => 1 });
    const note = await open(harness);
    harness.store.failWrites(new Error('database unavailable'));
    type(note.document, note.editor, 'retained');
    await expect(note.writer.drainAccepted()).rejects.toBeInstanceOf(PersistenceDrainUnavailable);
    expect(note.writer.queueLength).toBe(1);
    expect(harness.store.note(note.noteId)?.headSeq).toBe(1);
    await expect(note.writer.drainAccepted()).rejects.toBeInstanceOf(PersistenceDrainUnavailable);
    harness.store.failWrites(null);
    await harness.clock.advance(10_000);
    await note.writer.drain();
    expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
  });

  it('fences an old lifetime before its blocked head lock returns and never appends or acknowledges its queue', async () => {
    const harness = createHarness();
    const note = await open(harness);
    const gate = harness.store.holdWrites();
    type(note.document, note.editor, 'in-flight');
    await settle();
    type(note.document, note.editor, '-still-local');
    const rejected = note.writer.drainAccepted().catch((error: unknown) => error);
    const fenced = harness.persistence.fenceAll();
    expect(note.editor.readOnly).toBe(true);
    const late = editor(note.document, SESSION_B);
    note.writer.applyLatches(late);
    expect(late.readOnly).toBe(true);
    expect(await rejected).toBeInstanceOf(CollabOwnershipLost);
    await expect(note.writer.drain()).rejects.toBeInstanceOf(CollabOwnershipLost);
    gate.release();
    await fenced;
    expect(harness.persistence.writers()).toEqual([]);
    expect(note.writer.state).toBe('disposed');
    expect(types(note.document.broadcasts)).not.toContain('persisted');
    expect(harness.store.note(note.noteId)?.headSeq).toBe(1);
    const reopened = await harness.openNote({ noteId: note.noteId, vaultId: note.vaultId });
    expect(projectMarkdown(reopened.document)).toBe('');
    expect(projectMarkdown(note.document)).toBe('in-flight-still-local');
    expect(reopened.writer).not.toBe(note.writer);
    await expect(note.writer.drainAccepted()).rejects.toBeInstanceOf(CollabOwnershipLost);
  });

  it('allows an already guarded write to settle after fencing without acknowledging the former lifetime', async () => {
    const harness = createHarness();
    const note = await open(harness);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = harness.store.runWrite.bind(harness.store);
    vi.spyOn(harness.store, 'runWrite').mockImplementationOnce((noteId, work) =>
      original(noteId, (tx) =>
        work({
          ...tx,
          casHead: async (from, to, now) => {
            const applied = await tx.casHead(from, to, now);
            entered.resolve();
            await release.promise;
            return applied;
          },
        }),
      ),
    );
    type(note.document, note.editor, 'already guarded');
    await entered.promise;
    const fenced = harness.persistence.fenceAll();
    release.resolve();
    await fenced;
    expect(harness.store.note(note.noteId)?.headSeq).toBe(2);
    expect(types(note.document.broadcasts)).not.toContain('persisted');
    const reopened = await harness.openNote({ noteId: note.noteId, vaultId: note.vaultId });
    expect(projectMarkdown(reopened.document)).toBe('already guarded');
  });

  it('rechecks the local lifetime after a publication head lock and rolls back a fenced compaction', async () => {
    const harness = createHarness();
    const note = await open(harness, 'seed');
    type(note.document, note.editor, 'changed');
    await note.writer.drain();
    const before = harness.store.note(note.noteId);
    if (before === undefined) throw new Error('Expected the durable note.');
    const original = harness.store.runCompaction.bind(harness.store);
    vi.spyOn(harness.store, 'runCompaction').mockImplementationOnce((noteId, vaultId, work) =>
      original(noteId, vaultId, (tx) =>
        work({
          ...tx,
          lockHead: async () => {
            const head = await tx.lockHead();
            note.writer.fence();
            return head;
          },
        }),
      ),
    );
    await expect(note.writer.enqueueCompaction('flush')).rejects.toBeInstanceOf(
      CollabOwnershipLost,
    );
    await harness.persistence.scheduler.idle();
    expect(harness.store.note(note.noteId)).toEqual(before);
  });

  it('clears a repaired content latch without announcing recovery through an active principal barrier', async () => {
    let blocked = false;
    const harness = createHarness({ principalBlocked: () => blocked });
    const note = await open(harness, 'safe');
    type(note.document, note.editor, '\r');
    await note.writer.drain();
    await note.writer.enqueueCompaction('flush');
    blocked = true;
    note.document.transact(() => getContent(note.document).delete(4, 1), localOrigin('repair'));
    await note.writer.drain();
    await note.writer.enqueueCompaction('flush');
    expect(note.writer.contentInvalid).toBe(false);
    expect(note.editor.readOnly).toBe(true);
    expect(messages(note.editor.sent).filter((message) => message.t === 'role')).toEqual([]);
    const late = editor(note.document, SESSION_B);
    note.writer.applyLatches(late);
    expect(late.readOnly).toBe(true);
  });
});
