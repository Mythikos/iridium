/**
 * `save-state.unit` — the parts of the Saved indicator that are a table rather than a property
 * (05-collaboration-and-durability.md, *Client state machine*; 09-api-reference.md section 3.9).
 *
 * `save-state.machine.prop` folds generated traces and asserts what must be true of every snapshot.
 * What it cannot do is check the two *mappings* the module carries, because a property that derived
 * them would be asserting the module against itself: which state each close reason produces, and
 * which field each event moves. Both are written out here as the plan writes them, so an edit to
 * either table fails against the plan's own wording rather than against a paraphrase of it.
 */

import {
  COLLAB_CLOSE_REASONS,
  type CollabCloseReason,
  type SaveStateInput,
} from '@iridium/contracts';
import { EMPTY_DELETE_SET_FINGERPRINT } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { encodeSv } from '../test/save-state-model.ts';
import {
  DOMINANCE_DEADLINE_MS,
  initialSaveInput,
  reduceSaveInput,
  SAVE_STATES,
  type SaveEvent,
  type SaveState,
  saveState,
  warnsBeforeUnload,
} from './save-state.ts';

const EMPTY_SV = encodeSv(new Map());
const START_NOW = 1_000;

function base(): SaveStateInput {
  return initialSaveInput({
    role: 'editor',
    localSv: EMPTY_SV,
    localDs: EMPTY_DELETE_SET_FINGERPRINT,
    now: START_NOW,
  });
}

function fold(input: SaveStateInput, ...events: SaveEvent[]): SaveStateInput {
  let next = input;
  for (const event of events) next = reduceSaveInput(next, event);
  return next;
}

/** A connected, authenticated, synced, writable session with nothing outstanding. */
function attached(): SaveStateInput {
  return fold(
    base(),
    { e: 'status', socket: 'connected' },
    { e: 'authenticated' },
    { e: 'synced' },
    { e: 'unsyncedChanges', n: 0 },
  );
}

/** The names of the fields that differ, so an event's effect is asserted as a whole. */
function changedFields(before: SaveStateInput, after: SaveStateInput): string[] {
  const left = new Map<string, unknown>(Object.entries(before));
  const right = new Map<string, unknown>(Object.entries(after));
  return [...left.keys()].filter((key) => !Object.is(left.get(key), right.get(key))).toSorted();
}

/**
 * The close-reason table of 05-collaboration-and-durability.md, *Client state machine*, copied from
 * the plan. `no-owner-lease` is the one entry the plan's own table does not carry yet: the owner-lease
 * work item of 12-milestones.md section 5.2 adds it, and the client treats it exactly as `capacity`.
 */
const CLOSE_REASON_STATES: Readonly<Record<CollabCloseReason, SaveState>> = {
  unauthorized: 'unauthorized',
  revoked: 'revoked',
  'note-not-found': 'closed',
  'note-trashed': 'trashed',
  'note-closing': 'closed',
  'vault-archived': 'vault-archived',
  'too-large': 'too-large',
  'rate-limited': 'closed',
  capacity: 'capacity',
  unavailable: 'disconnected',
  'awareness-spoof': 'revoked',
  'protocol-error': 'revoked',
  shutdown: 'closed',
  'no-owner-lease': 'capacity',
};

describe('save-state.unit [hp:HP-1]', () => {
  describe('the states', () => {
    it('declares the fourteen states of the plan, in the plan order', () => {
      expect(SAVE_STATES).toEqual([
        'connecting',
        'syncing',
        'saved',
        'save-failed',
        'disconnected',
        'read-only',
        'rejected',
        'revoked',
        'unauthorized',
        'capacity',
        'vault-archived',
        'too-large',
        'trashed',
        'closed',
      ]);
    });

    it('starts a session disconnected until its socket is up, then connecting until it is synced', () => {
      const input = base();
      // Rule 8 is `socket !== 'connected'`, so a socket that is still dialling is `disconnected`
      // and `connecting` is the *handshake* state that follows it — "Reconnecting…" then the
      // spinner. The state diagram of 05-collaboration-and-durability.md draws `[*] --> connecting`
      // and skips that first step; the ordered table is the normative definition and it is the one
      // implemented here.
      expect(saveState(input)).toBe('disconnected');
      expect(saveState(fold(input, { e: 'status', socket: 'connected' }))).toBe('connecting');
      expect(
        saveState(fold(input, { e: 'status', socket: 'connected' }, { e: 'authenticated' })),
      ).toBe('connecting');
      expect(input.persisted).toBeNull();
      expect(input.closeReason).toBeNull();
      expect(input.now).toBe(START_NOW);
      // Nothing is acknowledged, so there is unsaved work by definition — even before an edit,
      // which is what makes the warning independent of the rule order.
      expect(warnsBeforeUnload(input)).toBe(true);
    });
  });

  describe('close reasons', () => {
    it.each(COLLAB_CLOSE_REASONS)('classifies %s as the plan states', (reason) => {
      const closed = fold(attached(), { e: 'close', reason, via: 'close-frame' });
      expect(saveState(closed)).toBe(CLOSE_REASON_STATES[reason]);
    });

    it('classifies every close reason the contract declares', () => {
      expect(Object.keys(CLOSE_REASON_STATES).toSorted()).toEqual(
        [...COLLAB_CLOSE_REASONS].toSorted(),
      );
    });

    it('never clears a close reason, whatever arrives afterwards', () => {
      const closed = fold(attached(), { e: 'close', reason: 'note-trashed', via: 'close-frame' });
      const later = fold(
        closed,
        { e: 'status', socket: 'connected' },
        { e: 'authenticated' },
        { e: 'synced' },
        { e: 'persisted', ds: EMPTY_DELETE_SET_FINGERPRINT, seq: 9, sv: EMPTY_SV },
        { e: 'unsyncedChanges', n: 0 },
        { e: 'tick', now: START_NOW + 60_000 },
      );
      expect(later.closeReason).toBe('note-trashed');
      expect(saveState(later)).toBe('trashed');
    });

    it('keeps the two policies of one rate-limited reason apart', () => {
      const fromFrame = fold(attached(), {
        e: 'close',
        reason: 'rate-limited',
        via: 'close-frame',
      });
      const fromDenial = fold(attached(), {
        e: 'close',
        reason: 'rate-limited',
        via: 'auth-denied',
      });
      // The state is the same; `closeVia` is what `close-policy.ts` keys the retry on (D05-25).
      expect(saveState(fromFrame)).toBe('closed');
      expect(saveState(fromDenial)).toBe('closed');
      expect(fromFrame.closeVia).toBe('close-frame');
      expect(fromDenial.closeVia).toBe('auth-denied');
    });
  });

  describe('the accumulator', () => {
    it('moves the socket, the handshake and the count as the provider reports them', () => {
      const before = attached();
      const opened = fold(before, { e: 'open' });
      expect(changedFields(before, opened)).toEqual(['authenticated', 'synced']);
      expect(opened.authenticated).toBe(false);
      expect(opened.synced).toBe(false);

      const counted = fold(before, { e: 'unsyncedChanges', n: 7 });
      expect(changedFields(before, counted)).toEqual(['unsynced']);
      expect(counted.unsynced).toBe(7);

      const dropped = fold(before, { e: 'status', socket: 'disconnected' });
      expect(changedFields(before, dropped)).toEqual(['socket']);
      expect(saveState(dropped)).toBe('disconnected');
    });

    it('counts a local edit, its vector and its time; a relayed edit moves only the vector', () => {
      const before = attached();
      const local = fold(before, {
        e: 'localUpdate',
        localSv: encodeSv(new Map([[11, 1]])),
        localDs: EMPTY_DELETE_SET_FINGERPRINT,
        at: 2_000,
      });
      expect(changedFields(before, local)).toEqual(['lastLocalEditAt', 'localSv', 'unsynced']);
      expect(local.unsynced).toBe(1);
      expect(local.lastLocalEditAt).toBe(2_000);

      const relayed = fold(before, {
        e: 'remoteUpdate',
        localDs: EMPTY_DELETE_SET_FINGERPRINT,
        localSv: encodeSv(new Map([[22, 4]])),
      });
      expect(changedFields(before, relayed)).toEqual(['localSv']);
      expect(relayed.unsynced).toBe(0);
      expect(relayed.lastLocalEditAt).toBeNull();
    });

    it('decrements only on an applied sync status, because a refusal raises no event (D09-24)', () => {
      const pending = fold(attached(), { e: 'unsyncedChanges', n: 2 });
      expect(fold(pending, { e: 'syncStatus', applied: true }).unsynced).toBe(1);
      expect(fold(pending, { e: 'syncStatus', applied: false })).toBe(pending);
      expect(fold(attached(), { e: 'syncStatus', applied: true }).unsynced).toBe(0);
    });

    it('ignores an acknowledgement older than the one it already has', () => {
      const acked = fold(attached(), {
        e: 'persisted',
        ds: EMPTY_DELETE_SET_FINGERPRINT,
        seq: 5,
        sv: EMPTY_SV,
      });
      const stale = fold(acked, {
        e: 'persisted',
        ds: EMPTY_DELETE_SET_FINGERPRINT,
        seq: 4,
        sv: encodeSv(new Map([[11, 9]])),
      });
      expect(stale).toBe(acked);
      expect(stale.persisted?.seq).toBe(5);
    });

    it('lets a newer acknowledgement clear a standing failure', () => {
      const failed = fold(attached(), {
        e: 'persistFailed',
        reason: 'backpressure',
        at: START_NOW,
      });
      expect(saveState(failed)).toBe('save-failed');
      const recovered = fold(failed, {
        e: 'persisted',
        ds: EMPTY_DELETE_SET_FINGERPRINT,
        seq: 1,
        sv: EMPTY_SV,
      });
      expect(recovered.persistFailed).toBeNull();
      expect(saveState(recovered)).toBe('saved');
    });

    it('carries the optional seq of a failure only when the writer knew it', () => {
      const withSeq = fold(attached(), {
        e: 'persistFailed',
        seq: 12,
        reason: 'db_error',
        at: START_NOW,
      });
      const without = fold(attached(), { e: 'persistFailed', reason: 'db_error', at: START_NOW });
      expect(withSeq.persistFailed?.seq).toBe(12);
      expect(without.persistFailed).not.toBeNull();
      expect(without.persistFailed && 'seq' in without.persistFailed).toBe(false);
    });

    it('moves no field for a baseline request', () => {
      const before = attached();
      expect(fold(before, { e: 'baselineSent' })).toBe(before);
    });

    it('advances now only through a tick', () => {
      const before = attached();
      const ticked = fold(before, { e: 'tick', now: START_NOW + DOMINANCE_DEADLINE_MS });
      expect(changedFields(before, ticked)).toEqual(['now']);
      expect(ticked.now).toBe(START_NOW + DOMINANCE_DEADLINE_MS);
    });
  });
});
