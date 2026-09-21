/** Pipeline execution happens before acquiring persistence or structural transaction locks. */
import { emptyProjection, PIPELINE_VERSION, type NoteProjection } from '@iridium/markdown';

import type { Clock } from '../ops/clock.ts';
import type { ServerLogger } from '../ops/logging.ts';
import type { Metrics } from '../ops/metrics.ts';
import { contentHash } from './hash.ts';
import {
  type ProjectionPool,
  ProjectionPoolClosed,
  ProjectionQueueFull,
  ProjectionTimedOut,
} from './pool.ts';

/** A projection adapter shared by note initialization, compaction and reindex. */
export type PrepareProjection = (markdown: string) => Promise<NoteProjection>;

/** Keeps the committed source readable when parsing fails or admission needs a later retry. */
export function createProjectionPreparer(
  pool: ProjectionPool,
  logger: ServerLogger,
  clock: Clock,
  metrics: () => Pick<Metrics, 'projectionDurationSeconds' | 'projectionTimeoutsTotal'> | undefined,
): PrepareProjection {
  return async (markdown) => {
    const started = clock.monotonic();
    let prepared: NoteProjection;
    try {
      prepared = await pool.run<NoteProjection>({ markdown, pipelineVersion: PIPELINE_VERSION });
    } catch (error) {
      if (error instanceof ProjectionPoolClosed) throw error;
      const status =
        error instanceof ProjectionQueueFull
          ? 'pending'
          : error instanceof ProjectionTimedOut
            ? 'timeout'
            : 'error';
      logger.warn(
        {
          event: status === 'timeout' ? 'projection.timeout' : 'projection.completed',
          status,
          err: error,
        },
        'Markdown projection could not complete',
      );
      prepared = emptyProjection(markdown, contentHash(markdown).toString('hex'), status);
    }
    metrics()?.projectionDurationSeconds.observe(
      { status: prepared.status },
      (clock.monotonic() - started) / 1000,
    );
    if (prepared.status === 'timeout') metrics()?.projectionTimeoutsTotal.inc();
    return prepared;
  };
}
