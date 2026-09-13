/**
 * Deadlines for the harness.
 *
 * Everything the suite waits for has an explicit deadline and a description, because
 * 10-testing-and-quality.md's flake policy allows exactly four ways to wait — `expect.poll` with a
 * deadline, an injected clock, a Toxiproxy toxic, or a test lock — and forbids the fifth, a sleep.
 * These helpers are the harness-internal form of the first: they never sleep for a fixed period in
 * place of an observation, and a timeout message names what was being waited for so the failure reads
 * as a fact rather than "timed out".
 */
import { setTimeout as delay } from 'node:timers/promises';

export interface WaitOptions {
  /** Total budget. Defaults to 10 000 ms, the `unit` project's `testTimeout`. */
  readonly timeoutMs?: number;
  /** Poll interval. Defaults to 25 ms. */
  readonly intervalMs?: number;
  /** Named in the timeout error: "timed out after 10000 ms waiting for <description>". */
  readonly description?: string;
  readonly signal?: AbortSignal;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
export const DEFAULT_WAIT_INTERVAL_MS = 25;

/** Render an unknown thrown value without relying on its `toString`. */
function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value) ?? 'a non-serialisable value';
}

export class WaitTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly description: string;

  constructor(description: string, timeoutMs: number, lastError?: unknown) {
    const because =
      lastError === undefined ? '' : `; last attempt failed with: ${describeThrown(lastError)}`;
    super(
      `@iridium/testkit: timed out after ${String(timeoutMs)} ms waiting for ${description}${because}`,
    );
    this.name = 'WaitTimeoutError';
    this.timeoutMs = timeoutMs;
    this.description = description;
  }
}

/**
 * Poll `probe` until it returns a value that is neither `undefined` nor `false`, then return it.
 * A throwing probe is treated as "not yet" and its error is reported if the deadline wins, so a
 * connection-refused loop reports the refusal instead of a bare timeout.
 */
export async function waitFor<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const description = options.description ?? 'a condition';
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    options.signal?.throwIfAborted();
    try {
      // Polling is sequential by definition: the next probe is only interesting once this one failed.
      // eslint-disable-next-line no-await-in-loop
      const value = await probe();
      if (value !== undefined && value !== false) {
        return value;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new WaitTimeoutError(description, timeoutMs, lastError);
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/** A promise plus its settlers, for adapting an event source to a deadline. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Reject `promise` with a described timeout if it has not settled inside the budget. The underlying
 * work is not cancelled — callers that own a socket or a process close it in their own `finally`.
 */
export async function withDeadline<T>(promise: Promise<T>, options: WaitOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const description = options.description ?? 'an operation';
  const controller = new AbortController();
  // On abort the timer settles into a promise that never resolves, so winning the race cannot leave
  // an unhandled rejection behind — the failure mode that makes a whole Vitest worker die later.
  const timer: Promise<never> = delay(timeoutMs, undefined, { signal: controller.signal }).then(
    (): never => {
      throw new WaitTimeoutError(description, timeoutMs);
    },
    (): Promise<never> => new Promise<never>(() => undefined),
  );
  try {
    return await Promise.race([promise, timer]);
  } finally {
    controller.abort();
  }
}
