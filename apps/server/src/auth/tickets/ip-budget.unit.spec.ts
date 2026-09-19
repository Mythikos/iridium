/**
 * `auth.ticket-ip-budget.unit` (04-auth-and-access-control.md sections 7.4 and 10.1): the
 * fixed-window counter behind the per-IP ticket budget — `max` hits per key per window, a refusal
 * naming the wait until the window ends, an independent window per key, a fresh window once the
 * previous one has ended, and a sweep on the injected clock that keeps the map bounded.
 */
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../../test/support/manual-clock.ts';
import { WindowedBudget } from './ip-budget.ts';

const WINDOW_MS = 60_000;
const MAX = 3;

function budget(clock: ManualClock = new ManualClock()) {
  return { clock, budget: new WindowedBudget({ clock, max: MAX, windowMs: WINDOW_MS }) };
}

describe('auth.ticket-ip-budget.unit [area:auth]', () => {
  it('allows max hits per key per window, then refuses with the wait until the window ends', () => {
    const { clock, budget: subject } = budget();
    expect(subject.hit('a')).toStrictEqual({ allowed: true, remaining: 2 });
    expect(subject.hit('a')).toStrictEqual({ allowed: true, remaining: 1 });
    expect(subject.hit('a')).toStrictEqual({ allowed: true, remaining: 0 });
    clock.jump(clock.now() + 1000);
    expect(subject.hit('a')).toStrictEqual({ allowed: false, retryAfterMs: WINDOW_MS - 1000 });
    // Another key has its own window.
    expect(subject.hit('b')).toStrictEqual({ allowed: true, remaining: 2 });
    expect(subject.size).toBe(2);
  });

  it('opens a fresh window once the previous one has ended', () => {
    const { clock, budget: subject } = budget();
    for (let hit = 0; hit < MAX; hit += 1) subject.hit('a');
    expect(subject.hit('a').allowed).toBe(false);
    clock.jump(clock.now() + WINDOW_MS);
    expect(subject.hit('a')).toStrictEqual({ allowed: true, remaining: 2 });
  });

  it('sweeps ended windows on the timer and on demand, and stops the timer on close', async () => {
    const { clock, budget: subject } = budget();
    subject.hit('a');
    subject.hit('b');
    expect(clock.pendingTimers).toBe(1);
    await clock.advance(WINDOW_MS - 1);
    expect(subject.size).toBe(2);
    await clock.advance(1);
    expect(subject.size).toBe(0);
    subject.hit('c');
    clock.jump(clock.now() + WINDOW_MS);
    // A sweep drops only the windows that have ended; one opened just now stays.
    subject.hit('d');
    expect(subject.sweepExpired()).toBe(1);
    expect(subject.size).toBe(1);
    expect(subject.sweepExpired()).toBe(0);
    subject.close();
    subject.close();
    expect(clock.pendingTimers).toBe(0);
  });
});
