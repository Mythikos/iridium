// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form; each `expect` runs inside the property's own test body.
/**
 * `writer.backoff.prop` — the retry policy of 05-collaboration-and-durability.md, "Failure handling,
 * retry and `persist-failed`": bounded by the 5 s ceiling, jittered, monotone in the attempt count,
 * and escalating to `failed` after 10 attempts or 30 s.
 */
import { it } from '@fast-check/vitest';
import { PROP } from '@iridium/testkit';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import {
  BACKOFF_BASE_MS,
  BACKOFF_CEILING_MS,
  backoffCeilingMs,
  FAILED_AFTER_ATTEMPTS,
  FAILED_AFTER_MS,
  hasFailed,
  retryDelayMs,
} from './backoff.ts';

const attempts = fc.integer({ min: 1, max: 60 });
const unit = fc.double({ min: 0, max: 1, noNaN: true });

describe('writer.backoff.prop [area:collab]', () => {
  it.prop([attempts, unit], PROP)(
    'never exceeds the ceiling and is never negative',
    (attempt, r) => {
      const delay = retryDelayMs(attempt, () => r);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(BACKOFF_CEILING_MS);
      expect(Number.isInteger(delay)).toBe(true);
    },
  );

  it.prop([attempts, attempts], PROP)('has a ceiling monotone in the attempt count', (a, b) => {
    const [low, high] = a <= b ? [a, b] : [b, a];
    expect(backoffCeilingMs(low)).toBeLessThanOrEqual(backoffCeilingMs(high));
  });

  it.prop([attempts], PROP)('starts at the base and doubles until the ceiling', (attempt) => {
    const expected = Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    expect(backoffCeilingMs(attempt)).toBe(expected);
    expect(retryDelayMs(attempt, () => 1)).toBe(expected);
    expect(retryDelayMs(attempt, () => 0)).toBe(0);
  });

  it.prop([attempts, unit], PROP)('is full jitter: uniform in [0, ceiling]', (attempt, r) => {
    expect(retryDelayMs(attempt, () => r)).toBe(Math.round(r * backoffCeilingMs(attempt)));
  });

  it.prop([fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 120_000 })], PROP)(
    'escalates to failed after 10 attempts or 30 s, and not before',
    (count, retryingForMs) => {
      const expected = count >= FAILED_AFTER_ATTEMPTS || retryingForMs >= FAILED_AFTER_MS;
      expect(hasFailed(count, retryingForMs)).toBe(expected);
    },
  );
});
