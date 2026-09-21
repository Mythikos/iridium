/** Restore is one atomic FIFO unit, including updates already applied after it was enqueued. */
import { decodeServerNoteMessage } from '@iridium/contracts';
import {
  applyV1,
  createNoteDoc,
  getContent,
  insertChunked,
  LOAD_ORIGIN,
  projectMarkdown,
  type TextDiff,
} from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../../audit/chain.ts';
import { CollabOwnershipLost } from '../owner-lease.ts';
import { RevisionContentRefused } from './errors.ts';
import { connectionOrigin, localOrigin } from './testing/fake-document.ts';
import {
  createHarness,
  HARNESS_ACTOR,
  HARNESS_USER,
  SECOND_USER,
  SESSION_A,
  SESSION_B,
  settle,
  type OpenedNote,
} from './testing/harness.ts';
import type { RestoreRequest } from './types.ts';

function request(
  note: OpenedNote,
  target: string,
  apply?: (diff: TextDiff) => void,
): RestoreRequest {
  const audit: AuditEventInput = {
    action: 'note.revision.restored',
    actorType: 'user',
    actorId: HARNESS_USER,
    actorDisplay: 'Restoring editor',
    credentialType: 'session',
    credentialId: SESSION_A,
    vaultId: note.vaultId,
    targetType: 'note',
    targetId: note.noteId,
    outcome: 'success',
    context: {},
  };
  return {
    document: note.document,
    target,
    revisionId: 1,
    actor: HARNESS_ACTOR,
    audit,
    apply:
      apply ??
      ((diff) => {
        note.document.transact(
          () => getContent(note.document).delete(diff.start, diff.deleteLength),
          localOrigin('restore', HARNESS_USER),
        );
        insertChunked(
          getContent(note.document),
          diff.start,
          diff.insert,
          localOrigin('restore', HARNESS_USER),
        );
      }),
  };
}

describe('collab.writer.restore.unit [area:collab] [hp:HP-2]', () => {
  it('captures later queued client edits at their actual pre-restore sequence and commits both checkpoints with the update', async () => {
    const harness = createHarness();
    const note = await harness.openNote({ markdown: 'prefix old suffix' });
    const first = note.document.addConnection({
      role: 'editor',
      userId: HARNESS_USER,
      sessionId: SESSION_A,
    });
    const second = note.document.addConnection({
      role: 'editor',
      userId: SECOND_USER,
      sessionId: SESSION_B,
    });
    const gate = harness.store.holdWrites();
    note.document.transact(
      () => getContent(note.document).insert(0, 'earlier '),
      connectionOrigin(first),
    );
    await settle();
    expect(gate.waiting).toBe(1);
    const restored = note.writer.enqueueRestore(request(note, 'prefix restored suffix'));
    note.document.transact(
      () => getContent(note.document).insert(0, 'later '),
      connectionOrigin(second),
    );
    const replaced = projectMarkdown(note.document);
    gate.release();
    const outcome = await restored;
    expect(outcome).toMatchObject({ changed: true, seq: 4 });
    const stored = harness.store.note(note.noteId);
    if (stored === undefined) throw new Error('The note must still exist.');
    const before = stored.revisions.find((row) => row.kind === 'pre_restore');
    const after = stored.revisions.find((row) => row.kind === 'restore');
    expect(before).toMatchObject({ seq: 3, markdown: replaced });
    expect(after).toMatchObject({
      seq: 4,
      markdown: 'prefix restored suffix',
      restoredFromRevisionId: 1,
    });
    const replay = createNoteDoc({ gc: true });
    for (const update of stored.updates) applyV1(replay, update.updateV1, LOAD_ORIGIN);
    expect(projectMarkdown(replay)).toBe(after?.markdown);
    replay.destroy();
    expect(stored.updates.map((row) => row.origin)).toEqual([
      'create',
      'connection',
      'connection',
      'restore',
    ]);
    expect(harness.store.audits).toHaveLength(1);
    expect(harness.store.audits[0]?.metadata).toMatchObject({
      revision: 4,
      preRestoreRevisionId: before?.id,
      revisionId: after?.id,
    });
    note.document.destroy();
  });

  it.each(['write', 'write-ack'] as const)(
    'retries a %s failure without a second edit, duplicate checkpoint or duplicate audit',
    async (failure) => {
      const harness = createHarness({ random: () => 0, compactionAwaitTimeoutMs: 15_000 });
      const note = await harness.openNote({ markdown: 'old' });
      harness.store.failNext({
        kind: failure,
        error: Object.assign(new Error('temporary database interruption'), { code: 'ECONNRESET' }),
      });
      const result = note.writer.enqueueRestore(request(note, 'new'));
      await settle(40);
      expect(note.writer.state).toBe('retrying');
      expect(projectMarkdown(note.document)).toBe('new');
      await harness.clock.advance(1000);
      expect(await result).toMatchObject({ changed: true, seq: 2 });
      const stored = harness.store.note(note.noteId);
      expect(stored?.updates).toHaveLength(2);
      expect(stored?.revisions.map((row) => row.kind)).toEqual([
        'create',
        'pre_restore',
        'restore',
      ]);
      expect(harness.store.audits).toHaveLength(1);
      const checkpoints = note.document.broadcasts.flatMap((payload) => {
        const parsed = decodeServerNoteMessage(payload);
        return parsed.ok && parsed.message.t === 'checkpoint' ? [parsed.message] : [];
      });
      expect(checkpoints.map((row) => row.kind)).toEqual(['pre_restore', 'restore']);
      note.document.destroy();
    },
  );

  it('keeps no-op restores revision-free and leaves an already committed head unchanged', async () => {
    const harness = createHarness();
    const note = await harness.openNote({ markdown: 'same' });
    const before = harness.store.counts.commits;
    const noop = await note.writer.enqueueRestore(request(note, 'same'));
    expect(noop).toMatchObject({ changed: false, seq: 1 });
    expect(harness.store.counts.commits).toBe(before);
    expect(harness.store.note(note.noteId)?.revisions.map((row) => row.kind)).toEqual(['create']);
    expect(harness.store.audits).toEqual([]);
    note.document.destroy();
  });

  it('commits a later queued prefix captured by a no-op without creating restore revisions', async () => {
    const harness = createHarness();
    const note = await harness.openNote({ markdown: 'same' });
    const first = note.document.addConnection({
      role: 'editor',
      userId: HARNESS_USER,
      sessionId: SESSION_A,
    });
    const second = note.document.addConnection({
      role: 'editor',
      userId: SECOND_USER,
      sessionId: SESSION_B,
    });
    const gate = harness.store.holdWrites();
    note.document.transact(
      () => getContent(note.document).insert(0, 'earlier '),
      connectionOrigin(first),
    );
    await settle();
    const result = note.writer.enqueueRestore(request(note, 'later earlier same'));
    note.document.transact(
      () => getContent(note.document).insert(0, 'later '),
      connectionOrigin(second),
    );
    gate.release();
    expect(await result).toMatchObject({ changed: false, seq: 3 });
    expect(harness.store.note(note.noteId)?.revisions.map((row) => row.kind)).toEqual(['create']);
    expect(harness.store.note(note.noteId)?.updates.map((row) => row.origin)).toEqual([
      'create',
      'connection',
      'connection',
    ]);
    expect(harness.store.audits).toEqual([]);
    note.document.destroy();
  });

  it('refuses invalid content and a retired owner before applying any edit', async () => {
    const harness = createHarness();
    const note = await harness.openNote({ markdown: 'safe' });
    note.writer.lockContentInvalid('cr');
    await expect(note.writer.enqueueRestore(request(note, 'changed'))).rejects.toBeInstanceOf(
      RevisionContentRefused,
    );
    expect(projectMarkdown(note.document)).toBe('safe');
    note.writer.fence();
    await expect(note.writer.enqueueRestore(request(note, 'changed'))).rejects.toBeInstanceOf(
      CollabOwnershipLost,
    );
    expect(harness.store.note(note.noteId)?.headSeq).toBe(1);
    note.document.destroy();
  });
});
