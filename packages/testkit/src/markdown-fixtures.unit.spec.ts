/** Fixture-version and byte manifests fail before any product-path fixture is imported. */
import { describe, expect, it } from 'vitest';

import {
  readMarkdownGoldenFixtures,
  readMarkdownHostileFixtures,
  readMarkdownPathologicalFixtures,
} from './fixtures/markdown-pipeline.ts';

describe('testkit.markdown-fixtures.unit [area:markdown] [spec:portability-and-safety]', () => {
  it('checks every golden hash, fixture version and declared projection version', () => {
    const fixtures = readMarkdownGoldenFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
    expect(fixtures.every((fixture) => fixture.markdown.length > 0)).toBe(true);
  });
  it('uses the committed hostile bytes and deterministic pathological descriptors', () => {
    expect(readMarkdownHostileFixtures().every((fixture) => fixture.markdown.length > 0)).toBe(
      true,
    );
    const first = readMarkdownPathologicalFixtures();
    expect(first).toEqual(readMarkdownPathologicalFixtures());
    expect(first.some((fixture) => fixture.status === 'too_complex')).toBe(true);
  });
});
