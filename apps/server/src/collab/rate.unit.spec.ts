/**
 * `collab.rate.unit` — the fixed window behind the three "N per window" caps of 09-api-reference.md
 * §3.10 (message rate, awareness rate, `flush` budget).
 */
import { describe, expect, it } from 'vitest';

import { RateWindow } from './rate.ts';

describe('collab.rate.unit [area:collab]', () => {
  it('admits exactly `max` events inside one window and refuses the next', () => {
    const window = new RateWindow(3, 1_000);
    expect([window.take(0), window.take(10), window.take(20)]).toEqual([true, true, true]);
    expect(window.take(30)).toBe(false);
    expect(window.count).toBe(3);
  });

  it('does not count a refused event, so refusals never extend the refusal', () => {
    const window = new RateWindow(1, 1_000);
    expect(window.take(0)).toBe(true);
    for (let attempt = 0; attempt < 50; attempt += 1) expect(window.take(500)).toBe(false);
    expect(window.count).toBe(1);
  });

  it('opens a fresh window once `windowMs` has elapsed since the window started', () => {
    const window = new RateWindow(2, 1_000);
    window.take(0);
    window.take(1);
    expect(window.take(999)).toBe(false);
    expect(window.take(1_000)).toBe(true);
    expect(window.count).toBe(1);
  });

  it('starts its first window at the first event, whatever the clock reads', () => {
    const window = new RateWindow(1, 1_000);
    expect(window.take(5_000_000)).toBe(true);
    expect(window.take(5_000_999)).toBe(false);
    expect(window.take(5_001_000)).toBe(true);
  });
});
