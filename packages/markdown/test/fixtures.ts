/** Shared immutable fixture bytes for package suites and the Node testkit corpus adapter. */
import golden from '../fixtures/golden/sources.json' with { type: 'json' };
import hostile from '../fixtures/hostile/sources.json' with { type: 'json' };
import pathological from '../fixtures/pathological/cases.json' with { type: 'json' };

/** Markdown feature fixtures whose AST, preview and projection are separately snapshotted. */
export const GOLDEN_FIXTURES: readonly { id: string; source: string }[] = golden;
/** Hostile source is inert in both the pure hast suite and later renderer suites. */
export const HOSTILE_FIXTURES: readonly { id: string; source: string }[] = hostile;
/** Compact deterministic descriptions avoid checking megabytes of repeated adversarial bytes in git. */
export const PATHOLOGICAL_FIXTURES: readonly {
  id: string;
  repeat: string;
  count: number;
  suffix?: string;
  status: string;
  detail?: string;
}[] = pathological;
