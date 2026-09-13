/**
 * The only function in the codebase that creates a document from text.
 *
 * A Yjs document is not a string; it is a set of item identities. Two documents built independently
 * from the same Markdown produce disjoint identity sets, so merging them concatenates the text
 * instead of converging, and a client holding the first cannot reconcile with a server that has
 * rebuilt the second. Markdown therefore reaches a `Y.Doc` exactly once per note, inside the
 * transaction that creates the note; afterwards it is a projection *out of* the CRDT and every
 * rewrite is an edit (05-collaboration-and-durability.md, "Note initialization and the load path").
 */
import {
  encodeState,
  stateVector,
  type StateVector,
  type V1Update,
  type V2State,
} from './codec.ts';
import { INIT_ORIGIN, createNoteDoc, getContent } from './doc.ts';
import { assertLfOnly } from './guards.ts';

/** Everything `NoteService.initialize` writes for a new note, from one throwaway document. */
export interface InitialNoteState {
  /** `note_updates.update_v1` at `seq = 1`: the log is always wire format. */
  readonly update: V1Update;
  /** `note_docs.snapshot` with `snapshot_format = 2`: snapshots are always compacted. */
  readonly snapshot: V2State;
  /** The state vector of the initial document, before `storedSv` decides whether it fits. */
  readonly sv: StateVector;
  /** `notes.size_chars`: UTF-16 units of the normalised source. */
  readonly sizeChars: number;
}

/**
 * Build a note's initial state from normalised Markdown, on a document destroyed before returning.
 *
 * An empty note still produces a valid `seq = 1` row: encoding a document with no items yields a
 * short but non-empty update (an empty struct map and an empty delete set), so `head_seq` always
 * starts at 1 and a `head_seq` of 0 on an initialised note is an invariant violation rather than a
 * state the create path can reach. That update registers no type — `getContent()` creates the
 * `Y.Text` on first access in whichever document asks for it — which is why the load path never
 * needs the first row to carry content.
 */
export function initialNoteState(markdownLf: string): InitialNoteState {
  assertLfOnly(markdownLf);
  const doc = createNoteDoc({ gc: true });
  try {
    doc.transact(() => {
      getContent(doc).insert(0, markdownLf);
    }, INIT_ORIGIN);
    return {
      update: encodeState(doc, 1),
      snapshot: encodeState(doc, 2),
      sv: stateVector(doc),
      sizeChars: markdownLf.length,
    };
  } finally {
    doc.destroy();
  }
}
