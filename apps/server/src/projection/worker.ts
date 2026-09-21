/** Self-contained CPU worker: no database, socket, or application service access. */
import { createHash } from 'node:crypto';

import { parseNote, PIPELINE_VERSION, project, type NoteProjection } from '@iridium/markdown';

/** The parser consumes committed, normalized source and an explicit pipeline identity. */
export interface ProjectionTask {
  readonly markdown: string;
  readonly pipelineVersion: number;
}

/** Produces derived fields; link targets are resolved against the writer's transaction snapshot. */
export default function projectTask(task: ProjectionTask): NoteProjection {
  if (task.pipelineVersion !== PIPELINE_VERSION) {
    throw new ProjectionVersionMismatch(task.pipelineVersion);
  }
  const parsed = parseNote(task.markdown);
  return project(parsed, task.markdown, {
    contentHash: createHash('sha256').update(task.markdown, 'utf8').digest('hex'),
  });
}

class ProjectionVersionMismatch extends Error {
  constructor(requested: number) {
    super(
      `Projection task requests pipeline ${requested}, but this worker implements ${PIPELINE_VERSION}.`,
    );
    this.name = 'ProjectionVersionMismatch';
  }
}
