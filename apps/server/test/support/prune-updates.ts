/** Bounded model-harness convenience over the same single-batch retention predicate jobs use. */
import { LIMITS } from '@iridium/contracts';

import {
  pruneUpdateLogBatch,
  type PruneUpdateLogBatchOptions,
} from '../../src/collab/persistence/prune.ts';

export interface PruneUpdateLogOptions extends PruneUpdateLogBatchOptions {
  readonly maxBatches?: number;
}

export async function pruneUpdateLog(options: PruneUpdateLogOptions): Promise<number> {
  const maxBatches = options.maxBatches ?? 20;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000) {
    throw new RangeError('update-log prune max batches must be between 1 and 1000');
  }
  const batchSize = options.batchSize ?? LIMITS.JOB_BATCH_SIZE;
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    // eslint-disable-next-line no-await-in-loop -- the next bounded batch follows the prior committed deletion
    const count = await pruneUpdateLogBatch({ ...options, batchSize });
    removed += count;
    if (count < batchSize) return removed;
  }
  return removed;
}
