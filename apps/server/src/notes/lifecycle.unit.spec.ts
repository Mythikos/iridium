/** Overlapping structural operations cannot remove each other's admission fence. */
import { NoteId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { ClosingSet } from './lifecycle.ts';

const NOTE = NoteId.parse('019948c4-0000-7000-8000-000000000001');
const OTHER = NoteId.parse('019948c4-0000-7000-8000-000000000002');

describe('notes.lifecycle.unit [area:notes]', () => {
  it('holds a fence until every overlapping owner has released it', () => {
    const closing = new ClosingSet();
    closing.mark(NOTE);
    closing.mark(NOTE);
    closing.mark(OTHER);
    expect(closing.size).toBe(2);
    closing.clear(NOTE);
    expect(closing.has(NOTE)).toBe(true);
    closing.clear(OTHER);
    expect(closing.has(OTHER)).toBe(false);
    expect(closing.has(NOTE)).toBe(true);
    closing.clear(NOTE);
    expect(closing.has(NOTE)).toBe(false);
    expect(closing.size).toBe(0);
    closing.clear(NOTE);
    expect(closing.size).toBe(0);
  });
});
