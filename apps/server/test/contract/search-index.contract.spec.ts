/** Real interchangeable search bindings share transaction, revision and authorized-scope semantics. */
import { Node, NoteId, VaultId, type ParsedSearchQuery } from '@iridium/contracts';
import { parseQuery } from '@iridium/markdown/search';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { CursorCodec, readPromotedCursorKeyVersion } from '../../src/mcp/cursor.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import type { SearchDocument, SearchIndex } from '../../src/search/index.ts';
import { startCollab, type CollabHarness } from '../support/collab-harness.ts';

interface SearchFixture {
  readonly harness: CollabHarness;
  readonly index: SearchIndex;
  readonly cursors: CursorCodec;
}
interface Implementation {
  readonly name: string;
  open(): Promise<SearchFixture>;
}
const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    name: 'MysqlFulltextSearch',
    open: async () => {
      const harness = await startCollab({
          collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
          extraEnv: { JOBS_ENABLED: 'false' },
        }),
        app = harness.application();
      const cursors = new CursorCodec({
        keyring: app.iridiumConfig.keys.mcpCursor,
        signingVersion: await readPromotedCursorKeyVersion(appDb(app)),
        now: () => app.clock.now(),
      });
      return { harness, index: app.searchIndex, cursors };
    },
  },
];
function parsed(raw: string): ParsedSearchQuery {
  const result = parseQuery(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.query;
}

describe.each(IMPLEMENTATIONS)('search-index.contract [area:seams] $name', (implementation) => {
  it('indexes committed creation and edits, rejects stale writes, and rolls back index/remove with their transaction', async () => {
    const fixture = await implementation.open(),
      { harness, index, cursors } = fixture;
    try {
      const cast = await harness.server.seed.kernel(),
        editor = await harness.server.loginAs(cast.editorA);
      const response = await editor.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Indexed product note',
          markdown: '# Before heading\nalphaunique original body',
        },
      });
      expect(response.status).toBe(201);
      const note = Node.parse(response.body),
        noteId = NoteId.parse(note.id),
        vaultId = VaultId.parse(cast.vault.id),
        app = harness.application(),
        db = appDb(app);
      const page = {
        limit: 10,
        snippetChars: 160,
        cursors,
        principalKey: 'search-contract-editor',
      };
      const query = (raw: string) => index.query(parsed(raw), { vaultIds: [vaultId] }, page);
      expect((await query('alphaunique')).results.map((row) => row.noteId)).toEqual([noteId]);
      const initial = await db
        .selectFrom('note_search')
        .selectAll()
        .where('note_id', '=', idBytes(noteId))
        .executeTakeFirstOrThrow();
      const document: SearchDocument = {
        noteId,
        vaultId,
        title: initial.title,
        bodyText: initial.body_text,
        revision: initial.revision,
        updatedAt: initial.updated_at,
      };
      const client = await harness.open(cast.editorA, note.id);
      await client.waitSynced();
      const acknowledged = client.waitForAck();
      client.ydoc.transact(() => {
        client.deleteAt(0, client.text.length);
        client.typeAt(0, '# After heading\nbetaunique edited body');
      });
      await acknowledged;
      const projected = client.waitForStateless('projected');
      client.sendStateless({ v: 1, t: 'flush' });
      await projected;
      const current = (await query('betaunique')).results[0];
      expect(current?.noteId).toBe(noteId);
      expect(current?.revision).toBeGreaterThan(document.revision);
      await db.transaction().execute((trx) => index.index(document, trx));
      expect((await query('alphaunique')).results).toEqual([]);
      expect((await query('betaunique')).results[0]?.title).toBe('After heading');
      const rollback = new Error('Search transaction rollback');
      await expect(
        db.transaction().execute(async (trx) => {
          await index.index(
            {
              ...document,
              revision: current?.revision ?? 0,
              title: 'rolledbacktoken',
              bodyText: 'rolledbacktoken',
            },
            trx,
          );
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect((await query('rolledbacktoken')).results).toEqual([]);
      expect((await query('betaunique')).results[0]?.noteId).toBe(noteId);
      await expect(
        db.transaction().execute(async (trx) => {
          await index.remove(noteId, trx);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect((await query('betaunique')).results[0]?.noteId).toBe(noteId);
      await db.transaction().execute((trx) => index.remove(noteId, trx));
      expect((await query('betaunique')).results).toEqual([]);
      const job = await app.jobs.scheduler.enqueue(
        'reindex',
        { noteIds: [noteId] },
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      expect((await app.jobs.scheduler.runUntilSettled(job.id)).status).toBe('succeeded');
      expect((await query('betaunique')).results[0]?.revision).toBe(current?.revision);
    } finally {
      await harness.close();
    }
  });
  it('filters vault scope before ranking/limit and binds continuation to the authorized scope and principal', async () => {
    const { harness, index, cursors } = await implementation.open();
    try {
      const cast = await harness.server.seed.kernel();
      const hidden = await harness.server.seed.vault({ name: 'Hidden index contract vault' });
      const first = await harness.server.seed.note({
        vault: cast.vault,
        name: 'Visible one',
        markdown: '# scopedneedle\nscopedneedle visible source',
      });
      const second = await harness.server.seed.note({
        vault: cast.vault,
        name: 'Visible two',
        markdown: '# scopedneedle\nscopedneedle second source',
      });
      await harness.server.seed.note({
        vault: hidden,
        name: 'Hidden title',
        markdown: '# scopedneedle\nscopedneedle SECRET-BYTES scopedneedle scopedneedle',
      });
      const scope = { vaultIds: [VaultId.parse(cast.vault.id)] },
        query = parsed('scopedneedle'),
        page = { limit: 1, snippetChars: 160, cursors, principalKey: 'search-contract-viewer' };
      const one = await index.query(query, scope, page);
      expect(one.results).toHaveLength(1);
      expect(one.nextCursor).toBeTypeOf('string');
      expect(JSON.stringify(one)).not.toContain('SECRET-BYTES');
      const two = await index.query(query, scope, { ...page, cursor: one.nextCursor });
      expect(two.results).toHaveLength(1);
      expect(new Set([...one.results, ...two.results].map((row) => row.noteId))).toEqual(
        new Set([first.id, second.id]),
      );
      expect(two.nextCursor).toBeUndefined();
      await expect(
        index.query(query, { vaultIds: [] }, { ...page, cursor: one.nextCursor }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        index.query(query, scope, {
          ...page,
          cursor: one.nextCursor,
          principalKey: 'different-principal',
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect((await index.query(query, { vaultIds: [] }, page)).results).toEqual([]);
      const viewer = await harness.server.loginAs(cast.viewer);
      const publicResult = await viewer.get('/search', { query: { q: 'scopedneedle', limit: 1 } });
      expect(publicResult.status).toBe(200);
      expect(JSON.stringify(publicResult.body)).not.toContain('SECRET-BYTES');
    } finally {
      await harness.close();
    }
  });
  it('refreshes filename titles through structural mutations and removes purged notes through the same binding', async () => {
    const { harness, index, cursors } = await implementation.open();
    try {
      const cast = await harness.server.seed.kernel(),
        admin = await harness.server.loginAs(cast.admin);
      const response = await admin.post(`/vaults/${cast.vault.id}/nodes`, {
        json: {
          kind: 'note',
          parentId: cast.vault.rootNodeId,
          name: 'Oldfilenameunique',
          markdown: 'body without heading',
        },
      });
      expect(response.status).toBe(201);
      const note = Node.parse(response.body);
      const page = { limit: 10, snippetChars: 160, cursors, principalKey: 'search-contract-admin' },
        scope = { vaultIds: [VaultId.parse(cast.vault.id)] };
      expect((await index.query(parsed('Oldfilenameunique'), scope, page)).results[0]?.noteId).toBe(
        note.id,
      );
      const renamed = await admin.patch(`/nodes/${note.id}`, {
        json: { name: 'Newfilenameunique' },
        headers: { 'if-match': `"${String(note.version)}"` },
      });
      expect(renamed.status).toBe(200);
      expect((await index.query(parsed('Oldfilenameunique'), scope, page)).results).toEqual([]);
      expect((await index.query(parsed('Newfilenameunique'), scope, page)).results[0]?.noteId).toBe(
        note.id,
      );
      const current = Node.parse((await admin.get(`/nodes/${note.id}`)).body);
      const trashed = await admin.post(`/nodes/${note.id}/trash`, {
        json: {},
        headers: { 'if-match': `"${String(current.version)}"` },
      });
      expect(trashed.status).toBe(200);
      expect((await index.query(parsed('Newfilenameunique'), scope, page)).results).toEqual([]);
      const row = await appDb(harness.application())
        .selectFrom('nodes')
        .select('version')
        .where('id', '=', idBytes(note.id))
        .executeTakeFirstOrThrow();
      const purged = await admin.del(`/nodes/${note.id}`, {
        query: { purge: true },
        headers: { 'if-match': `"${String(row.version)}"` },
      });
      expect(purged.status).toBe(204);
      expect(
        await appDb(harness.application())
          .selectFrom('note_search')
          .select('note_id')
          .where('note_id', '=', idBytes(note.id))
          .execute(),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
