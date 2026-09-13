import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WAIT_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  WaitTimeoutError,
  createDeferred,
  waitFor,
  withDeadline,
} from './harness/deadline.ts';
import { reserveLoopbackPort } from './harness/free-port.ts';

describe('testkit.deadline.unit [area:testkit]', () => {
  it('returns the first value the probe produces', async () => {
    let calls = 0;
    const value = await waitFor(
      () => {
        calls += 1;
        return calls < 3 ? undefined : `ready after ${String(calls)}`;
      },
      { intervalMs: 1, description: 'the probe to produce a value' },
    );
    expect(value).toBe('ready after 3');
  });

  it('treats false as "not yet", so a boolean probe reads naturally', async () => {
    let ready = false;
    const promise = waitFor(() => ready, { intervalMs: 1, timeoutMs: 2000 });
    ready = true;
    await expect(promise).resolves.toBe(true);
  });

  it('names what it was waiting for when the deadline wins', async () => {
    await expect(
      waitFor(() => undefined, {
        timeoutMs: 20,
        intervalMs: 1,
        description: '/readyz to answer 200',
      }),
    ).rejects.toThrow(/timed out after 20 ms waiting for \/readyz to answer 200/);
  });

  it('reports the last failure rather than only the timeout', async () => {
    await expect(
      waitFor(
        () => {
          throw new Error('ECONNREFUSED 127.0.0.1:4000');
        },
        { timeoutMs: 20, intervalMs: 1, description: 'the server to accept a connection' },
      ),
    ).rejects.toThrow(/last attempt failed with: Error: ECONNREFUSED/);
  });

  it('carries the timeout and the description on the error', async () => {
    const error = await waitFor(() => undefined, {
      timeoutMs: 15,
      intervalMs: 1,
      description: 'a condition that never holds',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 15, description: 'a condition that never holds' });
  });

  it('stops early when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitFor(() => undefined, { timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it('publishes the defaults the projects are configured against', () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_WAIT_INTERVAL_MS).toBe(25);
  });

  it('settles a deferred from outside', async () => {
    const deferred = createDeferred<number>();
    deferred.resolve(7);
    await expect(deferred.promise).resolves.toBe(7);

    const failing = createDeferred<number>();
    failing.reject(new Error('no'));
    await expect(failing.promise).rejects.toThrow('no');
  });

  it('passes a promise through when it settles inside the budget', async () => {
    await expect(withDeadline(Promise.resolve('fast'), { timeoutMs: 1000 })).resolves.toBe('fast');
    await expect(
      withDeadline(Promise.reject(new Error('own failure')), { timeoutMs: 1000 }),
    ).rejects.toThrow('own failure');
  });

  it('rejects a promise that misses the budget, and leaves no unhandled rejection behind', async () => {
    await expect(
      withDeadline(delay(5000, 'slow'), { timeoutMs: 10, description: 'a slow operation' }),
    ).rejects.toThrow(/timed out after 10 ms waiting for a slow operation/);
    // The winning branch aborts the timer; if that abort rejected unhandled, this tick would report it.
    await delay(20);
  });

  it('reserves a distinct free loopback port each time', async () => {
    const [a, b] = await Promise.all([reserveLoopbackPort(), reserveLoopbackPort()]);
    expect(a).toBeGreaterThan(1024);
    expect(b).toBeGreaterThan(1024);
    expect(a).not.toBe(b);
  });
});
