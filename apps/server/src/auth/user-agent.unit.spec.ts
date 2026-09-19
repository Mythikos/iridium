/** Untrusted audit headers have a byte bound and a bounded amount of work before throttling. */
import { describe, expect, it, vi } from 'vitest';

import { truncateUserAgent } from './user-agent.ts';

describe('auth.user-agent.unit [area:auth]', () => {
  it.each([undefined, null])('retains the absent header as null: %s', (header) => {
    expect(truncateUserAgent(header)).toBeNull();
  });

  it.each(['', 'desktop', 'a'.repeat(255)])(
    'preserves a header within the byte bound',
    (header) => {
      expect(truncateUserAgent(header)).toBe(header);
    },
  );

  it.each([
    ['a'.repeat(256), 'a'.repeat(255)],
    ['a'.repeat(253) + 'éz', 'a'.repeat(253) + 'é'],
    ['a'.repeat(254) + 'éz', 'a'.repeat(254)],
    ['a'.repeat(252) + '界z', 'a'.repeat(252) + '界'],
    ['a'.repeat(253) + '界z', 'a'.repeat(253)],
    ['a'.repeat(251) + '😀z', 'a'.repeat(251) + '😀'],
    ['a'.repeat(252) + '😀z', 'a'.repeat(252)],
  ])('keeps a complete UTF-8 prefix at the byte boundary', (header, expected) => {
    const result = truncateUserAgent(header);
    expect(result).toBe(expected);
    expect(Buffer.byteLength(result ?? '', 'utf8')).toBeLessThanOrEqual(255);
    expect(result).not.toContain('�');
  });

  it('never measures the attacker-controlled suffix while constructing audit context', () => {
    const header = 'a'.repeat(16_000);
    // The host UTF-8 primitive is the cost oracle: the old whole-string shrinking loop scans
    // megabytes here. No timing threshold or production-function mock can hide that regression.
    const measure = vi.spyOn(Buffer, 'byteLength');
    try {
      expect(truncateUserAgent(header)).toBe('a'.repeat(255));
      const measuredUnits = measure.mock.calls.reduce(
        (total, [value]) => total + (typeof value === 'string' ? value.length : value.byteLength),
        0,
      );
      expect(measuredUnits).toBeLessThanOrEqual(256);
    } finally {
      measure.mockRestore();
    }
  });
});
