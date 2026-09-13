/**
 * The `CollabPersistence` stub of spike S1: `note_docs` and `note_updates` as in-memory rows.
 *
 * Shapes follow 05-collaboration-and-durability.md, "Loading a document": a V2 snapshot with its
 * state vector and `snapshot_through_seq`, and V1 rows above it in `seq` order. The store also keeps
 * a **shadow document** per note — every persisted V1 row applied in order, on a document that is
 * never served — which is the oracle for criterion (a): after a load, the served document's state
 * vector must equal the shadow's, and its projection must equal the shadow's projection.
 *
 * Everything goes through `@iridium/crdt`'s codec: this file imports no `yjs`.
 */
import {
  applyV1,
  createNoteDoc,
  encodeState,
  loadState,
  LOAD_ORIGIN,
  projectMarkdown,
  stateVector,
  type InitialNoteState,
  type SnapshotFormat,
  type StateVector,
  type V1Update,
  type V2State,
} from '@iridium/crdt';
import { createDeferred, type Deferred } from '@iridium/testkit';

import type { NoteDoc } from './provider.ts';

export interface StoredRow {
  readonly seq: number;
  readonly updateV1: V1Update;
}

export interface StoredNote {
  snapshot: V1Update | V2State | null;
  snapshotFormat: SnapshotFormat;
  snapshotSv: StateVector | null;
  snapshotThroughSeq: number;
  headSeq: number;
  rows: StoredRow[];
}

/** What `loader.load` returns: the snapshot plus the rows above `snapshot_through_seq`. */
export interface LoadedState {
  readonly snapshot: V1Update | V2State | null;
  readonly snapshotFormat: SnapshotFormat;
  readonly snapshotSv: StateVector | null;
  readonly snapshotThroughSeq: number;
  readonly headSeq: number;
  readonly rows: readonly StoredRow[];
}

export interface AttachedWriter {
  /** `update` events the listener accepted (origin other than `LOAD_ORIGIN`). */
  accepted: number;
  /** `update` events the listener saw with `LOAD_ORIGIN` — must stay 0 for a listener attached after load. */
  filteredLoadOrigin: number;
  detach(): void;
}

export class StubCollabPersistence {
  readonly notes = new Map<string, StoredNote>();
  private readonly shadows = new Map<string, NoteDoc>();
  /** When set, `load()` waits on it — the mid-load probe of criterion (e). */
  gate: Deferred<void> | null = null;
  loads = 0;

  /** `NoteService.initialize`: the `seq = 1` row and the first snapshot, exactly as the plan writes them. */
  seed(noteId: string, initial: InitialNoteState): void {
    this.notes.set(noteId, {
      snapshot: initial.snapshot,
      snapshotFormat: 2,
      snapshotSv: initial.sv,
      snapshotThroughSeq: 1,
      headSeq: 1,
      rows: [{ seq: 1, updateV1: initial.update }],
    });
    const shadow = createNoteDoc();
    applyV1(shadow, initial.update, LOAD_ORIGIN);
    this.shadows.set(noteId, shadow);
  }

  async load(noteId: string): Promise<LoadedState> {
    this.loads += 1;
    if (this.gate !== null) await this.gate.promise;
    const note = this.notes.get(noteId);
    if (note === undefined) throw new Error(`note-not-found: ${noteId}`);
    return {
      snapshot: note.snapshot,
      snapshotFormat: note.snapshotFormat,
      snapshotSv: note.snapshotSv,
      snapshotThroughSeq: note.snapshotThroughSeq,
      headSeq: note.headSeq,
      rows: note.rows.filter((row) => row.seq > note.snapshotThroughSeq),
    };
  }

  /** Apply a loaded state to a document in place — the body of `onLoadDocument`. */
  static applyLoaded(document: NoteDoc, loaded: LoadedState): void {
    if (loaded.snapshot !== null) {
      loadState(document, loaded.snapshot, loaded.snapshotFormat, LOAD_ORIGIN);
    }
    for (const row of loaded.rows) applyV1(document, row.updateV1, LOAD_ORIGIN);
  }

  /** `persistence.attach`: the `update` listener that appends a `note_updates` row per client update. */
  attach(noteId: string, document: NoteDoc): AttachedWriter {
    const writer: AttachedWriter = {
      accepted: 0,
      filteredLoadOrigin: 0,
      detach: () => {
        document.off('update', listener);
      },
    };
    const listener = (update: Uint8Array, origin: unknown): void => {
      if (origin === LOAD_ORIGIN) {
        writer.filteredLoadOrigin += 1;
        return;
      }
      writer.accepted += 1;
      // The `update` event payload is the V1 wire encoding; the product's writer brands it at this
      // same boundary (codec.ts), and the harness may not import `yjs` to do it another way.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
      this.append(noteId, update as V1Update);
    };
    document.on('update', listener);
    return writer;
  }

  append(noteId: string, updateV1: V1Update): number {
    const note = this.notes.get(noteId);
    if (note === undefined) throw new Error(`note-not-found: ${noteId}`);
    note.headSeq += 1;
    note.rows.push({ seq: note.headSeq, updateV1 });
    const shadow = this.shadows.get(noteId);
    if (shadow !== undefined) applyV1(shadow, updateV1, LOAD_ORIGIN);
    return note.headSeq;
  }

  /** The compactor: snapshot at `head_seq` in the requested format, rows at or below it become pruneable. */
  compact(noteId: string, format: SnapshotFormat): void {
    const note = this.notes.get(noteId);
    const shadow = this.shadows.get(noteId);
    if (note === undefined || shadow === undefined) throw new Error(`note-not-found: ${noteId}`);
    note.snapshot = encodeState(shadow, format);
    note.snapshotFormat = format;
    note.snapshotSv = stateVector(shadow);
    note.snapshotThroughSeq = note.headSeq;
    // `jobs/update_log_prune`, immediately: the loader must not depend on the pruned rows.
    note.rows = note.rows.filter((row) => row.seq > note.snapshotThroughSeq);
  }

  shadowOf(noteId: string): NoteDoc {
    const shadow = this.shadows.get(noteId);
    if (shadow === undefined) throw new Error(`note-not-found: ${noteId}`);
    return shadow;
  }

  shadowText(noteId: string): string {
    return projectMarkdown(this.shadowOf(noteId));
  }

  shadowSv(noteId: string): StateVector {
    return stateVector(this.shadowOf(noteId));
  }

  /** A fresh document rebuilt from the rows alone — what a reader with no snapshot would see. */
  rebuildFromStore(noteId: string): NoteDoc {
    const note = this.notes.get(noteId);
    if (note === undefined) throw new Error(`note-not-found: ${noteId}`);
    const doc = createNoteDoc();
    StubCollabPersistence.applyLoaded(doc, {
      snapshot: note.snapshot,
      snapshotFormat: note.snapshotFormat,
      snapshotSv: note.snapshotSv,
      snapshotThroughSeq: note.snapshotThroughSeq,
      headSeq: note.headSeq,
      rows: note.rows.filter((row) => row.seq > note.snapshotThroughSeq),
    });
    return doc;
  }

  openGate(): Deferred<void> {
    const gate = createDeferred<void>();
    this.gate = gate;
    return gate;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
