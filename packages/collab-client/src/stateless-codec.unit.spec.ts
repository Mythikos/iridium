/**
 * `stateless-codec.unit` — what the client sends on `note:<uuid>`, and what it does with what it
 * receives (09-api-reference.md sections 3.4, 3.9 and 7.2).
 *
 * Two things are asserted that nothing else can assert. First, that the client's own frames are
 * accepted by the **server's** decoder, bounds included, so the two directions cannot drift into a
 * client that sends what the server closes the connection for. Second, that the mapping from
 * message to save-state input is exactly the one `SAVE_STATE_INPUT_SOURCES` publishes: that table
 * is `@iridium/contracts`' and is asserted there to cover every field of `SaveStateInput`, so
 * checking this module against it closes the loop without a second list of message types.
 */

import {
  decodeClientNoteMessage,
  encodeStateless,
  LIMITS,
  SAVE_STATE_INPUT_SOURCES,
  SERVER_NOTE_MESSAGE_TYPES,
  type ServerNoteMessage,
  STATELESS_DECODE_FAILURES,
} from '@iridium/contracts';
import { EMPTY_DELETE_SET_FINGERPRINT } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { encodeSv } from '../test/save-state-model.ts';
import { base64ToBytes } from './base64.ts';
import { baselinePayload, flushPayload, receiveNoteStateless } from './messages.ts';

const AT = 4_242;

/** Base64 of the canonical empty state vector, which is what a fresh note is acknowledged with. */
const EMPTY_SV_BASE64 = 'AA==';

/** One sample of every message the server can send on a note channel. */
const SAMPLES: Readonly<Record<(typeof SERVER_NOTE_MESSAGE_TYPES)[number], ServerNoteMessage>> = {
  persisted: {
    v: 1,
    t: 'persisted',
    ds: EMPTY_DELETE_SET_FINGERPRINT,
    seq: 7,
    sv: EMPTY_SV_BASE64,
  },
  'persist-failed': { v: 1, t: 'persist-failed', reason: 'db_unavailable', retryInMs: 1_000 },
  projected: { v: 1, t: 'projected', seq: 7 },
  role: { v: 1, t: 'role', role: 'editor' },
  participants: { v: 1, t: 'participants', users: [] },
  closing: { v: 1, t: 'closing', reason: 'shutdown', graceMs: 2_000 },
  checkpoint: { v: 1, t: 'checkpoint', seq: 7, revisionId: 3, kind: 'checkpoint' },
  'content-invalid': { v: 1, t: 'content-invalid', reason: 'cr' },
  'size-exceeded': { v: 1, t: 'size-exceeded', size: 1, max: LIMITS.NOTE_SOFT_MAX_UTF16 },
};

/** The message types 09-api-reference.md section 3.9 maps onto a `SaveStateInput` field. */
const TYPES_THAT_FEED_STATE: ReadonlySet<string> = new Set(
  Object.values(SAVE_STATE_INPUT_SOURCES).flatMap((source) =>
    source.from === 'stateless' ? [source.t] : [],
  ),
);

function intake(message: ServerNoteMessage): ReturnType<typeof receiveNoteStateless> {
  return receiveNoteStateless(encodeStateless(message), AT);
}

describe('stateless-codec.unit [area:collab]', () => {
  describe('what the client sends', () => {
    it('sends frames the server decoder accepts', () => {
      expect(decodeClientNoteMessage(baselinePayload())).toEqual({
        ok: true,
        message: { v: 1, t: 'baseline' },
      });
      expect(decodeClientNoteMessage(flushPayload())).toEqual({
        ok: true,
        message: { v: 1, t: 'flush' },
      });
    });

    it('sends frames far inside the client-to-server cap', () => {
      for (const payload of [baselinePayload(), flushPayload()]) {
        expect(payload.length).toBeLessThan(LIMITS.STATELESS_PAYLOAD_MAX_BYTES);
      }
    });
  });

  describe('what the client receives', () => {
    it.each(SERVER_NOTE_MESSAGE_TYPES)('accepts %s and returns it verbatim', (type) => {
      const result = intake(SAMPLES[type]);
      expect(result.kind).toBe('message');
      if (result.kind !== 'message') return;
      expect(result.message).toEqual(SAMPLES[type]);
    });

    it('produces save-state inputs for exactly the messages section 3.9 maps', () => {
      for (const type of SERVER_NOTE_MESSAGE_TYPES) {
        const result = intake(SAMPLES[type]);
        expect(result.kind).toBe('message');
        if (result.kind !== 'message') continue;
        expect(result.events.length > 0).toBe(TYPES_THAT_FEED_STATE.has(type));
      }
    });

    it('carries the clock reading into a persist-failed, which the wire does not', () => {
      const result = intake(SAMPLES['persist-failed']);
      expect(result.kind === 'message' && result.events[0]).toEqual({
        e: 'persistFailed',
        reason: 'db_unavailable',
        at: AT,
      });
    });

    it('decodes the acknowledged state vector into the bytes the dominance check compares', () => {
      // `AQsD` is the base64 of `[1, 11, 3]`: one entry, client 11, clock 3 — the vector a note
      // edited once by that client is acknowledged with.
      const result = receiveNoteStateless(
        encodeStateless({
          v: 1,
          t: 'persisted',
          ds: EMPTY_DELETE_SET_FINGERPRINT,
          seq: 2,
          sv: 'AQsD',
        }),
        AT,
      );
      expect(result.kind === 'message' && result.events[0]).toEqual({
        e: 'persisted',
        ds: EMPTY_DELETE_SET_FINGERPRINT,
        seq: 2,
        sv: Uint8Array.from(encodeSv(new Map([[11, 3]]))),
      });
    });
  });

  describe('what the client refuses', () => {
    it('ignores a message a newer server added, and one with a newer envelope', () => {
      const unknownType = receiveNoteStateless(JSON.stringify({ v: 1, t: 'compacted' }), AT);
      const unknownVersion = receiveNoteStateless(JSON.stringify({ v: 2, t: 'persisted' }), AT);
      expect(unknownType).toEqual({
        kind: 'ignored',
        reason: 'unknown_type',
        detail: expect.any(String),
      });
      expect(unknownVersion).toEqual({
        kind: 'ignored',
        reason: 'unknown_version',
        detail: expect.any(String),
      });
    });

    it('reports a payload its peer had no business sending', () => {
      expect(receiveNoteStateless('{', AT).kind).toBe('invalid');
      expect(receiveNoteStateless('[]', AT).kind).toBe('invalid');
      expect(receiveNoteStateless(JSON.stringify({ v: 1, t: 'projected' }), AT).kind).toBe(
        'invalid',
      );
    });

    it('refuses an acknowledgement whose state vector is not decodable bytes', () => {
      // Five characters: inside `Base64Sv`'s alphabet and length bounds, and not a byte sequence.
      const result = receiveNoteStateless(
        encodeStateless({
          v: 1,
          t: 'persisted',
          ds: EMPTY_DELETE_SET_FINGERPRINT,
          seq: 1,
          sv: 'AAAAA',
        }),
        AT,
      );
      expect(result).toEqual({
        kind: 'invalid',
        reason: 'invalid_payload',
        detail: expect.any(String),
      });
    });

    it.each(['AQs=', 'AAAB', 'AgsDCwQ=', 'gQALAw=='])(
      'refuses base64 %s whose bytes are truncated or noncanonical CRDT clocks',
      (sv) => {
        expect(
          receiveNoteStateless(
            encodeStateless({ v: 1, t: 'persisted', ds: EMPTY_DELETE_SET_FINGERPRINT, seq: 1, sv }),
            AT,
          ),
        ).toEqual({ kind: 'invalid', reason: 'invalid_payload', detail: expect.any(String) });
      },
    );

    it.each([undefined, '', '0'.repeat(63), '0'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])(
      'refuses a missing or noncanonical deletion fingerprint %s before producing a save event',
      (ds) => {
        const payload = JSON.stringify({ v: 1, t: 'persisted', seq: 1, sv: 'AA==', ds });
        expect(receiveNoteStateless(payload, AT)).toMatchObject({
          kind: 'invalid',
          reason: 'invalid_payload',
        });
      },
    );

    it('splits every refusal the contract declares into ignored and reported', () => {
      const ignored = new Set(['unknown_type', 'unknown_version']);
      // The split is exhaustive over the contract's vocabulary, so a failure added there lands in
      // one of the two branches rather than in neither. `too_large` is the one member no
      // client-side path can produce — the 4 KiB cap belongs to the server's decoder alone
      // (09-api-reference.md section 3.10) — and it is reported if it ever arrives.
      const reported = [...STATELESS_DECODE_FAILURES].filter((failure) => !ignored.has(failure));
      expect([...STATELESS_DECODE_FAILURES].filter((failure) => ignored.has(failure))).toEqual([
        'unknown_version',
        'unknown_type',
      ]);
      expect(reported).toEqual(['too_large', 'not_json', 'not_an_object', 'invalid_payload']);
    });
  });

  describe('base64', () => {
    it('round-trips the bytes a state vector is made of', () => {
      expect(base64ToBytes('AA==')).toEqual(Uint8Array.from([0]));
      expect(base64ToBytes('AQID')).toEqual(Uint8Array.from([1, 2, 3]));
      expect(base64ToBytes('')).toEqual(Uint8Array.from([]));
    });

    it('refuses what is not a canonical encoding rather than inventing bytes', () => {
      expect(base64ToBytes('AAAAA')).toBeNull(); // length is not a multiple of four
      expect(base64ToBytes('A=A=')).toBeNull(); // padding in the middle
      expect(base64ToBytes('A-==')).toBeNull(); // outside the standard alphabet
      expect(base64ToBytes('AB==')).toBeNull(); // the bits a padded group leaves over are set
    });
  });
});
