/**
 * The shutdown drain (ARCH-06; 11-operations-and-deployment.md, "Graceful shutdown (what drain actually
 * does)"; 05-collaboration-and-durability.md, "Server restart and recovery").
 *
 * One ordered sequence, one deadline, one owner. The nine steps of 11's subsection are not nine functions
 * in this module: most of them belong to the subsystem that owns the state being drained, and a drain that
 * reached into those subsystems would be a second place that knows how a `NoteWriter` finishes. So this
 * module owns the **order and the deadline**, and each subsystem registers a hook in the phase the plan
 * puts it in:
 *
 * | Phase | 11's steps | Registered by |
 * |---|---|---|
 * | — | 1, 2: `shutdown.started`, `/readyz` → `shutdown: fail`, new upgrades refused | this module |
 * | `jobs` | 3: the scheduler stops claiming | `jobs` (boot step 12) |
 * | `collab` | 4, 5: `closing {reason:'shutdown', graceMs}`, then close `4205` | `collab` (boot step 8) |
 * | `writers` | 6: every `NoteWriter` queue drains to COMMIT | `collab/persistence` |
 * | `unload` | 7, 8: `flushPendingStores()`, then `destroy()` until no documents remain | `collab` |
 * | `resources` | 9: the piscina pool, then the pino stream | `projection`, `ops` |
 *
 * The pools are closed by `buildApp`'s `onClose` hook rather than by a `resources` hook, because Fastify
 * owns the order of `close()` and the database handle is decorated in boot step 2.
 *
 * **The order is the contract, and it is not interchangeable.** The closes of step 5 come *before* the
 * flush of step 7 precisely so each document's pending store fires with `clientsCount === 0` and the
 * compaction trigger is `unload` rather than `debounce` — which is what makes invariant I-10 ("after the
 * drain every loaded note has a `note_revisions` row at its `head_seq`") true. A hook registered in the
 * wrong phase does not merely run late; it breaks that invariant silently.
 *
 * **The deadline is hard.** `SHUTDOWN_DRAIN_MS` (20 000) bounds the whole sequence, because a writer
 * parked in `failed` or `backpressure` keeps vetoing its unload and step 8 would otherwise block forever.
 * When the deadline wins, `DrainTimeoutError` names the phase and whatever the hook reported as undrained;
 * `main.ts` logs `persist.drain_timeout` at `error` and exits `1`. Acknowledged edits are safe regardless —
 * they are committed by definition; what is lost is unacknowledged keystrokes and the currency of
 * checkpoints and projections, both recovered on the next load.
 */
import type { Clock, TimerHandle } from './clock.ts';
import type { ServerLogger } from './logging.ts';
import type { Readiness } from './readiness.ts';

/** The phases of 11's sequence a subsystem may register in, in the order they run. */
export const DRAIN_PHASES = ['jobs', 'collab', 'writers', 'unload', 'resources'] as const;

/** One phase of the drain. */
export type DrainPhase = (typeof DRAIN_PHASES)[number];

/** What a hook reports when it could not finish inside the deadline. */
export interface DrainProgress {
  /** Names of whatever is still undrained — note ids for a writer, job ids for the scheduler. */
  readonly undrained: readonly string[];
}

/** A registered hook. `run` must be idempotent: a second SIGTERM must not start a second drain. */
export interface DrainHook {
  readonly phase: DrainPhase;
  /** The subsystem, as it appears in the log line and in a timeout message. */
  readonly name: string;
  run(): Promise<void>;
  /** Captures owned lifetimes synchronously before any drain phase can retire them. No I/O. */
  capture?(): void;
  /** Asked only when the deadline won, so a timeout names what was still in flight. */
  progress?(): DrainProgress;
}

/** Thrown when the drain did not finish inside `SHUTDOWN_DRAIN_MS`. */
export class DrainTimeoutError extends Error {
  readonly code = 'persist.drain_timeout';
  readonly exitCode = 1;
  readonly phase: DrainPhase | null;
  readonly undrained: readonly string[];

  constructor(phase: DrainPhase | null, undrained: readonly string[], budgetMs: number) {
    super(
      `the shutdown drain did not finish inside SHUTDOWN_DRAIN_MS (${String(budgetMs)}ms)` +
        (phase === null ? '' : `; it was in the ${phase} phase`) +
        (undrained.length === 0 ? '. ' : `, with ${undrained.join(', ')} still undrained. `) +
        'Every acknowledged edit is committed by definition, so nothing durable was lost; what was lost ' +
        'is unacknowledged keystrokes and the currency of checkpoints and projections, both recovered on ' +
        'the next load. A writer parked in `failed` or `backpressure` is the usual cause — see ' +
        'docs/runbooks/persist-failed.md.',
    );
    this.name = 'DrainTimeoutError';
    this.phase = phase;
    this.undrained = undrained;
  }
}

export interface ShutdownDrainOptions {
  readonly readiness: Readiness;
  readonly clock: Clock;
  readonly logger: ServerLogger;
  /** `SHUTDOWN_DRAIN_MS`. */
  readonly budgetMs: number;
}

/**
 * The drain. One per Fastify instance; `app.drain()` is its `run()` and `app.onDrain()` is its `register()`.
 *
 * It is a class rather than a closure because it owns state with a lifetime — the hook table and the
 * single in-flight run — and because a second SIGTERM must join the first drain rather than start another.
 */
export class ShutdownDrain {
  readonly #options: ShutdownDrainOptions;
  readonly #hooks: DrainHook[] = [];
  #running: Promise<void> | null = null;

  constructor(options: ShutdownDrainOptions) {
    this.#options = options;
  }

  /**
   * Registers a hook in its phase. Registration order inside one phase is preserved, and phases run in
   * the order `DRAIN_PHASES` lists.
   *
   * @throws Error when the drain has already started: a subsystem that registers during a drain would
   * either be skipped silently or extend a budget that has already been committed to.
   */
  register(hook: DrainHook): void {
    if (this.#running !== null) {
      throw new Error(
        `${hook.name} tried to register a ${hook.phase} drain hook while the drain was already running. ` +
          'Register every drain hook at its boot step, so the sequence of ARCH-06 is fixed before a ' +
          'SIGTERM can arrive.',
      );
    }
    this.#hooks.push(hook);
  }

  /** The registered hooks, in the order they will run — what `shutdown.drain.integration` asserts. */
  get hooks(): readonly DrainHook[] {
    return DRAIN_PHASES.flatMap((phase) => this.#hooks.filter((hook) => hook.phase === phase));
  }

  /** Whether a drain has started. The `shutdown` readiness check reads `Readiness.draining` instead. */
  get started(): boolean {
    return this.#running !== null;
  }

  /**
   * Runs the drain once. A second call joins the first.
   *
   * @throws DrainTimeoutError when the sequence did not finish inside the budget.
   */
  async run(): Promise<void> {
    if (this.#running === null) {
      const completion = Promise.withResolvers<void>();
      // Publish ownership before capture hooks: a reentrant drain joins this same execution.
      this.#running = completion.promise;
      this.#drain().then(completion.resolve, completion.reject);
    }
    return this.#running;
  }

  async #drain(): Promise<void> {
    const { readiness, clock, logger, budgetMs } = this.#options;
    for (const hook of this.#hooks) hook.capture?.();
    logger.info({ event: 'shutdown.started' }, 'draining');
    // Steps 1 and 2: the proxy is told to stop routing before anything is closed, and `/readyz` is the
    // single place that decides it.
    readiness.beginDrain();

    let currentPhase: DrainPhase | null = null;
    const sequence = (async (): Promise<void> => {
      for (const phase of DRAIN_PHASES) {
        currentPhase = phase;
        for (const hook of this.#hooks.filter((candidate) => candidate.phase === phase)) {
          // Strictly sequential: the whole point of the phase table is that step 5 completes before
          // step 7 begins, and `Promise.all` across phases would destroy that.
          // eslint-disable-next-line no-await-in-loop -- the drain is an ordered sequence by definition
          await hook.run();
        }
      }
      currentPhase = null;
    })();

    let deadline: TimerHandle | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      deadline = clock.after(budgetMs, () => resolve('timeout'));
    });

    try {
      const outcome = await Promise.race([sequence.then(() => 'drained' as const), timeout]);
      if (outcome === 'timeout') {
        const undrained = this.#hooks.flatMap((hook) => hook.progress?.().undrained ?? []);
        throw new DrainTimeoutError(currentPhase, undrained, budgetMs);
      }
      logger.info({ event: 'shutdown.drained' }, 'drained');
    } finally {
      deadline?.cancel();
      // The sequence keeps running after a timeout — a writer that is still committing must not be
      // abandoned mid-transaction — so its rejection is attached here rather than left unhandled.
      sequence.catch((error: unknown) => {
        logger.error({ err: error, event: 'persist.drain_timeout' }, 'a drain hook failed');
      });
    }
  }
}
