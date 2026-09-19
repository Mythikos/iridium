/**
 * `vaults.slug.unit` — the derived, immutable `vaults.slug` (03-data-model.md §5).
 *
 * The slug names a folder inside an export archive, so the properties worth pinning are the ones an
 * archive depends on: it is always ASCII, always non-empty, always fits the column, and two vaults
 * never derive the same one.
 */
import { describe, expect, it } from 'vitest';

import { baseSlug, FALLBACK_SLUG, slugCollisionPattern, uniqueSlug } from './slug.ts';

const SLUG_COLUMN_CHARS = 64;

describe('vaults.slug.unit [area:vaults]', () => {
  it.each([
    ['Engineering', 'engineering'],
    ['Engineering Notes', 'engineering-notes'],
    ['  Trimmed  ', 'trimmed'],
    ['Product / Design', 'product-design'],
    ['Ünïcodé Vault', 'unicode-vault'],
    ['2026 Planning', '2026-planning'],
    ['a---b', 'a-b'],
  ])('derives %j as %j', (name: string, expected: string) => {
    expect(baseSlug(name)).toBe(expected);
  });

  it('falls back rather than deriving the empty string', () => {
    expect(baseSlug('日本語')).toBe(FALLBACK_SLUG);
    expect(baseSlug('...')).toBe(FALLBACK_SLUG);
  });

  it('never exceeds the column, suffix included', () => {
    const long = 'x'.repeat(200);
    const taken = new Set<string>();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const slug = uniqueSlug(long, taken);
      expect(slug.length).toBeLessThanOrEqual(SLUG_COLUMN_CHARS);
      expect(taken.has(slug)).toBe(false);
      taken.add(slug);
    }
    expect(taken.size).toBe(15);
  });

  it('suffixes a collision from -2 upward, in order', () => {
    const taken = new Set(['notes', 'notes-2']);
    expect(uniqueSlug('Notes', taken)).toBe('notes-3');
  });

  it('takes the bare slug when nothing collides', () => {
    expect(uniqueSlug('Notes', new Set())).toBe('notes');
  });

  it('never leaves a trailing hyphen after truncation', () => {
    // A 64th character that is a separator would otherwise survive the slice.
    const name = `${'a'.repeat(SLUG_COLUMN_CHARS - 1)} tail`;
    expect(baseSlug(name).endsWith('-')).toBe(false);
  });

  it('builds a collision pattern that cannot become a wildcard', () => {
    expect(slugCollisionPattern('100% Coverage')).toBe('100-coverage%');
    expect(slugCollisionPattern('a_b')).toBe('a-b%');
  });

  it('derives only ASCII letters, digits and hyphens', () => {
    for (const name of ['Ünïcodé', 'emoji 🙂 vault', 'Ω omega', 'tab\tseparated']) {
      expect(baseSlug(name)).toMatch(/^[\da-z-]+$/);
    }
  });
});
