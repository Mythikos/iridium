/** The sole Markdown initialization transaction serializes and rolls back on real MySQL. */
import { NoteId } from '@iridium/contracts';
import { createNoteDoc, loadState, projectMarkdown, stateVector } from '@iridium/crdt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { AlreadyInitializedError } from '../../src/notes/service.ts';
import { startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import { insertNode, insertVault, seedUser } from '../support/seed.ts';

let context: AuthTestServer;
beforeAll(async () => {
  context = await startAuthServer();
});
afterAll(async () => {
  await context.stop();
});

async function uninitializedNote() {
  const user = await seedUser(context, { email: 'initializer@example.test' });
  const vault = await insertVault(
    context.db,
    { name: 'Initialize', createdBy: user.id },
    context.clock.now(),
  );
  const noteId = NoteId.parse(
    await insertNode(
      context.db,
      {
        vaultId: vault,
        kind: 'note',
        name: 'One initialization',
        createdBy: user.id,
      },
      context.clock.now(),
    ),
  );
  const now = context.clock.date();
  await context.db
    .insertInto('notes')
    .values({
      node_id: idBytes(noteId),
      vault_id: idBytes(vault),
      initialized_at: null,
      last_edited_by: idBytes(user.id),
      last_edited_at: now,
      last_checkpoint_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { noteId, actor: { actorType: 'user' as const, userId: user.id, sessionId: null }, now };
}

describe('notes.initialize.integration [area:notes]', () => {
  it('allows exactly one concurrent initializer and retains its one normalized durable version', async () => {
    const input = await uninitializedNote();
    const candidates = ['first\r\nversion', 'second\rversion'];
    const results = await Promise.allSettled(
      candidates.map((markdown) =>
        context.db.transaction().execute((trx) =>
          context.app.notes.initialize(trx, {
            ...input,
            markdown,
            origin: 'create',
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected');
    expect(loser?.status === 'rejected' ? loser.reason : null).toBeInstanceOf(
      AlreadyInitializedError,
    );
    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    const winner = candidates[winnerIndex]?.replaceAll(/\r\n|\r/g, '\n');
    expect(winner).toBeDefined();
    const id = idBytes(input.noteId);
    const docs = await context.db
      .selectFrom('note_docs')
      .selectAll()
      .where('note_id', '=', id)
      .execute();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ head_seq: 1, snapshot_through_seq: 1, projected_seq: 1 });
    const updates = await context.db
      .selectFrom('note_updates')
      .selectAll()
      .where('note_id', '=', id)
      .execute();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ seq: 1, origin: 'create' });
    const storedDoc = docs[0];
    const storedUpdate = updates[0];
    if (storedDoc === undefined || storedUpdate === undefined)
      throw new Error('Initializer omitted its authoritative rows.');
    const fromSnapshot = createNoteDoc({ gc: true });
    const fromUpdate = createNoteDoc({ gc: true });
    try {
      expect(storedDoc.snapshot_format).toBe(2);
      if (storedDoc.snapshot === null) throw new Error('Initializer omitted its snapshot.');
      loadState(fromSnapshot, storedDoc.snapshot, 2, 'test-replay');
      loadState(fromUpdate, storedUpdate.update_v1, 1, 'test-replay');
      expect(projectMarkdown(fromSnapshot)).toBe(winner);
      expect(projectMarkdown(fromUpdate)).toBe(winner);
      expect(stateVector(fromSnapshot)).toEqual(stateVector(fromUpdate));
      expect(Buffer.from(stateVector(fromSnapshot))).toEqual(storedDoc.snapshot_sv);
      expect(Buffer.from(stateVector(fromUpdate))).toEqual(storedUpdate.sv_after);
    } finally {
      fromSnapshot.destroy();
      fromUpdate.destroy();
    }

    const revisions = await context.db
      .selectFrom('note_revisions')
      .selectAll()
      .where('note_id', '=', id)
      .execute();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ seq: 1, kind: 'create', markdown: winner });
    expect(await context.app.notes.markdownOf(input.noteId)).toMatchObject({
      markdown: winner,
      revision: 1,
    });
    await expect(
      context.db.transaction().execute((trx) =>
        context.app.notes.initialize(trx, {
          ...input,
          markdown: 'must never replace the winner',
          origin: 'create',
        }),
      ),
    ).rejects.toBeInstanceOf(AlreadyInitializedError);
    expect(
      await context.db.selectFrom('note_updates').selectAll().where('note_id', '=', id).execute(),
    ).toEqual(updates);
  });

  it('rolls back every initialization artifact and can initialize after the caller aborts', async () => {
    const input = await uninitializedNote();
    const aborted = new Error('caller transaction aborted');
    await expect(
      context.db.transaction().execute(async (trx) => {
        await context.app.notes.initialize(trx, {
          ...input,
          markdown: 'rolled back',
          origin: 'create',
        });
        throw aborted;
      }),
    ).rejects.toBe(aborted);
    const id = idBytes(input.noteId);
    const note = await context.db
      .selectFrom('notes')
      .select('initialized_at')
      .where('node_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(note.initialized_at).toBeNull();
    const artifactRows = await Promise.all(
      (['note_docs', 'note_updates', 'note_revisions', 'note_projections'] as const).map((table) =>
        context.db.selectFrom(table).select('note_id').where('note_id', '=', id).execute(),
      ),
    );
    for (const rows of artifactRows) expect(rows).toEqual([]);
    await context.db.transaction().execute((trx) =>
      context.app.notes.initialize(trx, {
        ...input,
        markdown: 'after retry',
        origin: 'create',
      }),
    );
    expect(await context.app.notes.markdownOf(input.noteId)).toMatchObject({
      markdown: 'after retry',
      revision: 1,
    });
  });
});
