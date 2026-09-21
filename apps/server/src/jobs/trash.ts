/** Bounded discovery shared by retention execution and the operator's streamed dry-run. */
import { idFromBytes, LIMITS, NodeId, VaultId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { appDb } from '../rest/handler-context.ts';
import type { JobContext } from './scheduler.ts';

export interface TrashPurgeSelection {
  readonly vaultId?: string | undefined;
  readonly olderThanDays?: number | undefined;
}
export interface TrashPurgeCandidate {
  readonly nodeId: NodeId;
  readonly rootId: NodeId;
  readonly vaultId: VaultId;
  readonly version: number;
  readonly path: string;
  readonly expiresAt: string;
}
/** Descendants with later retention protect the entire cascade; the mutation rechecks under lock. */
export async function* trashPurgeCandidates(
  db: Kysely<Database>,
  cutoff: Date,
  selection: TrashPurgeSelection,
  options: { readonly rootsOnly: boolean; readonly after?: string | undefined },
): AsyncGenerator<TrashPurgeCandidate> {
  let after = options.after === undefined ? null : idBytes(NodeId.parse(options.after));
  for (;;) {
    let query = db
      .selectFrom('trash_entries as root')
      .innerJoin('trash_entries as trash', 'trash.cascade_root_id', 'root.node_id')
      .innerJoin('nodes as node', 'node.id', 'trash.node_id')
      .innerJoin('vaults as vault', 'vault.id', 'root.vault_id')
      .select([
        'trash.node_id',
        'trash.vault_id',
        'trash.original_path',
        'trash.expires_at',
        'node.version',
        'root.node_id as root_id',
      ])
      .whereRef('root.node_id', '=', 'root.cascade_root_id')
      .where('root.expires_at', '<=', cutoff)
      .where('vault.status', '=', 'active')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('trash_entries as later')
              .select('later.node_id')
              .whereRef('later.cascade_root_id', '=', 'root.node_id')
              .where('later.expires_at', '>', cutoff),
          ),
        ),
      )
      .orderBy('trash.node_id')
      .limit(LIMITS.JOB_BATCH_SIZE);
    if (options.rootsOnly) query = query.whereRef('trash.node_id', '=', 'root.node_id');
    if (selection.vaultId !== undefined)
      query = query.where('root.vault_id', '=', idBytes(selection.vaultId));
    if (selection.olderThanDays !== undefined)
      query = query.where(
        'root.deleted_at',
        '<=',
        new Date(cutoff.getTime() - selection.olderThanDays * 86_400_000),
      );
    if (after !== null) query = query.where('trash.node_id', '>', after);
    // eslint-disable-next-line no-await-in-loop -- consume one ordered page before admitting the next bounded query
    const page = await query.execute();
    if (page.length === 0) return;
    for (const row of page) {
      after = row.node_id;
      yield {
        nodeId: NodeId.parse(idFromBytes(row.node_id)),
        rootId: NodeId.parse(idFromBytes(row.root_id)),
        vaultId: VaultId.parse(idFromBytes(row.vault_id)),
        version: row.version,
        path: row.original_path,
        expiresAt: row.expires_at.toISOString(),
      };
    }
  }
}
/** The product tree lifecycle owns the actual purge, writer drain, audit and broadcasts. */
export async function purgeTrash(
  app: FastifyInstance,
  context: JobContext,
): Promise<Record<string, unknown>> {
  const cutoff = app.clock.date();
  let removed = 0,
    examined = context.progress?.phase === 'trash' ? context.progress.done : 0,
    skipped = 0;
  const selection = {
    ...(typeof context.payload['vaultId'] === 'string'
      ? { vaultId: context.payload['vaultId'] }
      : {}),
    ...(typeof context.payload['olderThanDays'] === 'number'
      ? { olderThanDays: context.payload['olderThanDays'] }
      : {}),
  };
  for await (const row of trashPurgeCandidates(appDb(app), cutoff, selection, {
    rootsOnly: true,
    ...(context.progress?.phase === 'trash' ? { after: context.progress.cursor } : {}),
  })) {
    await context.assertActive();
    if (context.payload['dryRun'] !== true) {
      const result = await app.purgeExpiredTrash({
        vaultId: row.vaultId,
        nodeId: row.nodeId,
        version: row.version,
        expiresBefore: cutoff,
        context: { client: 'maintenance' },
        ownerFence: context.ownerFence,
      });
      if (result.status === 'purged') removed += result.nodes.length;
      else skipped += 1;
    }
    examined += 1;
    await context.checkpoint({
      phase: 'trash',
      done: examined,
      total: examined,
      cursor: row.nodeId,
    });
  }
  return { removed, examined, skipped, dryRun: context.payload['dryRun'] === true };
}
