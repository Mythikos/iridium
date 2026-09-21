// Every worker imports the public API. Only a private experiment build changes admission.
import { parseNote, prescan } from '@iridium/markdown';

/** Both hosts execute exactly the same pipeline; only the host controls termination. */
export function measurePipeline(task, transform) {
  const started = performance.now();
  if (task.mode === 'prescan') {
    const value = prescan(task.markdown);
    return {
      status: value.status,
      detail: value.detail ?? null,
      durationMs: performance.now() - started,
      value,
    };
  }
  const parsed = parseNote(task.markdown, { flavor: task.flavor });
  const parsedAt = performance.now();
  const value = transform(parsed);
  const ended = performance.now();
  return {
    status: parsed.prescan.status === 'ok' ? (value.status ?? 'ok') : parsed.prescan.status,
    detail: parsed.prescan.detail ?? null,
    durationMs: ended - started,
    parseMs: parsedAt - started,
    transformMs: ended - parsedAt,
    value,
  };
}
