/**
 * `crdt.undo.unit` — the session-owned undo manager (07-client-applications.md §5.2).
 *
 * Three things matter: the manager undoes and redoes local edits on the note body; the capture
 * window it is built with is the caller's (edits inside the window merge into one step and
 * `stopCapturing()` splits them), because that window is the session's policy and not this
 * package's; and a remote update is never on the undo stack, or one author could revert another.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createNoteDoc, getContent, LOAD_ORIGIN, projectMarkdown } from './doc.ts';
import { createUndoManager } from './undo.ts';

/** A window no test can outrun: every local edit merges until `stopCapturing()`. */
const OPEN_ENDED_CAPTURE_MS = Number.MAX_SAFE_INTEGER;

describe('crdt.undo.unit [area:contracts]', () => {
  it('undoes and redoes a local edit on the note body', () => {
    const doc = createNoteDoc();
    const undo = createUndoManager(getContent(doc), { captureTimeout: 0 });

    getContent(doc).insert(0, 'alpha');
    undo.undo();
    expect(projectMarkdown(doc)).toBe('');

    undo.redo();
    expect(projectMarkdown(doc)).toBe('alpha');
  });

  it('merges edits inside the capture window and splits them at stopCapturing()', () => {
    const doc = createNoteDoc();
    const text = getContent(doc);
    const undo = createUndoManager(text, { captureTimeout: OPEN_ENDED_CAPTURE_MS });

    text.insert(0, 'a');
    text.insert(1, 'b');
    undo.stopCapturing();
    text.insert(2, 'c');
    expect(undo.undoStack).toHaveLength(2);

    undo.undo();
    expect(projectMarkdown(doc)).toBe('ab');
    undo.undo();
    expect(projectMarkdown(doc)).toBe('');
  });

  it('never puts a remote update on the undo stack', () => {
    const remote = createNoteDoc();
    getContent(remote).insert(0, 'from another author');
    const doc = createNoteDoc();
    const undo = createUndoManager(getContent(doc), { captureTimeout: 0 });

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), LOAD_ORIGIN);
    expect(projectMarkdown(doc)).toBe('from another author');
    expect(undo.undoStack).toHaveLength(0);

    undo.undo();
    expect(projectMarkdown(doc)).toBe('from another author');
  });
});
