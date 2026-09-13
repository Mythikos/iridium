import { describe, expect, it } from 'vitest';

import {
  MARKER_CLOSE,
  MARKER_IMPORT,
  MARKER_OPEN,
  countMarkers,
  createMarkerSequence,
  findMarkers,
  formatMarker,
} from './harness/markers.ts';

describe('testkit.markers.unit [area:testkit]', () => {
  it('formats a marker the way the kernel seed spells it', () => {
    expect(MARKER_OPEN).toBe('⟦');
    expect(MARKER_CLOSE).toBe('⟧');
    expect(MARKER_IMPORT).toBe('⟦IMPORT-MARK⟧');
    expect(formatMarker('a', 1)).toBe('⟦a:1⟧');
  });

  it('counts duplicated content, which a length or hash assertion cannot', () => {
    const once = `text ${formatMarker('edit', 1)} more`;
    const twice = `${once} ${once}`;
    expect(countMarkers(once, 'edit')).toBe(1);
    expect(countMarkers(twice, 'edit')).toBe(2);
    expect(once.length).toBe(twice.length / 2 - 0.5);
  });

  it('counts every ordinal of a tag and no other tag', () => {
    const text = [formatMarker('a', 1), formatMarker('a', 2), formatMarker('b', 1)].join(' ');
    expect(countMarkers(text, 'a')).toBe(2);
    expect(countMarkers(text, 'b')).toBe(1);
    expect(countMarkers(text, 'c')).toBe(0);
  });

  it('lists markers in document order, duplicates included', () => {
    const text = `${formatMarker('x', 2)} ${formatMarker('x', 1)} ${formatMarker('x', 2)}`;
    expect(findMarkers(text, 'x')).toStrictEqual(['⟦x:2⟧', '⟦x:1⟧', '⟦x:2⟧']);
  });

  it('ignores an unterminated marker instead of running to the end of the note', () => {
    expect(findMarkers(`${MARKER_OPEN}x:1 no close`, 'x')).toStrictEqual([]);
    expect(countMarkers(`${MARKER_OPEN}x:1 no close`, 'x')).toBe(1);
  });

  it('hands out a distinct marker per call', () => {
    const sequence = createMarkerSequence('edit');
    expect(sequence.issued).toBe(0);
    expect([sequence.next(), sequence.next(), sequence.next()]).toStrictEqual([
      '⟦edit:1⟧',
      '⟦edit:2⟧',
      '⟦edit:3⟧',
    ]);
    expect(sequence.issued).toBe(3);
  });

  it('keeps two clients on the same tag apart by ordinal within each sequence', () => {
    const a = createMarkerSequence('t');
    const b = createMarkerSequence('t');
    a.next();
    a.next();
    expect(b.next()).toBe('⟦t:1⟧');
    expect(a.next()).toBe('⟦t:3⟧');
  });
});
