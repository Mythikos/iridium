/**
 * Content markers.
 *
 * Collaboration bugs of the "duplicated initial content" class are invisible to a length or hash
 * assertion made after the fact: two identical insertions of the same seed text look exactly like one.
 * The harness therefore writes uniquely numbered markers into note text and counts them, which is why
 * 10-testing-and-quality.md's kernel seed creates `note N` by importing a fixture containing
 * `MARKER_IMPORT` — *"so the 'duplicated initial content' bug class is detectable by a marker count in
 * every test that touches it."*
 *
 * The delimiters are U+27E6 / U+27E7 (mathematical white square brackets). They are deliberately not
 * Markdown syntax, not HTML, not part of any wikilink or frontmatter form, and outside the BMP-adjacent
 * ranges the sanitiser rewrites — a marker survives the import, projection and export pipelines
 * unchanged, and a marker that did *not* survive is itself a finding.
 */

export const MARKER_OPEN = '⟦';
export const MARKER_CLOSE = '⟧';

/** The marker the kernel seed's `note N` carries (10-testing-and-quality.md, "Seeding"). */
export const MARKER_IMPORT: string = `${MARKER_OPEN}IMPORT-MARK${MARKER_CLOSE}`;

/** `⟦tag:<n>⟧`. */
export function formatMarker(tag: string, ordinal: number): string {
  return `${MARKER_OPEN}${tag}:${String(ordinal)}${MARKER_CLOSE}`;
}

/** How many markers of a tag the text carries, counting every ordinal. */
export function countMarkers(text: string, tag: string): number {
  const needle = `${MARKER_OPEN}${tag}:`;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

/** Every marker of a tag, in the order the text carries them. Duplicates are the point. */
export function findMarkers(text: string, tag: string): readonly string[] {
  const found: string[] = [];
  const needle = `${MARKER_OPEN}${tag}:`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) {
      return found;
    }
    const end = text.indexOf(MARKER_CLOSE, at);
    if (end === -1) {
      return found;
    }
    found.push(text.slice(at, end + MARKER_CLOSE.length));
    from = end + MARKER_CLOSE.length;
  }
}

export interface MarkerSequence {
  /** The next marker for this tag: `⟦tag:1⟧`, then `⟦tag:2⟧`, … */
  next(): string;
  /** How many have been handed out. */
  readonly issued: number;
}

/**
 * A fresh ordinal sequence for one tag, numbered from 1.
 *
 * The sequence is per caller, **not** per tag globally: two `NoteClient`s given the same tag both
 * write `⟦tag:1⟧`, and a duplication bug that copied one of them would then be invisible to
 * `countMarkers`, which counts every ordinal of a tag. A test that opens two clients therefore gives
 * each its own tag, which is what makes the count an oracle rather than a coincidence.
 */
export function createMarkerSequence(tag: string): MarkerSequence {
  let issued = 0;
  return {
    next(): string {
      issued += 1;
      return formatMarker(tag, issued);
    },
    get issued(): number {
      return issued;
    },
  };
}
