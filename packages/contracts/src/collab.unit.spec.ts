import { describe, expect, it } from 'vitest';

import {
  AwarenessState,
  Base64Sv,
  BaselineMsg,
  CLIENT_NOTE_MESSAGE_TYPES,
  COLLAB_CLOSE_CODES,
  COLLAB_CLOSE_REASONS,
  ClientNoteMessage,
  decodeClientNoteMessage,
  decodeServerNoteMessage,
  decodeServerVaultMessage,
  encodeStateless,
  noteDocName,
  parseDocName,
  SAVE_STATE_INPUT_SOURCES,
  SERVER_NOTE_MESSAGE_TYPES,
  SERVER_VAULT_MESSAGE_TYPES,
  Seq,
  ServerNoteMessage,
  ServerVaultMessage,
  STATELESS_DECODE_FAILURES,
  UNMAPPED_PROVIDER_SIGNALS,
  VaultAwarenessState,
  vaultDocName,
  type CollabCloseReason,
  type IridiumCollabContext,
  type SaveStateInput,
  type ServerNoteMessage as ServerNoteMessageType,
  type ServerVaultMessage as ServerVaultMessageType,
  type StatelessDecodeFailure,
} from './collab.ts';
import { NodeId, newId, NoteId, UserId, VaultId } from './ids.ts';
import { LIMITS } from './limits.ts';

const USER_ID = UserId.parse(newId());
const NODE_ID = NodeId.parse(newId());
const NOTE_ID = NoteId.parse(newId());
const VAULT_ID = VaultId.parse(newId());

/** A base64 state vector of the smallest legal length (`min(4)`, an empty document's vector). */
const SV = 'AA==';

/**
 * One valid sample per `t` the server sends on `note:<uuid>`, with every documented member present —
 * so a field the module drops or renames fails here rather than at run time on a live socket.
 */
const EMPTY_DS = '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7';

const SERVER_NOTE_SAMPLES: Readonly<Record<string, ServerNoteMessageType>> = {
  persisted: { v: 1, t: 'persisted', ds: EMPTY_DS, seq: 7, sv: SV },
  'persist-failed': { v: 1, t: 'persist-failed', seq: 7, reason: 'backpressure', retryInMs: 200 },
  projected: { v: 1, t: 'projected', seq: 7 },
  role: { v: 1, t: 'role', role: 'editor' },
  participants: {
    v: 1,
    t: 'participants',
    users: [{ id: USER_ID, name: 'Editor A', colorHue: 210, role: 'editor', mode: 'source' }],
  },
  closing: { v: 1, t: 'closing', reason: 'shutdown', graceMs: 2000 },
  checkpoint: { v: 1, t: 'checkpoint', seq: 7, revisionId: 3, kind: 'named', label: 'before edit' },
  'content-invalid': { v: 1, t: 'content-invalid', reason: 'cr' },
  'size-exceeded': {
    v: 1,
    t: 'size-exceeded',
    size: 1_000_001,
    max: LIMITS.NOTE_SOFT_MAX_UTF16,
  },
};

/** One valid sample per `t` the server sends on `vault:<uuid>`. */
const SERVER_VAULT_SAMPLES: Readonly<Record<string, ServerVaultMessageType>> = {
  'tree-changed': {
    v: 1,
    t: 'tree-changed',
    treeVersion: 12,
    changes: [
      {
        nodeId: NODE_ID,
        parentId: NODE_ID,
        kind: 'note',
        name: 'Roadmap',
        path: 'Projects/Roadmap.md',
        op: 'created',
        version: 1,
      },
    ],
  },
  'member-changed': {
    v: 1,
    t: 'member-changed',
    userId: USER_ID,
    role: null,
    displayName: 'Editor A',
    colorHue: 210,
  },
  'vault-updated': { v: 1, t: 'vault-updated', version: 4, changed: ['mcpEnabled'] },
};

describe('contracts.collab.unit [area:contracts]', () => {
  describe('document names', () => {
    it('parses the two channels and rejects everything else', () => {
      expect(parseDocName(noteDocName(NOTE_ID))).toStrictEqual({ channel: 'note', id: NOTE_ID });
      expect(parseDocName(vaultDocName(VAULT_ID))).toStrictEqual({
        channel: 'vault',
        id: VAULT_ID,
      });
      expect(parseDocName(`note:${NOTE_ID.toUpperCase()}`)).toBeNull();
      expect(parseDocName(`attachment:${NOTE_ID}`)).toBeNull();
      expect(parseDocName('note:not-a-uuid')).toBeNull();
    });
  });

  describe('the server to client tables of section 3.4 and 3.5', () => {
    it('covers exactly the documented message types', () => {
      expect(Object.keys(SERVER_NOTE_SAMPLES)).toStrictEqual([...SERVER_NOTE_MESSAGE_TYPES]);
      expect(Object.keys(SERVER_VAULT_SAMPLES)).toStrictEqual([...SERVER_VAULT_MESSAGE_TYPES]);
      expect([...CLIENT_NOTE_MESSAGE_TYPES]).toStrictEqual(['baseline', 'flush']);
    });

    it.each(Object.entries(SERVER_NOTE_SAMPLES))('round-trips the %s message', (_type, sample) => {
      const decoded = decodeServerNoteMessage(encodeStateless(sample));
      expect(decoded).toStrictEqual({ ok: true, message: sample });
    });

    it.each(Object.entries(SERVER_VAULT_SAMPLES))('round-trips the %s message', (_type, sample) => {
      const decoded = decodeServerVaultMessage(encodeStateless(sample));
      expect(decoded).toStrictEqual({ ok: true, message: sample });
    });

    it('accepts the optional members being absent', () => {
      const withoutSeq = { v: 1, t: 'persist-failed', reason: 'db_error', retryInMs: 0 } as const;
      expect(ServerNoteMessage.safeParse(withoutSeq).success).toBe(true);
      const withoutChanged = { v: 1, t: 'vault-updated', version: 4 } as const;
      expect(ServerVaultMessage.safeParse(withoutChanged).success).toBe(true);
    });

    it('holds the bounds the reference section states', () => {
      expect(Seq.safeParse(-1).success).toBe(false);
      expect(Seq.safeParse(1.5).success).toBe(false);
      expect(Base64Sv.safeParse('AA').success).toBe(false);
      expect(Base64Sv.safeParse('A'.repeat(87_401)).success).toBe(false);
      expect(Base64Sv.safeParse('not base64!').success).toBe(false);
      const tooManyParticipants = {
        ...SERVER_NOTE_SAMPLES['participants'],
        users: Array.from({ length: 65 }, () => ({
          id: USER_ID,
          name: 'A',
          colorHue: 0,
          role: 'viewer' as const,
        })),
      };
      expect(ServerNoteMessage.safeParse(tooManyParticipants).success).toBe(false);
      const tooLongGrace = { v: 1, t: 'closing', reason: 'shutdown', graceMs: 60_001 } as const;
      expect(ServerNoteMessage.safeParse(tooLongGrace).success).toBe(false);
    });
  });

  describe('the client to server table of section 3.4', () => {
    it('round-trips baseline and flush', () => {
      for (const message of [
        { v: 1, t: 'baseline' },
        { v: 1, t: 'flush' },
      ] as const) {
        expect(decodeClientNoteMessage(encodeStateless(message))).toStrictEqual({
          ok: true,
          message,
        });
      }
      expect(BaselineMsg.safeParse({ v: 1, t: 'baseline' }).success).toBe(true);
      expect(ClientNoteMessage.safeParse({ v: 1, t: 'flush' }).success).toBe(true);
    });

    it('refuses every malformed payload with the reason the plan names', () => {
      const cases: ReadonlyArray<readonly [string, StatelessDecodeFailure]> = [
        ['{', 'not_json'],
        ['[]', 'not_an_object'],
        ['"baseline"', 'not_an_object'],
        ['{"t":"baseline"}', 'unknown_version'],
        ['{"v":2,"t":"baseline"}', 'unknown_version'],
        ['{"v":1}', 'unknown_type'],
        ['{"v":1,"t":"persisted","seq":1,"sv":"AA=="}', 'unknown_type'],
        ['{"v":1,"t":"baseline","extra":true}', 'invalid_payload'],
      ];
      const observed = cases.map(([payload]) => {
        const decoded = decodeClientNoteMessage(payload);
        return decoded.ok ? 'accepted' : decoded.reason;
      });
      expect(observed).toStrictEqual(cases.map(([, reason]) => reason));
      expect([...STATELESS_DECODE_FAILURES]).toContain('too_large');
    });

    it('applies the 4 KiB stateless cap to the client direction only', () => {
      const padded = `{"v":1,"t":"baseline","pad":"${'x'.repeat(LIMITS.STATELESS_PAYLOAD_MAX_BYTES)}"}`;
      expect(decodeClientNoteMessage(padded)).toStrictEqual({
        ok: false,
        reason: 'too_large',
        detail: expect.stringContaining('4096'),
      });

      const wideVector = encodeStateless({
        v: 1,
        t: 'persisted',
        ds: EMPTY_DS,
        seq: 1,
        sv: 'A'.repeat(80_000),
      });
      expect(wideVector.length).toBeGreaterThan(LIMITS.STATELESS_PAYLOAD_MAX_BYTES);
      expect(decodeServerNoteMessage(wideVector).ok).toBe(true);
    });

    it('never reports a failure detail that echoes the payload', () => {
      const decoded = decodeClientNoteMessage('{"v":1,"t":"baseline","secret":"irid_tkt_leaked"}');
      expect(decoded.ok).toBe(false);
      expect(JSON.stringify(decoded)).not.toContain('irid_tkt_leaked');
    });
  });

  describe('awareness (section 3.7)', () => {
    it('carries an id, an optional cursor and an optional mode, and nothing else', () => {
      expect(AwarenessState.safeParse({ user: { id: USER_ID } }).success).toBe(true);
      expect(
        AwarenessState.safeParse({ user: { id: USER_ID }, cursor: null, mode: 'split' }).success,
      ).toBe(true);
      expect(
        AwarenessState.safeParse({ user: { id: USER_ID, name: 'chosen by the client' } }).success,
      ).toBe(false);
      expect(AwarenessState.safeParse({ user: { id: USER_ID }, colorHue: 1 }).success).toBe(false);
      expect(
        VaultAwarenessState.safeParse({ user: { id: USER_ID }, activeNoteId: null }).success,
      ).toBe(true);
    });
  });

  describe('close reasons and codes (section 3.6)', () => {
    it('gives every reason exactly one code', () => {
      const reasons: readonly CollabCloseReason[] = COLLAB_CLOSE_REASONS;
      expect(Object.keys(COLLAB_CLOSE_CODES).toSorted()).toStrictEqual(reasons.toSorted());
      for (const reason of reasons) {
        expect(COLLAB_CLOSE_CODES[reason]).toBeGreaterThan(0);
      }
    });

    it('uses the codes the reference table states', () => {
      expect(COLLAB_CLOSE_CODES.unauthorized).toBe(4401);
      expect(COLLAB_CLOSE_CODES['note-not-found']).toBe(4404);
      expect(COLLAB_CLOSE_CODES['too-large']).toBe(1009);
      expect(COLLAB_CLOSE_CODES.shutdown).toBe(4205);
      expect(COLLAB_CLOSE_CODES.revoked).toBe(4403);
      // The owner-lease refusal of 12-milestones.md section 5.2, which 05 and 09 do not list yet.
      expect(COLLAB_CLOSE_CODES['no-owner-lease']).toBe(4503);
      expect(COLLAB_CLOSE_CODES.unavailable).toBe(4503);
    });
  });

  describe('the connection context (section 3.2)', () => {
    it('carries the complete member list authorship is taken from', () => {
      const context: IridiumCollabContext = {
        sessionId: newId(),
        userId: USER_ID,
        vaultId: VAULT_ID,
        noteId: NOTE_ID,
        role: 'editor',
        isServerAdmin: false,
        authzEpoch: { userAuthzVersion: 3, memberVersion: 1 },
        ip: '203.0.113.7',
        requestId: newId(),
        connectedAt: 1_700_000_000_000,
        clientName: 'desktop',
        clientVersion: '0.1.0',
      };
      expect(Object.keys(context).toSorted()).toStrictEqual([
        'authzEpoch',
        'clientName',
        'clientVersion',
        'connectedAt',
        'ip',
        'isServerAdmin',
        'noteId',
        'requestId',
        'role',
        'sessionId',
        'userId',
        'vaultId',
      ]);
    });
  });

  describe('the required deletion witness', () => {
    it.each([undefined, '', '0'.repeat(63), '0'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])(
      'refuses missing or noncanonical SHA-256 witness %s',
      (ds) => {
        const payload = JSON.stringify({ v: 1, t: 'persisted', seq: 1, sv: 'AA==', ds });
        expect(decodeServerNoteMessage(payload)).toMatchObject({
          ok: false,
          reason: 'invalid_payload',
        });
      },
    );
  });

  describe('the save-state input mapping (section 3.9)', () => {
    it('maps every field of SaveStateInput and nothing else', () => {
      const input: SaveStateInput = {
        socket: 'connected',
        authenticated: true,
        synced: true,
        unsynced: 0,
        localSv: new Uint8Array([0]),
        localDs: EMPTY_DS,
        persisted: { seq: 7, sv: new Uint8Array([0]), ds: EMPTY_DS },
        persistFailed: null,
        projectedSeq: 7,
        role: 'editor',
        contentInvalid: false,
        oversize: false,
        oversizeDelta: false,
        closeReason: null,
        closeVia: null,
        lastLocalEditAt: null,
        now: 1_700_000_000_000,
      };
      expect(Object.keys(SAVE_STATE_INPUT_SOURCES).toSorted()).toStrictEqual(
        Object.keys(input).toSorted(),
      );
    });

    it('leaves SyncStatus(applied=false) mapped to no input at all (D09-24)', () => {
      const sources = Object.values(SAVE_STATE_INPUT_SOURCES);
      for (const signal of UNMAPPED_PROVIDER_SIGNALS) {
        expect(sources.some((source) => 'signal' in source && source.signal === signal)).toBe(
          false,
        );
      }
      expect([...UNMAPPED_PROVIDER_SIGNALS]).toStrictEqual(['SyncStatus(applied=false)']);
    });

    it('names only stateless messages the server actually sends', () => {
      const named = Object.values(SAVE_STATE_INPUT_SOURCES).flatMap((source) =>
        source.from === 'stateless' ? [source.t] : [],
      );
      expect(named).not.toHaveLength(0);
      expect(named.filter((type) => !SERVER_NOTE_MESSAGE_TYPES.includes(type))).toStrictEqual([]);
    });
  });
});
