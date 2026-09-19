/**
 * The client half of the `/collab` stateless channel: what a client sends, what it does with what
 * it receives, and which `SaveEvent`s a received message produces
 * (09-api-reference.md section 3.4 and section 3.9; 05-collaboration-and-durability.md,
 * *Message schemas*).
 *
 * The schemas, the codec and the failure vocabulary are `@iridium/contracts`' and are used from
 * there unchanged — this module adds no message, no field and no bound. What it owns is the two
 * client-side policies the wire contract states in prose:
 *
 * - **Forward compatibility.** `unknown_type` and `unknown_version` are ignored so a newer server
 *   can add a message without breaking an older client (09-api-reference.md section 7.2); every
 *   other failure is a bug in the peer and is reported to the caller so it reaches a log.
 * - **The section 3.9 mapping.** Six of the nine server messages fill a `SaveStateInput` field, and
 *   three (`participants`, `closing`, `checkpoint`) deliberately fill none. `SAVE_STATE_INPUT_SOURCES`
 *   is the table that decides which; `stateless-codec.unit` asserts this module agrees with it
 *   rather than carrying a second list.
 */

import {
  type ClientNoteMessage,
  decodeServerNoteMessage,
  encodeStateless,
  type ServerNoteMessage,
  type StatelessDecodeFailure,
} from '@iridium/contracts';
import { CrdtError, decodeStateVector, type StateVector } from '@iridium/crdt';

import { base64ToBytes } from './base64.ts';
import type { SaveEvent } from './save-state.ts';

/** The `baseline` payload, sent after every provider `synced` event (skeleton A19). */
export function baselinePayload(): string {
  const message: ClientNoteMessage = { v: 1, t: 'baseline' };
  return encodeStateless(message);
}

/** The `flush` payload: compaction and projection now (Ctrl/Cmd+S). */
export function flushPayload(): string {
  const message: ClientNoteMessage = { v: 1, t: 'flush' };
  return encodeStateless(message);
}

/**
 * What one received stateless payload amounts to.
 *
 * A refusal is a returned value rather than a throw, for the reason the contracts codec gives: an
 * unparseable frame is an expected condition on a public socket, and the two refusals differ in
 * what the caller must do — `ignored` is the forward-compatibility path and is silent, `invalid`
 * is a peer bug and is logged.
 */
export type StatelessIntake =
  | {
      readonly kind: 'message';
      readonly message: ServerNoteMessage;
      /** The save-state inputs this message carries; empty for the three that carry none. */
      readonly events: readonly SaveEvent[];
    }
  | {
      readonly kind: 'ignored';
      readonly reason: Extract<StatelessDecodeFailure, 'unknown_type' | 'unknown_version'>;
      readonly detail: string;
    }
  | { readonly kind: 'invalid'; readonly reason: StatelessDecodeFailure; readonly detail: string };

/**
 * Decode one server payload on `note:<uuid>` and derive the save-state inputs it carries.
 *
 * `at` is the caller's clock reading, which is the only way a timestamp enters the machine: the
 * `persist-failed` input of 09-api-reference.md section 3.9 carries one and the wire does not
 * (05-collaboration-and-durability.md D05-26 keeps every clock outside `save-state.ts`).
 */
export function receiveNoteStateless(payload: string, at: number): StatelessIntake {
  const decoded = decodeServerNoteMessage(payload);
  if (!decoded.ok) {
    return decoded.reason === 'unknown_type' || decoded.reason === 'unknown_version'
      ? { kind: 'ignored', reason: decoded.reason, detail: decoded.detail }
      : { kind: 'invalid', reason: decoded.reason, detail: decoded.detail };
  }

  const message = decoded.message;
  const events = saveEventsFor(message, at);
  if (events === null) {
    // The wire schema owns base64 and length limits; the CRDT package owns the binary format.
    // Reject before any caller retains an acknowledgement or uses it to compute an offline delta.
    return {
      kind: 'invalid',
      reason: 'invalid_payload',
      detail: 'persisted: sv is not a canonical base64 CRDT state vector',
    };
  }
  return { kind: 'message', message, events };
}

/**
 * The `SaveEvent`s one decoded message produces, or `null` when a `persisted` carried a state
 * vector that does not decode.
 *
 * `participants`, `closing` and `checkpoint` return no event by design: 09-api-reference.md
 * section 3.9 maps no `SaveStateInput` field to them, and they are handled by `NoteSession` as
 * presence, a grace window and a history row respectively.
 */
function saveEventsFor(message: ServerNoteMessage, at: number): readonly SaveEvent[] | null {
  switch (message.t) {
    case 'persisted': {
      const bytes = base64ToBytes(message.sv);
      if (bytes === null || bytes.byteLength === 0) return null;
      try {
        // The decoder validates canonical Yjs bytes; the brand is established only at this boundary.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validate untrusted bytes through the canonical CRDT decoder
        decodeStateVector(bytes as StateVector);
      } catch (error) {
        if (error instanceof CrdtError && error.code === 'malformed-state-vector') return null;
        throw error;
      }
      return [{ e: 'persisted', seq: message.seq, sv: bytes, ds: message.ds }];
    }
    case 'persist-failed':
      return [
        {
          e: 'persistFailed',
          ...(message.seq === undefined ? {} : { seq: message.seq }),
          reason: message.reason,
          at,
        },
      ];
    case 'projected':
      return [{ e: 'projected', seq: message.seq }];
    case 'role':
      return [{ e: 'role', role: message.role }];
    case 'content-invalid':
      return [{ e: 'contentInvalid' }];
    case 'size-exceeded':
      return [{ e: 'sizeExceeded' }];
    case 'participants':
    case 'closing':
    case 'checkpoint':
      return [];
    default: {
      // Unreachable while every message is handled; the binding is what makes a message added to
      // `ServerNoteMessage` fail to compile until this mapping decides what it feeds.
      const unhandled: never = message;
      throw new Error(`saveEventsFor: unhandled server message ${JSON.stringify(unhandled)}.`);
    }
  }
}
