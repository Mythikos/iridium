/**
 * The note's undo manager (07-client-applications.md §5.2): one `Y.UndoManager` per `NoteSession`,
 * living on the session rather than on an `EditorView`, so undo history survives view rebuilds,
 * mode switches and reconnects. This is the only construction site of the manager (A14): the
 * collaboration client owns the capture window and the editor hands the instance to `yCollab`,
 * which registers its own sync origin as tracked when the view is built. No policy lives here — the
 * capture window is the caller's, exactly as `createNoteDoc` leaves `gc` to its caller.
 */
import * as Y from 'yjs';

/** What `createUndoManager` accepts. */
export interface CreateUndoManagerOptions {
  /**
   * Milliseconds within which consecutive local edits merge into one undo step. `0` never merges;
   * the session's value is the plan's (07 §5.2).
   */
  readonly captureTimeout: number;
}

/**
 * Create the undo manager for one note body (`getContent(doc)`). Only local transactions are
 * tracked (yjs's default origin set), so an undo never reverts another author's edit.
 */
export function createUndoManager(text: Y.Text, options: CreateUndoManagerOptions): Y.UndoManager {
  return new Y.UndoManager(text, { captureTimeout: options.captureTimeout });
}
