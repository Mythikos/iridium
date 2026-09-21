import { describe, expect, it } from 'vitest';

import { LIMITS } from './limits.ts';
import { MARKDOWN_LIMITS } from './markdown-limits.ts';

describe('contracts.markdown-limits.unit [area:contracts]', () => {
  it('aggregates every worker bound into the same public policy value', () => {
    for (const [name, value] of Object.entries(MARKDOWN_LIMITS))
      expect(LIMITS).toHaveProperty(name, value);
    expect(LIMITS.NOTE_HARD_MAX_UTF16).toBe(MARKDOWN_LIMITS.NOTE_HARD_MAX_UTF16);
    expect(Object.keys(MARKDOWN_LIMITS).some((name) => /^(LOGIN_|OAUTH_|WS_)/.test(name))).toBe(
      false,
    );
  });
});
