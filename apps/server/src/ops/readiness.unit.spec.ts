import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { Readiness, type CheckOutcome } from './readiness.ts';

describe('ops.readiness.unit [area:ops]', () => {
  it('joins concurrent probes and boot, then starts a fresh evaluation after completion', async () => {
    const readiness = new Readiness(new ManualClock());
    const pending = Promise.withResolvers<CheckOutcome>();
    let probes = 0;
    readiness.register('db_app', () => {
      probes += 1;
      return pending.promise;
    });
    const first = readiness.evaluate();
    const second = readiness.evaluate();
    const boot = readiness.finishBoot();
    try {
      await Promise.resolve();
      expect(probes).toBe(1);
    } finally {
      pending.resolve({ status: 'ok' });
      await Promise.all([first, second, boot]);
    }
    expect(await first).toBe(await second);
    expect(readiness.state).toBe('ready');
    await readiness.evaluate();
    expect(probes).toBe(2);
  });

  it('shares a failed check without caching it into the next recovery probe', async () => {
    const readiness = new Readiness(new ManualClock());
    const pending = Promise.withResolvers<CheckOutcome>();
    readiness.register('migrations', () => pending.promise);
    const first = readiness.evaluate();
    const second = readiness.evaluate();
    pending.reject(new Error('database unavailable'));
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left.checks).toContainEqual({
      name: 'migrations',
      status: 'fail',
      detail: 'database unavailable',
      durationMs: 0,
    });
    expect(readiness.state).toBe('not_ready');
    readiness.register('migrations', () => ({ status: 'ok' }));
    expect((await readiness.evaluate()).checks).toContainEqual({
      name: 'migrations',
      status: 'ok',
      durationMs: 0,
    });
    expect(readiness.state).toBe('ready');
  });

  it('cannot reopen admission when a shared boot probe finishes during the drain', async () => {
    const readiness = new Readiness(new ManualClock());
    const pending = Promise.withResolvers<CheckOutcome>();
    readiness.register('migrations', () => pending.promise);
    readiness.register('shutdown', () => ({ status: readiness.draining ? 'fail' : 'ok' }));
    const boot = readiness.finishBoot();
    const observation = readiness.evaluate();
    readiness.beginDrain();
    pending.resolve({ status: 'ok' });
    await boot;
    expect((await observation).status).toBe('fail');
    expect(readiness.state).toBe('not_ready');
    expect(readiness.reason).toBe('draining');
  });
});
