import { createHash } from 'node:crypto';

import { project } from '@iridium/markdown';

import { measurePipeline } from './pipeline.mjs';

/** Hashing and the entire projection run inside a real Piscina worker. */
export default function nodeWorker(task) {
  if (task.mode === 'prescan') return measurePipeline(task);
  const hashStart = performance.now();
  const contentHash = createHash('sha256').update(task.markdown).digest('hex');
  const hashMs = performance.now() - hashStart;
  const result = measurePipeline(task, (parsed) => project(parsed, task.markdown, { contentHash }));
  return { ...result, hashMs, durationMs: result.durationMs + hashMs };
}
