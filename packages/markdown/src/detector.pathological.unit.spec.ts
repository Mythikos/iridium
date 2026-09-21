import { LIMITS } from '@iridium/contracts/limits';
import { describe, expect, it } from 'vitest';

import { parseNote, detectObsidianSyntax } from './index.ts';

describe('detector.pathological.unit [area:markdown]', () => {
  it('bounds samples while counting every repeated construct', () => {
    const source = '[[target]] '.repeat(5_000);
    const start = Date.now();
    const result = detectObsidianSyntax(source, parseNote(source).mdast);
    expect(result.counts.wikilink).toBe(5_000);
    expect(result.findings).toHaveLength(LIMITS.OBSIDIAN_FINDINGS_PER_CODE_MAX);
    expect(result.truncated).toBe(true);
    expect(Date.now() - start).toBeLessThan(LIMITS.PROJECTION_TIMEOUT_CLIENT_MS);
  });
});
