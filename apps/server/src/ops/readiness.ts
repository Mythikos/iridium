/**
 * The readiness state machine and the check registry (ARCH-02; 11-operations-and-deployment.md,
 * "Health"; 09-api-reference.md section 2.17).
 *
 * There is exactly one place that decides whether the process accepts work. `ReadinessState` moves
 * `starting → not_ready ↔ ready`, and while it is not `ready` an `onRequest` hook answers every
 * route outside `/healthz`, `/readyz` and `/metrics` with `503 not_ready` and `Retry-After: 5`.
 * That single state also drives the shutdown drain, which is why a drain and a pending migration
 * cannot disagree about whether traffic should arrive.
 *
 * Pending migrations and absent collaboration ownership are **fail-closed**: serving with the wrong
 * schema or alongside another owner would bypass the durable and authorization boundaries. Other failing checks make `/readyz`
 * answer `503` while the server keeps serving, because a degraded Iridium that still lets people
 * read their notes is better than a closed door (11, "Boot sequence and fail-closed readiness").
 */
import {
  READYZ_CHECK_NAMES,
  type ReadyzBody,
  type ReadyzCheck,
  type ReadyzCheckName,
  type ReadyzStatus,
} from '@iridium/contracts';

import { toRfc3339, type Clock } from './clock.ts';

// The wire contract owns the check names and body shape; readiness supplies their evaluations.
export { READYZ_CHECK_NAMES } from '@iridium/contracts';
export type { ReadyzBody, ReadyzCheck, ReadyzCheckName, ReadyzStatus } from '@iridium/contracts';

/** The checks whose failure flips `ReadinessState` and gates every non-ops route. */
export const FAIL_CLOSED_CHECKS: readonly ReadyzCheckName[] = Object.freeze([
  'migrations',
  'collab_owner_lease',
]);

/** What one check returns. `durationMs` is measured by the runner, never by the check. */
export interface CheckOutcome {
  readonly status: ReadyzStatus;
  readonly detail?: string;
}

/** A registered check. Failures are caught by the runner, so an implementation may throw. */
export type CheckFn = () => Promise<CheckOutcome> | CheckOutcome;

/** The three states of ARCH-02. */
export type ReadinessState = 'starting' | 'not_ready' | 'ready';

const READYZ_STATUS_RANK: Readonly<Record<ReadyzStatus, number>> = { ok: 0, warn: 1, fail: 2 };

/** The worst of a set of statuses: one `fail` makes the whole body `fail`. */
export function worstStatus(statuses: readonly ReadyzStatus[]): ReadyzStatus {
  return statuses.reduce<ReadyzStatus>(
    (worst, status) => (READYZ_STATUS_RANK[status] > READYZ_STATUS_RANK[worst] ? status : worst),
    'ok',
  );
}

/** A `fail` anywhere means `503`; `ok` and `warn` both mean `200` (09 section 2.17). */
export function httpStatusFor(status: ReadyzStatus): number {
  return status === 'fail' ? 503 : 200;
}

// -----------------------------------------------------------------------------------------------
// Thresholds the checks share, so the subsystem that has the numbers does not also own the policy
// -----------------------------------------------------------------------------------------------

/** Fraction of either admission budget at which `doc_budget` warns (skeleton A49: "warn >= 80 %"). */
const DOC_BUDGET_WARN_FRACTION = 0.8;
/** Oldest pending update, in milliseconds, above which `persist_backlog` warns (11, "Health"). */
const PERSIST_BACKLOG_WARN_MS = 10_000;
/** Oldest pending update, in milliseconds, above which `persist_backlog` fails (11, "Health"). */
const PERSIST_BACKLOG_FAIL_MS = 30_000;
/** How long a writer may stay `failed` before `persist_backlog` fails (11, "Health"). */
const PERSIST_WRITER_FAILED_FAIL_MS = 60_000;

/** What the collaboration server reports for `doc_budget` (A50's two budgets). */
export interface DocBudgetReading {
  readonly loadedDocs: number;
  readonly maxLoadedDocs: number;
  readonly stateBytes: number;
  readonly maxStateBytes: number;
}

/**
 * The `doc_budget` outcome for a reading: `fail` at 100 % of either budget, `warn` from 80 %.
 *
 * The thresholds live here rather than in `collab/` because they are a readiness policy and because a
 * server that can admit no new document is not ready for new traffic even though already-open documents
 * are never evicted (A50 refuses rather than evicting). The subsystem supplies the numbers; this decides
 * what they mean.
 */
export function docBudgetOutcome(reading: DocBudgetReading): CheckOutcome {
  const docFraction = reading.maxLoadedDocs === 0 ? 0 : reading.loadedDocs / reading.maxLoadedDocs;
  const byteFraction = reading.maxStateBytes === 0 ? 0 : reading.stateBytes / reading.maxStateBytes;
  const detail =
    `${String(reading.loadedDocs)}/${String(reading.maxLoadedDocs)} documents, ` +
    `${String(reading.stateBytes)}/${String(reading.maxStateBytes)} bytes`;
  if (docFraction >= 1 || byteFraction >= 1) return { status: 'fail', detail };
  if (docFraction >= DOC_BUDGET_WARN_FRACTION || byteFraction >= DOC_BUDGET_WARN_FRACTION) {
    return { status: 'warn', detail };
  }
  return { status: 'ok', detail };
}

/** What the persistence writers report for `persist_backlog`. */
export interface PersistBacklogReading {
  /** Age of the oldest un-committed update in milliseconds; `0` when nothing is queued. */
  readonly oldestPendingMs: number;
  /** Writers in the `failed` state. */
  readonly failedWriters: number;
  /** How long the longest-failing writer has been `failed`, in milliseconds. */
  readonly longestFailedMs: number;
}

/**
 * The `persist_backlog` outcome: `ok` under 10 s with no failed writer, `warn` from 10 s, `fail` past
 * 30 s or when a writer has been `failed` for more than 60 s (11, "Health").
 */
export function persistBacklogOutcome(reading: PersistBacklogReading): CheckOutcome {
  const detail =
    `oldest pending ${String(Math.round(reading.oldestPendingMs))}ms, ` +
    `${String(reading.failedWriters)} failed writer(s)`;
  if (
    reading.oldestPendingMs > PERSIST_BACKLOG_FAIL_MS ||
    (reading.failedWriters > 0 && reading.longestFailedMs > PERSIST_WRITER_FAILED_FAIL_MS)
  ) {
    return { status: 'fail', detail };
  }
  if (reading.oldestPendingMs >= PERSIST_BACKLOG_WARN_MS || reading.failedWriters > 0) {
    return { status: 'warn', detail };
  }
  return { status: 'ok', detail };
}

/**
 * The single `ReadinessState` owner. Nothing else may decide whether the process accepts work.
 */
export class Readiness {
  #state: ReadinessState = 'starting';
  #reason = 'starting';
  #draining = false;
  readonly #checks = new Map<ReadyzCheckName, CheckFn>();
  readonly #clock: Clock;
  readonly #listeners = new Set<(state: ReadinessState, reason: string) => void>();
  #last: ReadyzBody | null = null;
  #evaluation: Promise<ReadyzBody> | null = null;
  readonly #gates = new Map<ReadyzCheckName, () => boolean>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** The current state. */
  get state(): ReadinessState {
    return this.#blockedGate() === undefined ? this.#state : 'not_ready';
  }

  /** Why the process is in its current state, for the `503 not_ready` body's `detail`. */
  get reason(): string {
    const blocked = this.#blockedGate();
    return blocked === undefined ? this.#reason : `${blocked}: unavailable`;
  }

  /** A local subsystem gate is checked at admission, even between asynchronous readiness probes. */
  blockWhen(name: ReadyzCheckName, blocked: () => boolean): void {
    this.#gates.set(name, blocked);
  }

  #blockedGate(): ReadyzCheckName | undefined {
    return [...this.#gates].find(([, blocked]) => blocked())?.[0];
  }

  /** Whether the shutdown drain has started; the `shutdown` check reads it. */
  get draining(): boolean {
    return this.#draining;
  }

  /** The most recent evaluation, which `GET /admin/system` embeds and `/metrics` samples. */
  get lastEvaluation(): ReadyzBody | null {
    return this.#last;
  }

  /** Registers a check. Registering a name twice replaces it, so a plugin can refine its own. */
  register(name: ReadyzCheckName, check: CheckFn): void {
    this.#checks.set(name, check);
  }

  /** Names registered so far — `readyz.integration` compares this with `READYZ_CHECK_NAMES`. */
  registered(): readonly ReadyzCheckName[] {
    return [...this.#checks.keys()];
  }

  /** Notifies on every transition; the ops plugin logs `readyz.degraded` / `readyz.recovered`. */
  onTransition(listener: (state: ReadinessState, reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts the drain: the state is `not_ready` from here and never returns to `ready`. */
  beginDrain(): void {
    this.#draining = true;
    this.#transition('not_ready', 'draining');
  }

  /**
   * Runs every registered check, updates the state from the fail-closed subset, and returns the
   * body served identically by `200` and `503`.
   *
   * A check that is not registered is served as `warn` with a detail naming the subsystem that has
   * not started rather than omitted, because the served name set must always equal
   * `ReadyzCheckName`: a check that disappears when its subsystem is absent would make the alert
   * expression that matches on it silently stop matching.
   */
  evaluate(): Promise<ReadyzBody> {
    // HTTP probes, the periodic recheck and boot share one complete scan. Starting a second
    // sixteen-check scan while MySQL is slow would multiply pool borrowers every five seconds.
    this.#evaluation ??= Promise.resolve()
      .then(() => this.#evaluate())
      .finally(() => {
        this.#evaluation = null;
      });
    return this.#evaluation;
  }

  async #evaluate(): Promise<ReadyzBody> {
    const checks: ReadyzCheck[] = [];
    for (const name of READYZ_CHECK_NAMES) {
      const check = this.#checks.get(name);
      const startedAt = this.#clock.monotonic();
      let outcome: CheckOutcome;
      if (check === undefined) {
        outcome = { status: 'warn', detail: 'not registered by any plugin in this build' };
      } else {
        try {
          // Sequential on purpose: a later check reads what an earlier one recorded (`grants` reads
          // the migration status `migrations` just took), and sixteen probes racing for the same pool
          // would make each one's measured duration a measure of the others.
          // eslint-disable-next-line no-await-in-loop -- checks are sequential by design; see above
          outcome = await check();
        } catch (error) {
          outcome = {
            status: 'fail',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const durationMs = Math.round(this.#clock.monotonic() - startedAt);
      checks.push(
        outcome.detail === undefined
          ? { name, status: outcome.status, durationMs }
          : { name, status: outcome.status, detail: outcome.detail, durationMs },
      );
    }

    const body: ReadyzBody = Object.freeze({
      status: worstStatus(checks.map((check) => check.status)),
      checks: Object.freeze(checks),
      checkedAt: toRfc3339(this.#clock.date()),
    });
    this.#last = body;
    this.#applyFailClosed(checks);
    return body;
  }

  /** Called by the boot path once every plugin has registered: leaves `starting`. */
  async finishBoot(): Promise<void> {
    if (this.#draining) return;
    await this.evaluate();
    if (this.#state === 'starting') this.#transition('ready', 'ready');
  }

  #applyFailClosed(checks: readonly ReadyzCheck[]): void {
    if (this.#draining) return;
    const blocking = checks.filter(
      (check) => FAIL_CLOSED_CHECKS.includes(check.name) && check.status === 'fail',
    );
    if (blocking.length > 0) {
      const first = blocking[0];
      this.#transition(
        'not_ready',
        first === undefined
          ? 'a fail-closed readiness check failed'
          : `${first.name}: ${first.detail ?? 'failed'}`,
      );
      return;
    }
    if (this.#state === 'not_ready') this.#transition('ready', 'ready');
  }

  #transition(state: ReadinessState, reason: string): void {
    if (this.#state === state && this.#reason === reason) return;
    this.#state = state;
    this.#reason = reason;
    for (const listener of this.#listeners) listener(state, reason);
  }
}
