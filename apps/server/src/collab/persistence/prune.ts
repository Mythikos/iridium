/** Compacted update retention (03 §8.4; OPS scheduled maintenance: update_log_prune). */
import type { NoteId } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes } from '../../auth/ids.ts';
import type { Database } from '../../db/schema.ts';

const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 500;

export interface PruneUpdateLogOptions {
  readonly db: Kysely<Database>;
  readonly now: Date;
  /** The resolved UPDATE_LOG_RETENTION_DAYS setting. */
  readonly retentionDays: number;
  readonly noteId?: NoteId;
  readonly batchSize?: number;
  /** Bounds the complete invocation, not only each transaction. */
  readonly maxBatches?: number;
}

/**
 * Delete only updates covered by an existing committed snapshot, strictly older than retention.
 * The coverage predicate is part of every DELETE, not a prior read that could become stale.
 * Single-table DELETE permits an ordered LIMIT on both supported MySQL lines, bounding locks and
 * transaction size. Re-running an interrupted job is safe because every batch is independently safe.
 */
export async function pruneUpdateLog(options: PruneUpdateLogOptions): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
    throw new RangeError('update-log retention must be a positive whole number of days');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError('update-log prune batch size must be between 1 and 10000');
  }
  const cutoff = new Date(options.now.getTime() - options.retentionDays * DAY_MS);
  if (!Number.isFinite(cutoff.getTime())) throw new RangeError('invalid update-log retention date');
  const maxBatches = options.maxBatches ?? 20;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000) {
    throw new RangeError('update-log prune max batches must be between 1 and 1000');
  }
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    let deletion = options.db
      .deleteFrom('note_updates')
      .where('created_at', '<', cutoff)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('note_docs')
            .select('note_id')
            .whereRef('note_docs.note_id', '=', 'note_updates.note_id')
            .where('snapshot', 'is not', null)
            .whereRef('note_updates.seq', '<=', 'note_docs.snapshot_through_seq'),
        ),
      );
    if (options.noteId !== undefined) {
      deletion = deletion.where('note_id', '=', idBytes(options.noteId));
    }
    // eslint-disable-next-line no-await-in-loop -- bounded committed batches form one retention job
    const result = await deletion
      .orderBy('note_id')
      .orderBy('seq')
      .limit(batchSize)
      .executeTakeFirst();
    const count = Number(result.numDeletedRows);
    removed += count;
    if (count < batchSize) return removed;
  }
  return removed;
}
