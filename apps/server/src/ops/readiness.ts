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
 * Only `migrations` is **fail-closed**: a pending migration flips the state, because a server whose
 * schema is behind its code must never handle a request. Every other check failing makes `/readyz`
 * answer `503` while the server keeps serving, because a degraded Iridium that still lets people
 * read their notes is better than a closed door (11, "Boot sequence and fail-closed readiness").
 */
import { toRfc3339, type Clock } from './clock.ts';

/**
 * The fifteen readiness checks. This list is `ReadyzCheckName` in 09-api-reference.md section 2.17
 * and the readiness table of 11-operations-and-deployment.md; the same strings are the `check` label
 * of `iridium_readyz_check_status` and what the alert expressions match on. `readyz.integration`
 * asserts the served set equals it exactly, so the three cannot drift apart.
 */
export const READYZ_CHECK_NAMES = [
  'mysql_version',
  'db_app',
  'db_persist',
  'migrations',
  'grants',
  'durability',
  'attachment_store',
  'persist_backlog',
  'doc_budget',
  'projection_workers',
  'clock_skew',
  'key_versions',
  'tls_cert',
  'shutdown',
  'access_log_partitions',
] as const;

/** One of the fifteen readiness check names. */
export type ReadyzCheckName = (typeof READYZ_CHECK_NAMES)[number];

/** The per-check and overall vocabulary. A single `fail` makes the whole response `503`. */
export type ReadyzStatus = 'ok' | 'warn' | 'fail';

/** The checks whose failure flips `ReadinessState` and gates every non-ops route. */
export const FAIL_CLOSED_CHECKS: readonly ReadyzCheckName[] = Object.freeze(['migrations']);

/** What one check returns. `durationMs` is measured by the runner, never by the check. */
export interface CheckOutcome {
  readonly status: ReadyzStatus;
  readonly detail?: string;
}

/** One check as served: the outcome plus its name and measured duration. */
export interface ReadyzCheck extends CheckOutcome {
  readonly name: ReadyzCheckName;
  readonly durationMs: number;
}

/** The `/readyz` body of 09-api-reference.md section 2.17, served identically with `200` and `503`. */
export interface ReadyzBody {
  readonly status: ReadyzStatus;
  readonly checks: readonly ReadyzCheck[];
  readonly checkedAt: string;
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

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** The current state. */
  get state(): ReadinessState {
    return this.#state;
  }

  /** Why the process is in its current state, for the `503 not_ready` body's `detail`. */
  get reason(): string {
    return this.#reason;
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
  async evaluate(): Promise<ReadyzBody> {
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
          // the migration status `migrations` just took), and fifteen probes racing for the same pool
          // would make each one's measured duration a measure of the others.
          // eslint-disable-next-line no-await-in-loop
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
