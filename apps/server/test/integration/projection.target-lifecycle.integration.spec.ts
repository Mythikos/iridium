/** Real publication and purge interleavings retain no resolved reference to a removed target. */
import { Node, NoteId, TrashNodeResult, VaultId } from '@iridium/contracts';
import { inspectVaultLockWaits } from '@iridium/testkit';
import type { KyselyPlugin, QueryId } from 'kysely';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { NO_COMPACTION_FAULTS, runCompaction } from '../../src/collab/persistence/compactor.ts';
import { KyselyPersistenceStore } from '../../src/collab/persistence/kysely-store.ts';
import { captureStoredState } from '../../src/notes/committed-state.ts';
import { startCollab } from '../support/collab-harness.ts';

/** Wait after a real resolver path read, returning the untouched driver result when released. */
function pauseResolvedPaths() {
  const release = Promise.withResolvers<void>();
  const queries = new Set<QueryId>();
  let entered = false;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (
        args.node.kind === 'RawNode' &&
        args.node.sqlFragments.join(' ').includes('WITH RECURSIVE paths AS')
      )
        queries.add(args.queryId);
      return args.node;
    },
    async transformResult(args) {
      if (queries.delete(args.queryId)) {
        entered = true;
        await release.promise;
      }
      return args.result;
    },
  };
  return { plugin, release: () => release.resolve(), entered: () => entered };
}

describe('projection.target-lifecycle.integration [area:projection]', () => {
  it('holds the live target stable after resolution until publication commits, then purge clears the committed inbound row', async () => {
    const harness = await startCollab({
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    const latch = pauseResolvedPaths();
    const pending: Promise<unknown>[] = [];
    try {
      const user = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Publication before purge' });
      const target = await harness.server.seed.note({
        vault,
        name: 'Target',
        markdown: 'Destination',
      });
      const source = await harness.server.seed.note({
        vault,
        name: 'Source',
        markdown: '# Source\n',
      });
      const admin = await harness.server.loginAs(user);
      const targetNode = Node.parse((await admin.get('/nodes/' + target.id)).body);
      const client = await harness.open(user, source.id);
      await client.waitFor('saved');
      client.typeAt(client.text.length, '[target](Target.md)\n');
      await client.waitFor('saved');
      const app = harness.application();
      const db = app.database.dbApp;
      const persist = app.database.dbPersist;
      if (db === null || persist === null) throw new Error('Expected both real database pools.');
      const noteId = NoteId.parse(source.id);
      const captured = await db
        .transaction()
        .execute((trx) => captureStoredState(trx, noteId, false));
      const store = new KyselyPersistenceStore({
        db: () => persist.withPlugin(latch.plugin),
        ownership: app.collab.ownerLease.captureFence(),
        audit: app.audit,
        searchIndex: app.searchIndex,
      });
      const publication = runCompaction(store, {
        noteId,
        vaultId: VaultId.parse(vault.id),
        captured,
        trigger: 'flush',
        now: app.clock.date(),
        faults: NO_COMPACTION_FAULTS,
        actor: { actorType: 'system', userId: null, sessionId: null },
        onStateVectorOversize: () => {},
        prepareProjection: (markdown) => app.notes.prepare(markdown),
      });
      pending.push(publication);
      await expect.poll(latch.entered, { timeout: 10_000 }).toBe(true);
      const trash = admin.post('/nodes/' + target.id + '/trash', {
        json: { recursive: false },
        ifMatch: targetNode.version,
      });
      pending.push(trash);
      await expect
        .poll(
          async () =>
            (await inspectVaultLockWaits(harness.sql, harness.server.schema)).some(
              (wait) => wait.requested.startsWith('X') && wait.blocking.startsWith('S'),
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      expect(
        (
          await db
            .selectFrom('nodes')
            .select('deleted_at')
            .where('id', '=', idBytes(target.id))
            .executeTakeFirstOrThrow()
        ).deleted_at,
      ).toBeNull();
      latch.release();
      expect(await publication).toMatchObject({ status: 'ok', projected: true });
      const trashed = await trash;
      expect(trashed.status).toBe(200);
      const tombstone = TrashNodeResult.parse(trashed.body).nodes.find(
        (node) => node.id === target.id,
      );
      if (tombstone === undefined) throw new Error('Trash must return its root node.');
      const beforePurge = await db
        .selectFrom('note_links')
        .selectAll()
        .where('from_note_id', '=', idBytes(source.id))
        .execute();
      expect(beforePurge).toMatchObject([
        { status: 'resolved', resolved_node_id: idBytes(target.id), revision: captured.throughSeq },
      ]);
      expect(
        (
          await admin.del('/nodes/' + target.id, {
            query: { purge: true },
            ifMatch: tombstone.version,
          })
        ).status,
      ).toBe(204);
      const afterPurge = await db
        .selectFrom('note_links')
        .selectAll()
        .where('from_note_id', '=', idBytes(source.id))
        .execute();
      expect(afterPurge).toMatchObject([
        {
          status: 'broken',
          resolved_node_id: null,
          raw_target: 'Target.md',
          revision: captured.throughSeq,
        },
      ]);
      expect((await harness.committed(source.id)).text).toBe(captured.markdown);
    } finally {
      latch.release();
      await Promise.allSettled(pending);
      await harness.close();
    }
  }, 120_000);

  it('lets a raw update commit while purge owns the vault, then reindex resolves against the committed deletion', async () => {
    const harness = await startCollab({
      collab: { debounceMs: 60_000, maxDebounceMs: 60_000 },
      extraEnv: { JOBS_ENABLED: 'false' },
    });
    const release = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    const app = harness.application();
    const record = app.audit.record.bind(app.audit);
    let entered = false;
    try {
      const user = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Purge before publication' });
      const target = await harness.server.seed.note({
        vault,
        name: 'Target',
        markdown: 'Destination',
      });
      const source = await harness.server.seed.note({
        vault,
        name: 'Source',
        markdown: '[target](Target.md)\n',
      });
      const admin = await harness.server.loginAs(user);
      const targetNode = Node.parse((await admin.get('/nodes/' + target.id)).body);
      const client = await harness.open(user, source.id);
      await client.waitFor('saved');
      const trashed = await admin.post('/nodes/' + target.id + '/trash', {
        json: { recursive: false },
        ifMatch: targetNode.version,
      });
      expect(trashed.status).toBe(200);
      const tombstone = TrashNodeResult.parse(trashed.body).nodes.find(
        (node) => node.id === target.id,
      );
      if (tombstone === undefined) throw new Error('Trash must return its root node.');
      app.audit.record = async (trx, event) => {
        const result = await record(trx, event);
        if (event.action === 'node.purged' && event.targetId === target.id) {
          entered = true;
          await release.promise;
        }
        return result;
      };
      const purge = admin.del('/nodes/' + target.id, {
        query: { purge: true },
        ifMatch: tombstone.version,
      });
      pending.push(purge);
      await expect.poll(() => entered, { timeout: 10_000 }).toBe(true);
      const before = await harness.committed(source.id);
      client.typeAt(client.text.length, 'durable while the vault is locked\n');
      await client.waitFor('saved');
      const accepted = await harness.committed(source.id);
      expect(accepted.head).toBeGreaterThan(before.head);
      const owner = app.collab.ownerLease.captureFence();
      const reindex = app.reindexService.run(
        { noteIds: [source.id] },
        {
          ownerFence: owner,
          progress: null,
          assertActive: async () => owner.assertActive(),
          checkpoint: async () => {},
        },
      );
      pending.push(reindex);
      await expect
        .poll(
          async () =>
            (await inspectVaultLockWaits(harness.sql, harness.server.schema)).some(
              (wait) => wait.requested.startsWith('S') && wait.blocking.startsWith('X'),
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      release.resolve();
      expect((await purge).status).toBe(204);
      expect(await reindex).toMatchObject({ rebuilt: 1, skipped: 0 });
      const db = app.database.dbApp;
      if (db === null) throw new Error('Expected the real application database.');
      expect(
        await db
          .selectFrom('note_links')
          .select(['status', 'resolved_node_id', 'revision'])
          .where('from_note_id', '=', idBytes(source.id))
          .execute(),
      ).toEqual([{ status: 'broken', resolved_node_id: null, revision: accepted.head }]);
      expect((await harness.committed(source.id)).text).toBe(accepted.text);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      app.audit.record = record;
      await harness.close();
    }
  }, 120_000);
});
