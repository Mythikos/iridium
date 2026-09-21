/** Real InnoDB barriers hold overlapping lifecycle requests at the vault and final audit locks. */
import { chainIdForVault, Node, type TrashNodeResult } from '@iridium/contracts';
import { assertSchemaName, type RestResponse } from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { createMaintDb } from '../../src/db/migrator.ts';
import { expectIndependentAuditChains } from '../support/audit-chain-oracle.ts';
import { NIGHTLY_CHAOS } from '../support/collab-chaos.ts';
import { startCollab, type CollabHarness } from '../support/collab-harness.ts';

const CASES = Array.from({ length: NIGHTLY_CHAOS ? 50 : 10 }, (_, iteration) => ({
  iteration,
  order: iteration % 2 === 0 ? 'restore-first' : 'purge-first',
}));

async function waitingTransactions(
  harness: CollabHarness,
  table: 'vaults' | 'audit_chain_heads',
): Promise<number> {
  assertSchemaName(harness.server.schema);
  const rows = await harness.sql
    .rows(`SELECT COUNT(DISTINCT waiting.REQUESTING_ENGINE_TRANSACTION_ID)
    FROM performance_schema.data_lock_waits waiting
    JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID=waiting.REQUESTING_ENGINE_LOCK_ID
    WHERE requested.OBJECT_SCHEMA='${harness.server.schema}' AND requested.OBJECT_NAME='${table}'`);
  return Number(rows[0]?.[0] ?? 0);
}

describe('audit.trash-race.chaos [area:audit] [spec:structural-concurrency]', () => {
  it.for(CASES)(
    'keeps every chain intact with $order, iteration $iteration',
    { timeout: 90_000 },
    async ({ order }) => {
      const harness = await startCollab({ mode: 'child', extraEnv: { JOBS_ENABLED: 'false' } });
      const rootUrl = new URL(inject('iridiumMysql').rootUri);
      rootUrl.pathname = `/${harness.server.schema}`;
      const admin = createMaintDb(rootUrl.toString());
      const locker = createMaintDb(rootUrl.toString());
      const release = Promise.withResolvers<void>();
      let held: Promise<void> | undefined;
      const pending: Promise<RestResponse>[] = [];
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const create = async (
          kind: 'category' | 'note',
          parentId: string,
          name: string,
        ): Promise<Node> => {
          const response = await cast.admin.client.post(`/vaults/${cast.vault.id}/nodes`, {
            json: {
              kind,
              parentId,
              name,
              ...(kind === 'note'
                ? {
                    markdown:
                      '---\ntags: [race]\naliases: [raced-note]\n---\nCommitted subtree note\n',
                  }
                : {}),
            },
          });
          expect(response.status).toBe(201);
          return Node.parse(response.body);
        };
        const category = await create('category', cast.vault.rootNodeId, 'Raced subtree');
        const nested = await create('category', category.id, 'Nested');
        const note = await create('note', nested.id, 'Subject');
        const client = await harness.open(cast.editorA, note.id);
        await client.waitFor('saved');
        const locked = Promise.withResolvers<void>();
        held = locker.db.transaction().execute(async (trx) => {
          await trx
            .selectFrom('audit_chain_heads')
            .select('last_id')
            .where('chain_id', '=', chainIdForVault(cast.vault.id))
            .forUpdate()
            .executeTakeFirstOrThrow();
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const settled = new Set<string>();
        const track = <T>(
          name: string,
          response: Promise<RestResponse<T>>,
        ): Promise<RestResponse<T>> => {
          const observed = response.finally(() => settled.add(name));
          pending.push(observed);
          return observed;
        };
        const trash = track(
          'trash',
          cast.admin.client.post<TrashNodeResult>(`/nodes/${category.id}/trash`, {
            ifMatch: category.version,
            json: { recursive: true },
          }),
        );
        // A note outside the subtree can reach the same audit head without taking this vault's mutex.
        const named = track(
          'named',
          cast.admin.client.post(`/notes/${cast.note.id}/revisions`, {
            json: { label: 'Concurrent independent head writer' },
          }),
        );
        try {
          await expect.poll(() => waitingTransactions(harness, 'audit_chain_heads')).toBe(2);
        } catch (cause) {
          const waits = await harness.sql
            .rows(`SELECT requested.OBJECT_NAME, requested.LOCK_MODE, requested.LOCK_DATA,
            waiting.REQUESTING_ENGINE_TRANSACTION_ID, blocking.OBJECT_NAME, blocking.LOCK_DATA
            FROM performance_schema.data_lock_waits waiting
            JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID=waiting.REQUESTING_ENGINE_LOCK_ID
            JOIN performance_schema.data_locks blocking ON blocking.ENGINE_LOCK_ID=waiting.BLOCKING_ENGINE_LOCK_ID
            WHERE requested.OBJECT_SCHEMA='${harness.server.schema}'`);
          const statements = await harness.sql
            .rows(`SELECT PROCESSLIST_INFO FROM performance_schema.threads
            WHERE PROCESSLIST_DB='${harness.server.schema}' AND PROCESSLIST_INFO IS NOT NULL`);
          throw new Error(
            `The two independent head writers did not overlap: ${JSON.stringify({
              waits,
              statements,
              nodes: {
                named: cast.note.id,
                category: category.id,
                nested: nested.id,
                note: note.id,
              },
              settled: [...settled],
              logs: harness.logs.slice(-10),
            })}`,
            { cause },
          );
        }
        const restore = () =>
          track(
            'restore',
            cast.admin.client.post(`/nodes/${category.id}/restore`, {
              ifMatch: category.version + 1,
              json: {},
            }),
          );
        const purge = () =>
          track(
            'purge',
            cast.admin.client.del(`/nodes/${category.id}`, {
              ifMatch: category.version + 1,
              query: { purge: 'true' },
            }),
          );
        const first = order === 'restore-first' ? restore() : purge();
        await expect.poll(() => waitingTransactions(harness, 'vaults')).toBe(1);
        const second = order === 'restore-first' ? purge() : restore();
        await expect.poll(() => waitingTransactions(harness, 'vaults')).toBe(2);
        expect(settled.size).toBe(0);
        expect(await admin.db.selectFrom('trash_entries').selectAll().execute()).toEqual([]);
        expect(
          await admin.db
            .selectFrom('nodes')
            .select(['deleted_at', 'version'])
            .where('id', '=', idBytes(category.id))
            .executeTakeFirstOrThrow(),
        ).toEqual({ deleted_at: null, version: 1 });
        const granted = await harness.sql.rows(`SELECT COUNT(DISTINCT ENGINE_TRANSACTION_ID)
        FROM performance_schema.data_locks WHERE OBJECT_SCHEMA='${harness.server.schema}'
          AND OBJECT_NAME='audit_chain_heads' AND LOCK_TYPE='RECORD'
          AND LOCK_STATUS='GRANTED' AND LOCK_MODE LIKE 'X%'`);
        expect(Number(granted[0]?.[0])).toBe(1);
        release.resolve();
        await held;
        const [trashed, revision, firstResult, secondResult] = await Promise.all([
          trash,
          named,
          first,
          second,
        ]);
        expect(trashed.status).toBe(200);
        expect(revision.status).toBe(201);
        const restored = order === 'restore-first' ? firstResult : secondResult;
        const purged = order === 'restore-first' ? secondResult : firstResult;
        expect([restored.status, purged.status]).toSatisfy(
          (statuses: readonly number[]) =>
            (statuses[0] === 200 && statuses[1] === 409) ||
            (statuses[0] === 404 && statuses[1] === 204),
        );
        const actions = ['node.trashed'];
        if (restored.status === 200) {
          actions.push('node.restored', 'node.trashed');
          const again = await cast.admin.client.post(`/nodes/${category.id}/trash`, {
            ifMatch: 3,
            json: { recursive: true },
          });
          if (again.status !== 200)
            throw new Error(`A winning restore must remain mutable: ${JSON.stringify(again.body)}`);
          const final = await cast.admin.client.del(`/nodes/${category.id}`, {
            ifMatch: 4,
            query: { purge: 'true' },
          });
          if (final.status !== 204)
            throw new Error(`Final purge failed: ${JSON.stringify(final.body)}`);
        }
        actions.push('node.purged');
        const events = await admin.db
          .selectFrom('audit_events')
          .select(['action', 'targets', 'metadata'])
          .where('target_id', '=', idBytes(category.id))
          .where('action', 'in', ['node.trashed', 'node.restored', 'node.purged'])
          .orderBy('id')
          .execute();
        expect(events.map((event) => event.action)).toEqual(actions);
        for (const event of events)
          expect(event.targets?.map((target) => target.id).toSorted()).toEqual(
            [category.id, nested.id, note.id].toSorted(),
          );
        expect(events.at(-1)?.metadata).toMatchObject({
          notes: [{ noteId: note.id, contentHash: expect.any(String) }],
        });
        expect(
          await admin.db
            .selectFrom('nodes')
            .select('id')
            .where(
              'id',
              'in',
              [category, nested, note].map((node) => idBytes(node.id)),
            )
            .execute(),
        ).toEqual([]);
        expect(
          await admin.db
            .selectFrom('note_projection_terms')
            .select('note_id')
            .where('note_id', '=', idBytes(note.id))
            .execute(),
        ).toEqual([]);
        expect(await expectIndependentAuditChains(admin.db)).toBeGreaterThanOrEqual(2);
        expect((await harness.server.cli(['audit', 'verify-chain', '--json'])).code).toBe(0);
      } finally {
        release.resolve();
        await Promise.allSettled([...pending, ...(held === undefined ? [] : [held])]);
        await admin.db.destroy();
        await locker.db.destroy();
        await harness.close();
      }
    },
  );
});
