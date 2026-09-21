/** Cursor anchors survive concurrent edits, and say so when the text they named is gone. */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createNoteDoc, getContent } from './doc.ts';
import { relativePositionAt, resolveRelativePosition } from './positions.ts';

describe('crdt.positions.unit [area:crdt]', () => {
  it('keeps an anchor on the same character when text is inserted before it', () => {
    const doc = createNoteDoc();
    const text = getContent(doc);
    text.insert(0, 'hello world');
    const anchor = relativePositionAt(text, 6);
    text.insert(0, 'oh, ');

    // The anchor is CRDT identity, not an offset: the character it named moved, and so did it.
    expect(resolveRelativePosition(doc, anchor)).toEqual({ index: 10 });
    doc.destroy();
  });

  it('has no current position for an anchor whose document never held it', () => {
    const origin = createNoteDoc();
    getContent(origin).insert(0, 'hello world');
    const anchor = relativePositionAt(getContent(origin), 6);

    // A cursor arriving from a document this server never loaded resolves to nothing rather than
    // to a plausible offset, which is what stops a stale anchor silently addressing other text.
    const stranger = new Y.Doc();
    expect(resolveRelativePosition(stranger, anchor)).toBeNull();

    origin.destroy();
    stranger.destroy();
  });
});
