/**
 * `WriterScheduler` — the global round-robin over the persist pool (05-collaboration-and-durability.md,
 * "Global fairness and the persist pool").
 *
 * `dbPersist` is small and reserved: one connection holds the owner lease for the life of the process,
 * the rest belong to the writers and the compactor. A single scheduler owns that many *slots*. A
 * writer with work joins a FIFO ready ring; a scheduled writer takes one slot, runs exactly one unit
 * of work (a batch, or a compaction job), releases the slot and, if it still has work, rejoins the
 * **back** of the ring. Round-robin at batch granularity is what keeps one pathological note from
 * monopolising the pool: with N busy writers and S slots, no writer waits longer than `ceil(N / S)`
 * batch latencies.
 *
 * A writer parked on a retry timer is not in the ring and holds no slot; it rejoins when the timer
 * fires. The scheduler knows nothing about a writer beyond `runOne()` and `hasWork()`, which is what
 * makes it the seam a multi-process deployment would replace.
 */

/** What the scheduler drives. */
export interface Schedulable {
  /** Runs one batch or one job. Must never reject: the writer owns its failure handling. */
  runOne(): Promise<void>;
  /** Whether the writer wants another turn once this one ends. */
  hasWork(): boolean;
}

/** What the scheduler needs to report a bug in a writer. */
export interface SchedulerLogger {
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** The scheduler. One per process, owned by the persistence layer. */
export class WriterScheduler {
  readonly #slots: number;
  readonly #ring: Schedulable[] = [];
  readonly #queued = new Set<Schedulable>();
  readonly #running = new Set<Schedulable>();
  readonly #logger: SchedulerLogger;
  #idleWaiters: Array<() => void> = [];
  readonly #turnWaiters = new Map<Schedulable, Array<() => void>>();

  constructor(slots: number, logger: SchedulerLogger) {
    this.#slots = Math.max(1, Math.floor(slots));
    this.#logger = logger;
  }

  /** Slots the scheduler hands out at once. */
  get slots(): number {
    return this.#slots;
  }

  /** Writers running right now. */
  get running(): number {
    return this.#running.size;
  }

  /** Writers waiting for a slot. */
  get waiting(): number {
    return this.#ring.length;
  }

  /** Joins the ring unless the writer is already queued or running. Returns immediately. */
  ready(writer: Schedulable): void {
    if (this.#queued.has(writer) || this.#running.has(writer)) return;
    this.#queued.add(writer);
    this.#ring.push(writer);
    this.#dispatch();
  }

  /** Removes a writer that is disposed; a running turn finishes on its own. */
  forget(writer: Schedulable): void {
    if (!this.#queued.has(writer)) return;
    this.#queued.delete(writer);
    const index = this.#ring.indexOf(writer);
    if (index !== -1) this.#ring.splice(index, 1);
  }

  /** Resolves once no writer is running or waiting — the drain's "every writer finished" signal. */
  async idle(): Promise<void> {
    if (this.#running.size === 0 && this.#ring.length === 0) return;
    await new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  /** Joins this writer's current turn after its caller has fenced future scheduling. */
  async settle(writer: Schedulable): Promise<void> {
    if (!this.#running.has(writer)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.#turnWaiters.get(writer) ?? [];
      waiters.push(resolve);
      this.#turnWaiters.set(writer, waiters);
    });
  }

  #dispatch(): void {
    while (this.#running.size < this.#slots) {
      const next = this.#ring.shift();
      if (next === undefined) break;
      this.#queued.delete(next);
      this.#running.add(next);
      void this.#turn(next);
    }
    this.#settleIdle();
  }

  async #turn(writer: Schedulable): Promise<void> {
    try {
      await writer.runOne();
    } catch (error) {
      // A writer owns its failures; a rejection here is a bug, and the ring must keep turning.
      this.#logger.error(
        { err: error },
        'a NoteWriter turn rejected; the writer must never reject',
      );
    } finally {
      this.#running.delete(writer);
      for (const resolve of this.#turnWaiters.get(writer) ?? []) resolve();
      this.#turnWaiters.delete(writer);
      if (writer.hasWork()) this.ready(writer);
      else this.#dispatch();
    }
  }

  #settleIdle(): void {
    if (this.#running.size > 0 || this.#ring.length > 0 || this.#idleWaiters.length === 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
