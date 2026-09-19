import { describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { createLogger } from './logging.ts';
import { Readiness } from './readiness.ts';
import { DrainTimeoutError, ShutdownDrain } from './shutdown.ts';

function setup() {
  const clock = new ManualClock();
  const readiness = new Readiness(clock);
  const logger = createLogger({ level: 'silent', format: 'json', instanceId: 'shutdown-unit' });
  const drain = new ShutdownDrain({
    clock,
    readiness,
    budgetMs: 20_000,
    logger,
  });
  return { clock, readiness, drain, logger };
}

describe('ops.shutdown.unit [hp:HP-2]', () => {
  it('captures every owned lifetime before the first async phase and joins a reentrant signal', async () => {
    const { clock, readiness, drain } = setup();
    const jobs = Promise.withResolvers<void>();
    const observations: string[] = [];
    const reentrant: Promise<void>[] = [];
    drain.register({
      phase: 'jobs',
      name: 'jobs',
      run: async () => {
        observations.push('jobs');
        await jobs.promise;
      },
    });
    drain.register({
      phase: 'writers',
      name: 'writers',
      capture: () => {
        observations.push('captured');
        reentrant.push(drain.run());
      },
      run: async () => {
        observations.push('writers');
      },
    });
    expect(drain.started).toBe(false);
    expect(drain.hooks.map((hook) => hook.name)).toEqual(['jobs', 'writers']);
    const running = drain.run();
    expect(drain.started).toBe(true);
    expect(readiness.draining).toBe(true);
    expect(observations).toEqual(['captured', 'jobs']);
    expect(() =>
      drain.register({ phase: 'resources', name: 'late', run: async () => undefined }),
    ).toThrow('already running');
    jobs.resolve();
    await running;
    await Promise.all(reentrant);
    await drain.run();
    expect(observations).toEqual(['captured', 'jobs', 'writers']);
    expect(clock.pendingTimers).toBe(0);
  });

  it('retains the one failed capture outcome and never enters a later phase', async () => {
    const { clock, drain } = setup();
    const failure = new Error('cannot capture owned work');
    let ran = false;
    let captures = 0;
    drain.register({
      phase: 'writers',
      name: 'writers',
      capture: () => {
        captures += 1;
        throw failure;
      },
      run: async () => {
        ran = true;
      },
    });
    await expect(drain.run()).rejects.toBe(failure);
    await expect(drain.run()).rejects.toBe(failure);
    expect(captures).toBe(1);
    expect(ran).toBe(false);
    expect(clock.pendingTimers).toBe(0);
  });

  it('observes a late writer rejection after deadline expiry without releasing later resources', async () => {
    const { clock, drain, logger } = setup();
    const writer = Promise.withResolvers<void>();
    const failed = vi.spyOn(logger, 'error');
    const information = vi.spyOn(logger, 'info');
    const failure = new Error('the captured writer lost its owner');
    let released = false;
    drain.register({
      phase: 'writers',
      name: 'writers',
      run: () => writer.promise,
      progress: () => ({ undrained: ['captured-note'] }),
    });
    drain.register({
      phase: 'resources',
      name: 'lease',
      run: async () => {
        released = true;
      },
    });
    const outcome = drain.run().catch((error: unknown) => error);
    await clock.advance(20_000);
    const timeout = await outcome;
    expect(timeout).toBeInstanceOf(DrainTimeoutError);
    expect(failed).not.toHaveBeenCalled();
    writer.reject(failure);
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      { err: failure, event: 'persist.drain_timeout' },
      'a drain hook failed',
    );
    expect(information).toHaveBeenCalledExactlyOnceWith({ event: 'shutdown.started' }, 'draining');
    expect(released).toBe(false);
    await expect(drain.run()).rejects.toBe(timeout);
    expect(clock.pendingTimers).toBe(0);
  });

  it('keeps the full deadline and note identities while a real owned phase remains pending', async () => {
    const { clock, drain } = setup();
    const writer = Promise.withResolvers<void>();
    let released = false;
    drain.register({
      phase: 'writers',
      name: 'writers',
      run: () => writer.promise,
      progress: () => ({ undrained: ['captured-note'] }),
    });
    drain.register({
      phase: 'resources',
      name: 'lease',
      run: async () => {
        released = true;
      },
    });
    const outcome = drain.run().then(
      () => null,
      (error: unknown) => error,
    );
    await clock.advance(19_999);
    expect(released).toBe(false);
    await clock.advance(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(DrainTimeoutError);
    expect(error).toMatchObject({ phase: 'writers', undrained: ['captured-note'], exitCode: 1 });
    expect(released).toBe(false);
    expect(clock.pendingTimers).toBe(0);
    writer.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(true);
  });
});
