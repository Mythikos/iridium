/** Repair checkpoint races over the real writer, CRDT, and deterministic store/clock ports. */
import { type Principal } from '@iridium/contracts';
import {
  createNoteDoc,
  getContent,
  insertChunked,
  loadState,
  LOAD_ORIGIN,
  projectMarkdown,
  sameDocumentState,
  stateVector,
  type NoteDoc,
} from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';

import { localOrigin } from '../collab/persistence/testing/fake-document.ts';
import { createHarness, settle } from '../collab/persistence/testing/harness.ts';
import type { StoredNote } from '../collab/persistence/testing/memory-store.ts';
import { contentHash } from '../projection/hash.ts';
import {
  PRE_REPAIR_LABEL,
  RepairContentChanged,
  repairContent,
  type RepairDeps,
} from './repair.ts';

const ACTOR: Principal = { kind: 'system', job: 'cli:doctor' };

async function scene() {
  const harness = createHarness();
  const note = await harness.openNote({ markdown: 'seed' });
  note.document.transact(
    () => getContent(note.document).insert(4, '\rbroken\r'),
    localOrigin('repair'),
  );
  await note.writer.drain();
  await note.writer.enqueueCompaction('flush');
  expect(note.writer.contentInvalid).toBe(true);
  const edit = {
    document: note.document,
    transact: vi.fn<(work: (doc: NoteDoc) => void) => Promise<void>>((work) => {
      note.document.transact(() => work(note.document), localOrigin('repair'));
      return Promise.resolve();
    }),
    insertChunked: vi.fn<(index: number, text: string) => void>((index, text) => {
      insertChunked(getContent(note.document), index, text, localOrigin('repair'));
    }),
    disconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
  const deps = {
    gateway: {
      openServerEdit: vi.fn<RepairDeps['gateway']['openServerEdit']>(() => Promise.resolve(edit)),
      vaultOf: () => note.vaultId,
    },
    persistence: harness.persistence,
    db: () => null,
    audit: {
      record: vi.fn<RepairDeps['audit']['record']>(() => {
        throw new Error('No audit transaction exists in this unit port.');
      }),
    },
    clock: harness.clock,
    logger: harness.logger,
  } satisfies RepairDeps;
  return { harness, note, edit, deps };
}

function assertExactRevision(note: StoredNote, revisionId: number, expected: string): void {
  const revision = note.revisions.find((row) => row.id === revisionId);
  if (revision?.snapshot === null || revision?.snapshot === undefined) {
    throw new Error('A pre-repair revision must retain its V2 snapshot.');
  }
  expect(revision).toMatchObject({
    kind: 'pre_restore',
    label: PRE_REPAIR_LABEL,
    markdown: expected,
  });
  expect(Buffer.from(revision.contentHash)).toEqual(contentHash(expected));
  const checkpoint = createNoteDoc({ gc: true });
  const replay = createNoteDoc({ gc: true });
  try {
    loadState(checkpoint, revision.snapshot, 2, LOAD_ORIGIN);
    for (const update of note.updates.filter((row) => row.seq <= revision.seq)) {
      loadState(replay, update.updateV1, 1, LOAD_ORIGIN);
    }
    expect(projectMarkdown(checkpoint)).toBe(expected);
    expect(projectMarkdown(replay)).toBe(expected);
    expect(sameDocumentState(checkpoint, replay)).toBe(true);
  } finally {
    checkpoint.destroy();
    replay.destroy();
  }
}

describe('notes.repair.unit [area:collab]', () => {
  it('waits for held accepted updates and checkpoints their exact durable sequence before repair', async () => {
    const s = await scene();
    const head = s.note.writer.lastCommittedSeq;
    const gate = s.harness.store.holdWrites();
    s.note.document.transact(
      () => getContent(s.note.document).insert(0, 'pending\r'),
      localOrigin('repair'),
    );
    const expected = projectMarkdown(s.note.document);
    const repair = repairContent(s.deps, s.note.noteId, { actor: ACTOR });
    try {
      await settle(40);
      expect(gate.waiting).toBe(1);
      expect(s.note.writer.pendingJobs).toBe(1);
      expect(s.edit.transact).not.toHaveBeenCalled();
      expect(
        s.harness.store.note(s.note.noteId)?.revisions.some((row) => row.kind === 'pre_restore'),
      ).toBe(false);
    } finally {
      gate.release();
    }
    const report = await repair;
    expect(report.outcome).toBe('repaired');
    expect(report.charsBefore).toBe(expected.length);
    const stored = s.harness.store.note(s.note.noteId);
    if (stored === undefined || report.preRepairRevisionId === null)
      throw new Error('Missing committed checkpoint.');
    expect(stored.revisions.find((row) => row.id === report.preRepairRevisionId)?.seq).toBe(
      head + 1,
    );
    assertExactRevision(stored, report.preRepairRevisionId, expected);
    expect(projectMarkdown(s.note.document)).toBe(expected.replaceAll('\r', '\n'));
    expect(s.note.writer.contentInvalid).toBe(false);
    expect(s.edit.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['insert', 'delete'] as const)(
    'refuses a late %s before any repair mutation and preserves the honest recoverable prefix',
    async (change) => {
      const s = await scene();
      const before = projectMarkdown(s.note.document);
      const head = s.note.writer.lastCommittedSeq;
      const vector = stateVector(s.note.document);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = s.harness.store.runCompaction.bind(s.harness.store);
      const transaction = vi
        .spyOn(s.harness.store, 'runCompaction')
        .mockImplementationOnce(async (noteId, work) => {
          entered.resolve();
          await release.promise;
          return original(noteId, work);
        });
      const repair = repairContent(s.deps, s.note.noteId, { actor: ACTOR });
      const refused = repair.catch((error: unknown) => error);
      await entered.promise;
      s.note.document.transact(() => {
        if (change === 'delete') getContent(s.note.document).delete(0, 2);
        else getContent(s.note.document).insert(0, 'late');
      }, localOrigin('repair'));
      const afterLateEdit = projectMarkdown(s.note.document);
      expect(Buffer.from(stateVector(s.note.document)).equals(vector)).toBe(change === 'delete');
      release.resolve();
      expect(await refused).toBeInstanceOf(RepairContentChanged);
      await s.note.writer.drain();
      transaction.mockRestore();
      expect(s.edit.transact).not.toHaveBeenCalled();
      expect(s.edit.insertChunked).not.toHaveBeenCalled();
      expect(projectMarkdown(s.note.document)).toBe(afterLateEdit);
      expect(s.note.writer.contentInvalid).toBe(true);
      expect(s.deps.audit.record).not.toHaveBeenCalled();
      const stored = s.harness.store.note(s.note.noteId);
      const revision = stored?.revisions.find((row) => row.kind === 'pre_restore');
      if (stored === undefined || revision === undefined)
        throw new Error('Checkpoint must have committed before refusing repair.');
      expect(revision.seq).toBe(head);
      assertExactRevision(stored, revision.id, before);
      expect(stored.headSeq).toBe(head + 1);
      const retried = await repairContent(s.deps, s.note.noteId, { actor: ACTOR });
      expect(retried.outcome).toBe('repaired');
      expect(projectMarkdown(s.note.document)).toBe(afterLateEdit.replaceAll('\r', '\n'));
      expect(s.note.writer.contentInvalid).toBe(false);
    },
  );

  it('keeps dry-run text and attribution while creating only the exact durable checkpoint', async () => {
    const s = await scene();
    const before = projectMarkdown(s.note.document);
    const head = s.note.writer.lastCommittedSeq;
    const report = await repairContent(s.deps, s.note.noteId, { actor: ACTOR, dryRun: true });
    expect(report).toMatchObject({
      outcome: 'dry-run',
      reason: 'cr',
      charsBefore: before.length,
      droppedEmbeds: 0,
      attributeRuns: 0,
    });
    expect(s.edit.transact).not.toHaveBeenCalled();
    expect(s.edit.insertChunked).not.toHaveBeenCalled();
    expect(s.note.writer.lastCommittedSeq).toBe(head);
    expect(s.note.writer.contentInvalid).toBe(true);
    const stored = s.harness.store.note(s.note.noteId);
    if (stored === undefined || report.preRepairRevisionId === null)
      throw new Error('Missing dry-run checkpoint.');
    assertExactRevision(stored, report.preRepairRevisionId, before);
    expect(stored.revisions.find((row) => row.id === report.preRepairRevisionId)?.actor).toEqual({
      actorType: 'system',
      userId: null,
      sessionId: null,
    });
  });
});
