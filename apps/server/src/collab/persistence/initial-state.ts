/**
 * The rows a new note's initial state becomes (05-collaboration-and-durability.md,
 * "`NoteService.initialize` — the single Markdown → Y.Doc path"; 03-data-model.md §8.8).
 *
 * `initialNoteState` in `@iridium/crdt` is the only function in the codebase that builds a document
 * from text; this module turns its output into the five rows the creating transaction writes at
 * `seq = 1` — the log row, the `note_docs` anchor already compacted through seq 1, the `create` /
 * `import` checkpoint, the first projection, and the `notes` metadata — so `NoteService.initialize`
 * (against MySQL) and the in-memory persistence double (which seeds a note the same way for the
 * property mirrors) cannot disagree about what a fresh note looks like. It constructs no document of
 * its own: `collab.initial-state-only-path.guard` names this file in its allowlist, and the
 * allowance is unused by design.
 */
import type { NoteId } from '@iridium/contracts';
import { initialNoteState, storedSv } from '@iridium/crdt';
import { PIPELINE_VERSION } from '@iridium/markdown';

import type { NoteEol } from '../../db/schema.ts';
import { contentHash } from '../../projection/hash.ts';
import type { ProjectionInput, RevisionInsert, UpdateActor, UpdateInsert } from './types.ts';

/** The Yjs major every row records; the loader refuses any other (03 §8.3). */
export const YJS_MAJOR = 13;

/** The first sequence number: `head_seq` starts at 1 and never at 0 for an initialised note. */
export const INITIAL_SEQ = 1;

/** What the initialiser needs beside the normalised text. */
export interface InitialStateInput {
  readonly noteId: NoteId;
  /** Already through `normalizeSource`: LF-only, with its encoding BOM removed. */
  readonly markdownLf: string;
  readonly origin: 'create' | 'import';
  readonly actor: UpdateActor;
  readonly now: Date;
  readonly originalEol: NoteEol;
  readonly hadBom: boolean;
}

/** The `note_docs` row of a fresh note. */
export interface NoteDocInsert {
  readonly headSeq: number;
  readonly snapshot: Uint8Array;
  readonly snapshotSv: Uint8Array;
  readonly snapshotThroughSeq: number;
  readonly snapshotSize: number;
  readonly snapshotAt: Date;
  readonly projectedSeq: number;
  readonly snapshotFormat: 2;
  readonly yjsMajor: number;
}

/** The `notes` metadata flipped last inside the same transaction. */
export interface NoteMetadataInsert {
  readonly initializedAt: Date;
  readonly originalEol: NoteEol;
  readonly hadBom: boolean;
  readonly sizeChars: number;
}

/** The five rows, plus the hash the caller answers with. */
export interface InitialRows {
  readonly update: UpdateInsert;
  readonly doc: NoteDocInsert;
  readonly revision: RevisionInsert;
  readonly projection: ProjectionInput & { readonly pipelineVersion: number };
  readonly note: NoteMetadataInsert;
  readonly contentHash: Buffer;
  readonly sizeChars: number;
}

/** Builds the rows. The throwaway document is created and destroyed inside `initialNoteState`. */
export function initialRows(input: InitialStateInput): InitialRows {
  const state = initialNoteState(input.markdownLf);
  const hash = contentHash(input.markdownLf);
  const sv = storedSv(state.sv);
  return {
    update: {
      seq: INITIAL_SEQ,
      updateV1: state.update,
      svAfter: sv,
      actor: input.actor,
      origin: input.origin,
      createdAt: input.now,
    },
    doc: {
      headSeq: INITIAL_SEQ,
      snapshot: state.snapshot,
      snapshotSv: sv,
      snapshotThroughSeq: INITIAL_SEQ,
      snapshotSize: state.snapshot.byteLength,
      snapshotAt: input.now,
      projectedSeq: INITIAL_SEQ,
      snapshotFormat: 2,
      yjsMajor: YJS_MAJOR,
    },
    revision: {
      seq: INITIAL_SEQ,
      kind: input.origin,
      label: null,
      markdown: input.markdownLf,
      contentHash: hash,
      sizeChars: state.sizeChars,
      snapshot: state.snapshot,
      snapshotSv: sv,
      actor: input.actor,
      createdAt: input.now,
    },
    projection: {
      revision: INITIAL_SEQ,
      markdown: input.markdownLf,
      contentHash: hash,
      now: input.now,
      pipelineVersion: PIPELINE_VERSION,
    },
    note: {
      initializedAt: input.now,
      originalEol: input.originalEol,
      hadBom: input.hadBom,
      sizeChars: state.sizeChars,
    },
    contentHash: hash,
    sizeChars: state.sizeChars,
  };
}
