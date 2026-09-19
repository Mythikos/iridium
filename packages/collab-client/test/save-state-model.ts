/**
 * The model `save-state.machine.prop` folds: a small command language over a client's real
 * situation, interpreted into `SaveEvent`s with independently encoded vectors and real Yjs
 * delete-set fingerprints. A seeded document supplies the deleted identities while the virtual
 * participant clocks exercise insert dominance independently.
 *
 * Generating `SaveEvent`s directly would be the obvious thing and would prove much less: the whole
 * question includes whether the acknowledged vector contains the local one, so a
 * generator that draws two unrelated byte strings makes `dominates` answer `false` almost always
 * and never exercises the path that matters. The commands here describe what actually happens to a
 * client — this user typed, a participant's edit was relayed, the writer acknowledged everything it
 * had seen, an older acknowledgement arrived late — and the interpreter derives the vectors from
 * that, so `saved` is reachable and the "no false positives" property has something to refuse.
 *
 * `@iridium/collab-client` may not import yjs (13-decision-log.md A14), so the state vector encoder
 * below is written out: it is lib0's varuint encoding of `Map<clientId, clock>`, the format
 * `Y.encodeStateVector` produces and `decodeStateVector` reads. `save-state.machine.prop` asserts
 * that round trip in-file against `@iridium/crdt` before it asserts anything else, so a wrong
 * encoder here fails loudly instead of quietly making every dominance check trivial.
 */

import type { PersistFailedReason, Role, SaveStateInput, StateVector } from '@iridium/contracts';
import { createNoteDoc, deleteSetFingerprint, getContent } from '@iridium/crdt';

import { initialSaveInput, reduceSaveInput, type SaveEvent } from '../src/save-state.ts';

const VARUINT_PAYLOAD_BITS = 7;
const VARUINT_PAYLOAD_MASK = 0b0111_1111;
const VARUINT_CONTINUATION = 0b1000_0000;

/** lib0's `writeVarUint` for one non-negative integer. */
function writeVarUint(out: number[], value: number): void {
  let rest = value;
  while (rest > VARUINT_PAYLOAD_MASK) {
    out.push(VARUINT_CONTINUATION | (rest & VARUINT_PAYLOAD_MASK));
    rest = Math.floor(rest / 2 ** VARUINT_PAYLOAD_BITS);
  }
  out.push(rest & VARUINT_PAYLOAD_MASK);
}

/**
 * `Y.encodeStateVector`'s format: the entry count, then `(clientId, clock)` pairs.
 *
 * The pairs are written in **descending** client-id order, which is what `writeStateVector` does
 * and therefore what makes the bytes canonical: `decodeStateVector` re-encodes what it read and
 * refuses anything that does not come back identical, because a silently mis-decoded vector would
 * be a false *Saved*. The round trip is asserted in `save-state.machine.prop` before anything else.
 */
export function encodeSv(clocks: ReadonlyMap<number, number>): StateVector {
  const out: number[] = [];
  writeVarUint(out, clocks.size);
  for (const [client, clock] of [...clocks.entries()].toSorted(([a], [b]) => b - a)) {
    writeVarUint(out, client);
    writeVarUint(out, clock);
  }
  return Uint8Array.from(out);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Bytes as the wire carries them, for a test that has to build a `persisted {sv}` by hand.
 *
 * Written out for the same reason `base64.ts` writes out the decoder: `btoa` is the DOM's and
 * `Buffer` is Node's, and this package declares neither.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const remaining = bytes.length - index;
    out += BASE64_ALPHABET[a >> 2] ?? '';
    out += BASE64_ALPHABET[((a & 0b11) << 4) | (b >> 4)] ?? '';
    out += remaining > 1 ? (BASE64_ALPHABET[((b & 0b1111) << 2) | (c >> 6)] ?? '') : '=';
    out += remaining > 2 ? (BASE64_ALPHABET[c & 0b11_1111] ?? '') : '=';
  }
  return out;
}

/** The client ids a generated trace draws from: few, so vectors overlap and dominance is decidable. */
export const MODEL_CLIENT_IDS: readonly number[] = [11, 22, 33];

/** The close reasons a command may carry, spelled through the event so the two cannot drift. */
export type CloseReason = Extract<SaveEvent, { e: 'close' }>['reason'];

/** One thing that can happen to a client. The interpreter turns each into zero or more events. */
export type Command =
  /** This user typed: one of the document's clocks advances and the server has not seen it. */
  | { readonly k: 'localEdit'; readonly client: number }
  /** A participant's edit was relayed: the vector advances, but it is not this user's unsaved work. */
  | { readonly k: 'remoteEdit'; readonly client: number }
  /** Delete-only edits advance the real delete-set witness without advancing a struct clock. */
  | { readonly k: 'localDelete' }
  | { readonly k: 'remoteDelete' }
  /** The writer committed everything it had been sent and broadcast the acknowledgement. */
  | { readonly k: 'ack' }
  /** An acknowledgement from an earlier commit, arriving late and out of order. */
  | { readonly k: 'staleAck' }
  | { readonly k: 'syncStatus'; readonly applied: boolean }
  | { readonly k: 'unsynced'; readonly n: number }
  | { readonly k: 'persistFailed'; readonly reason: PersistFailedReason }
  | { readonly k: 'projected' }
  | { readonly k: 'role'; readonly role: Role }
  | { readonly k: 'contentInvalid' }
  | { readonly k: 'sizeExceeded' }
  | { readonly k: 'oversizeDelta' }
  | {
      readonly k: 'close';
      readonly reason: CloseReason;
      readonly via: 'close-frame' | 'auth-denied';
    }
  | { readonly k: 'status'; readonly socket: SaveStateInput['socket'] }
  | { readonly k: 'open' }
  | { readonly k: 'authenticated' }
  | { readonly k: 'synced' }
  | { readonly k: 'baselineSent' }
  | { readonly k: 'tick'; readonly advanceMs: number };

/** One step of a folded trace: the command, the event it produced and the snapshot after it. */
export interface Step {
  readonly command: Command;
  readonly event: SaveEvent;
  readonly input: SaveStateInput;
}

/** Where a trace starts. */
export interface ModelStart {
  readonly role: Role;
  readonly now: number;
}

/**
 * Interpret a command trace into successive `SaveStateInput` snapshots.
 *
 * Two commands are dropped once the document has been closed, because the real client detaches its
 * provider on a close and therefore cannot observe them: a second `close`, and the `oversizeDelta`
 * that only an attach can measure. Without that, a generated trace could close a note twice and the
 * "a close is terminal" property would be asserting something no client can reach.
 */
export function fold(start: ModelStart, commands: readonly Command[]): readonly Step[] {
  const deletions = createNoteDoc();
  // Keep the real deletion identity deterministic and disjoint from MODEL_CLIENT_IDS.
  deletions.clientID = 44;
  // A fixed original run gives every generated deletion a real Yjs identity already in the vector.
  getContent(deletions).insert(0, 'x'.repeat(commands.length + 1));
  let localDs = deleteSetFingerprint(deletions);
  let acknowledgedDs = localDs;
  let previousAcknowledgedDs = localDs;
  const clocks = new Map<number, number>([[deletions.clientID, commands.length + 1]]);
  let acknowledged = new Map<number, number>();
  let previousAcknowledged = new Map<number, number>();
  let seq = 0;
  let now = start.now;
  let closed = false;
  let input = initialSaveInput({ role: start.role, localSv: encodeSv(clocks), localDs, now });

  const steps: Step[] = [];
  try {
    for (const command of commands) {
      if (closed && (command.k === 'close' || command.k === 'oversizeDelta')) continue;
      let event: SaveEvent;
      switch (command.k) {
        case 'localEdit': {
          clocks.set(command.client, (clocks.get(command.client) ?? 0) + 1);
          event = { e: 'localUpdate', localSv: encodeSv(clocks), localDs, at: now };
          break;
        }
        case 'remoteEdit': {
          clocks.set(command.client, (clocks.get(command.client) ?? 0) + 1);
          event = { e: 'remoteUpdate', localSv: encodeSv(clocks), localDs };
          break;
        }
        case 'localDelete':
        case 'remoteDelete': {
          getContent(deletions).delete(0, 1);
          localDs = deleteSetFingerprint(deletions);
          event =
            command.k === 'localDelete'
              ? { e: 'localUpdate', localSv: encodeSv(clocks), localDs, at: now }
              : { e: 'remoteUpdate', localSv: encodeSv(clocks), localDs };
          break;
        }
        case 'ack': {
          previousAcknowledged = acknowledged;
          previousAcknowledgedDs = acknowledgedDs;
          acknowledgedDs = localDs;
          acknowledged = new Map(clocks);
          seq += 1;
          event = { e: 'persisted', seq, sv: encodeSv(acknowledged), ds: acknowledgedDs };
          break;
        }
        case 'staleAck': {
          // The head the writer had one commit ago, replayed out of order: `seq` is what must make
          // the machine ignore it, never the vector.
          event = {
            e: 'persisted',
            seq: Math.max(0, seq - 1),
            sv: encodeSv(previousAcknowledged),
            ds: previousAcknowledgedDs,
          };
          break;
        }
        case 'syncStatus':
          event = { e: 'syncStatus', applied: command.applied };
          break;
        case 'unsynced':
          event = { e: 'unsyncedChanges', n: command.n };
          break;
        case 'persistFailed':
          event = { e: 'persistFailed', reason: command.reason, at: now };
          break;
        case 'projected':
          event = { e: 'projected', seq };
          break;
        case 'role':
          event = { e: 'role', role: command.role };
          break;
        case 'contentInvalid':
          event = { e: 'contentInvalid' };
          break;
        case 'sizeExceeded':
          event = { e: 'sizeExceeded' };
          break;
        case 'oversizeDelta':
          event = { e: 'oversizeDelta' };
          break;
        case 'close':
          closed = true;
          event = { e: 'close', reason: command.reason, via: command.via };
          break;
        case 'status':
          event = { e: 'status', socket: command.socket };
          break;
        case 'open':
          event = { e: 'open' };
          break;
        case 'authenticated':
          event = { e: 'authenticated' };
          break;
        case 'synced':
          event = { e: 'synced' };
          break;
        case 'baselineSent':
          event = { e: 'baselineSent' };
          break;
        case 'tick':
          now += command.advanceMs;
          event = { e: 'tick', now };
          break;
      }
      input = reduceSaveInput(input, event);
      steps.push({ command, event, input });
    }
    return steps;
  } finally {
    deletions.destroy();
  }
}
