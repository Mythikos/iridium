/** Compacted update retention (03 §8.4; OPS scheduled maintenance: update_log_prune). */
import type { NoteId } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes } from '../../auth/ids.ts';
import type { Database } from '../../db/schema.ts';

const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 500;

export interface PruneUpdateLogBatchOptions {
  readonly db: Kysely<Database>;
  readonly now: Date;
  /** The resolved UPDATE_LOG_RETENTION_DAYS setting. */
  readonly retentionDays: number;
  readonly noteId?: NoteId;
  readonly batchSize?: number;
}

function batchPolicy(options: PruneUpdateLogBatchOptions): { batchSize: number; cutoff: Date } {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
    throw new RangeError('update-log retention must be a positive whole number of days');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError('update-log prune batch size must be between 1 and 10000');
  }
  const cutoff = new Date(options.now.getTime() - options.retentionDays * DAY_MS);
  if (!Number.isFinite(cutoff.getTime())) throw new RangeError('invalid update-log retention date');
  return { batchSize, cutoff };
}

async function deleteCoveredBatch(
  options: PruneUpdateLogBatchOptions,
  policy: { readonly batchSize: number; readonly cutoff: Date },
): Promise<number> {
  let deletion = options.db
    .deleteFrom('note_updates')
    .where('created_at', '<', policy.cutoff)
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
  const result = await deletion
    .orderBy('note_id')
    .orderBy('seq')
    .limit(policy.batchSize)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** One bounded deletion for callers that own commit, cancellation and checkpoint boundaries. */
export function pruneUpdateLogBatch(options: PruneUpdateLogBatchOptions): Promise<number> {
  return deleteCoveredBatch(options, batchPolicy(options));
}
