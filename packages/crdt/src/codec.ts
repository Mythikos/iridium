// oxlint-disable typescript/no-unsafe-type-assertion -- this module is the branding boundary:
// yjs hands back plain `Uint8Array`, and giving those bytes their `V1Update`, `V2State` or
// `StateVector` identity is the one thing this file exists to do. Every other module receives
// bytes that are already branded, which is what makes a V1/V2 mix-up a compile error (A15).

/**
 * The one module that chooses a Yjs encoder or decoder.
 *
 * `note_updates.update_v1` is always V1 — that is what arrives on the wire, what `Y.mergeUpdates`
 * consumes and what `Y.applyUpdate` replays. `note_docs.snapshot` is always V2, because V2 encoding
 * of a compacted document is roughly an order of magnitude smaller (13-decision-log.md A15). Mixing
 * the two corrupts merges, so the mixing surface is reduced to this file and made type-visible: the
 * branded `V1Update`, `V2State` and `StateVector` cannot be passed to each other's functions, and
 * `snapshot_format` is a parameter rather than an assumption, which is what makes the recorded V1
 * fallback of spike S1 a one-call change at the call sites and nothing here.
 */
import * as Y from 'yjs';

import { CrdtError } from './errors.ts';

/** A Yjs V1 update: the wire format (y-protocols sync) and `note_updates.update_v1`. */
export type V1Update = Uint8Array & { readonly __brand: 'V1Update' };

/** A Yjs V2 state: `Y.encodeStateAsUpdateV2` output, `note_docs.snapshot` with `snapshot_format=2`. */
export type V2State = Uint8Array & { readonly __brand: 'V2State' };

/** A Yjs state vector: `Y.encodeStateVector` output. */
export type StateVector = Uint8Array & { readonly __brand: 'StateVector' };

/** The value of `note_docs.snapshot_format` / `note_revisions.snapshot_format`: 2 = V2, 1 = V1. */
export type SnapshotFormat = 1 | 2;

/**
 * The `VARBINARY(4096)` width of `note_updates.sv_after` and `note_docs.snapshot_sv`.
 *
 * A vector wider than this is not stored; the column records a zero-length value meaning "not
 * recorded" (03-data-model.md D03-01), which `recordedSv` resolves back to the live vector. The
 * degradation lives here, in `storedSv` and in `recordedSv` so that the writer, the compactor and
 * the loader share one definition of it (05-collaboration-and-durability.md D05-19).
 */
export const SV_STORED_MAX_BYTES = 4096;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function unknownFormat(format: never): CrdtError {
  return new CrdtError(
    'unknown-snapshot-format',
    `snapshot_format ${String(format)} is neither 1 (V1) nor 2 (V2)`,
  );
}

/**
 * Encode a document's whole state, or the difference from `from`, in the requested format.
 *
 * `format` is the value that will be written to `snapshot_format`, so an encoder is never chosen by
 * position or by convention. `from` produces the update that carries everything the holder of that
 * state vector is missing, which is how a re-attach delta is measured before a provider is attached
 * (05-collaboration-and-durability.md, "Reconnection semantics").
 */
export function encodeState(doc: Y.Doc, format: 1, from?: StateVector): V1Update;
export function encodeState(doc: Y.Doc, format: 2, from?: StateVector): V2State;
export function encodeState(
  doc: Y.Doc,
  format: SnapshotFormat,
  from?: StateVector,
): V1Update | V2State;
export function encodeState(
  doc: Y.Doc,
  format: SnapshotFormat,
  from?: StateVector,
): V1Update | V2State {
  switch (format) {
    case 2: {
      return Y.encodeStateAsUpdateV2(doc, from) as V2State;
    }
    case 1: {
      return Y.encodeStateAsUpdate(doc, from) as V1Update;
    }
    default: {
      throw unknownFormat(format);
    }
  }
}

/**
 * Apply a persisted blob to a document in place, dispatching on the format it was stored with.
 *
 * The loader applies the V2 snapshot first and then every V1 row above `snapshot_through_seq`; both
 * go through this function, and `onLoadDocument` returns `undefined` rather than bytes so that
 * Hocuspocus's V1-only return path never sees a V2 blob (13-decision-log.md A15).
 */
export function loadState(
  doc: Y.Doc,
  blob: Uint8Array,
  format: SnapshotFormat,
  origin: unknown,
): void {
  switch (format) {
    case 2: {
      Y.applyUpdateV2(doc, blob, origin);
      return;
    }
    case 1: {
      Y.applyUpdate(doc, blob, origin);
      return;
    }
    default: {
      throw unknownFormat(format);
    }
  }
}

/** Apply one V1 update — a wire frame or a `note_updates` row — to a document. */
export function applyV1(doc: Y.Doc, update: V1Update, origin: unknown): void {
  Y.applyUpdate(doc, update, origin);
}

/** Merge a run of V1 updates into the single V1 update one `note_updates` row holds. */
export function mergeV1(updates: V1Update[]): V1Update {
  return Y.mergeUpdates(updates) as V1Update;
}

/** The document's state vector. */
export function stateVector(doc: Y.Doc): StateVector {
  return Y.encodeStateVector(doc) as StateVector;
}

/**
 * Decode a state vector into `(clientID → clock)` pairs.
 *
 * Total by construction: a zero-length vector is the "not recorded" degradation of D03-01 and
 * decodes to an empty map (which dominates nothing), and bytes that are not a canonical
 * `Y.encodeStateVector` output raise a typed error instead of yielding a plausible wrong answer —
 * the acknowledgement protocol compares these clocks, so a silently mis-decoded vector would be a
 * false *Saved*.
 */
export function decodeStateVector(sv: StateVector): Map<number, number> {
  if (sv.byteLength === 0) return new Map();
  let decoded: Map<number, number>;
  try {
    decoded = Y.decodeStateVector(sv);
  } catch (cause) {
    throw new CrdtError('malformed-state-vector', 'state vector bytes are not decodable', {
      cause,
    });
  }
  if (!bytesEqual(Y.encodeStateVector(decoded), sv)) {
    throw new CrdtError(
      'malformed-state-vector',
      'state vector bytes are not a canonical encoding of the clocks they decode to',
    );
  }
  return decoded;
}

/** The value to store in a `VARBINARY(4096)` column: the vector, or zero length for "not recorded". */
export function storedSv(sv: StateVector): StateVector {
  return sv.byteLength <= SV_STORED_MAX_BYTES ? sv : (new Uint8Array(0) as StateVector);
}

/**
 * Resolve a recorded vector back to a usable one: zero length or `NULL` means "not recorded", and
 * the document — which has applied everything through `head_seq` — is then the recorded value.
 *
 * Without this fallback an empty vector would dominate nothing and every client opening such a note
 * would sit in `syncing` for content that is entirely committed.
 */
export function recordedSv(recorded: Uint8Array | null | undefined, doc: Y.Doc): StateVector {
  return recorded != null && recorded.byteLength > 0 ? (recorded as StateVector) : stateVector(doc);
}
