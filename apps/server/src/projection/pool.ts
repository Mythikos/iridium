/** The process-owned worker pool for Markdown and reference scans (08 section 2.11). */
import { LIMITS } from '@iridium/contracts';
import { Piscina } from 'piscina';

import type { Clock } from '../ops/clock.ts';

/** Admission failure leaves raw source committed as pending for the bounded stale sweep. */
export class ProjectionQueueFull extends Error {
  constructor() {
    super('Projection queue is full; retry through the stale projection sweep.');
    this.name = 'ProjectionQueueFull';
  }
}

/** Worker deadlines terminate the executing thread before its replacement accepts work. */
export class ProjectionTimedOut extends Error {
  constructor(timeoutMs: number) {
    super(`Projection worker exceeded ${timeoutMs} ms; the worker was terminated.`);
    this.name = 'ProjectionTimedOut';
  }
}

/** Worker count and deadlines come from validated configuration; time remains injectable. */
export interface ProjectionPoolOptions {
  readonly workers: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
  /** @internal A dedicated worker fixture can exercise cancellation and queue admission. */
  readonly filename?: string;
}

/** One bounded process resource, shared by all CPU-heavy projection jobs. */
export class ProjectionPool {
  #pool: Piscina | null = null;
  readonly #options: ProjectionPoolOptions;
  #closed = false;
  #closing: Promise<void> | null = null;
  #admitted = 0;

  constructor(options: ProjectionPoolOptions) {
    this.#options = options;
  }

  #workers(): Piscina {
    if (this.#pool !== null) return this.#pool;
    const options = this.#options;
    this.#pool = new Piscina({
      filename:
        options.filename ??
        new URL(
          import.meta.url.endsWith('.ts') ? './worker.ts' : './projection.worker.mjs',
          import.meta.url,
        ).href,
      minThreads: 1,
      maxThreads: options.workers,
      maxQueue: LIMITS.PROJECTION_QUEUE_MAX,
      idleTimeout: LIMITS.PROJECTION_WORKER_IDLE_MS,
      resourceLimits: {
        maxOldGenerationSizeMb: LIMITS.PROJECTION_WORKER_HEAP_MB,
        stackSizeMb: LIMITS.PROJECTION_WORKER_STACK_MB,
      },
    });
    return this.#pool;
  }

  /** Includes executing and queued tasks, so admission stays bounded between calls to run(). */
  get pending(): number {
    return this.#admitted;
  }

  /** Closing is observable by readiness without scheduling a synthetic parse. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Schedules one task; cancellation and shutdown always await Piscina's terminal result. */
  async run<T>(task: unknown, options: { readonly filename?: string } = {}): Promise<T> {
    if (this.#closed) throw new ProjectionPoolClosed();
    if (this.#admitted >= this.#options.workers + LIMITS.PROJECTION_QUEUE_MAX) {
      throw new ProjectionQueueFull();
    }
    this.#admitted += 1;
    const controller = new AbortController();
    const timer = this.#options.clock.after(this.#options.timeoutMs, () => controller.abort());
    try {
      const result: T = await this.#workers().run(task, {
        signal: controller.signal,
        ...(options.filename === undefined ? {} : { filename: options.filename }),
      });
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new ProjectionTimedOut(this.#options.timeoutMs);
      throw error;
    } finally {
      timer.cancel();
      this.#admitted -= 1;
    }
  }

  /** The owner drains writers first, then releases every worker and queued task. */
  async close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#closing = this.#pool?.destroy() ?? Promise.resolve();
    await this.#closing;
  }
}

/** A terminated pool cannot silently recreate workers after application shutdown. */
export class ProjectionPoolClosed extends Error {
  constructor() {
    super('Projection pool is closed; submit work only during the application lifetime.');
    this.name = 'ProjectionPoolClosed';
  }
}
