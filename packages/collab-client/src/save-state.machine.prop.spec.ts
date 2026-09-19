// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
// oxlint-disable typescript/no-unsafe-type-assertion -- the wire carries a state vector as bytes
// (`@iridium/contracts` may not import yjs, A14) and `@iridium/crdt` brands the same bytes; this
// file re-derives dominance independently of `save-state.ts`, so it crosses that boundary itself.

/**
 * `save-state.machine.prop` — the client's Saved indicator
 * (10-testing-and-quality.md, `save-state.machine.prop` and HP-1; 05-collaboration-and-durability.md,
 * *The Saved protocol* and *Client state machine*).
 *
 * The subject is an ordered rule table with no memory and no timers, plus the pure accumulator that
 * turns provider events and stateless messages into the snapshots it reads. Because the table is
 * memoryless, every claim about it — "sticky", "terminal", "until" — has to be phrased as a
 * statement about *inputs*, which is what these properties do: fast-check generates a trace of
 * things that happen to a client, the model folds it into successive snapshots with **real encoded
 * state vectors**, and the assertions are made over the resulting states.
 *
 * The single most important property is the first: `saved` never appears for a snapshot whose
 * acknowledged vector does not contain every local edit. A false `saved` is the one failure the
 * product may not have (13-decision-log.md A19, deviation F2), and it is the reason this module is
 * in Stryker's mutate scope (D10-16).
 */

import { it } from '@fast-check/vitest';
import { PERSIST_FAILED_REASONS, ROLES, type SaveStateInput } from '@iridium/contracts';
import { decodeStateVector, dominates, type StateVector } from '@iridium/crdt';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { PROP } from '../test/prop-budget.ts';
import {
  type Command,
  encodeSv,
  fold,
  MODEL_CLIENT_IDS,
  type ModelStart,
  type Step,
} from '../test/save-state-model.ts';
import {
  DOMINANCE_DEADLINE_MS,
  matchSaveStateRule,
  SAVE_STATES,
  type SaveState,
  saveState,
  warnsBeforeUnload,
} from './save-state.ts';

// ---- arbitraries -------------------------------------------------------------------------------

const clientId = fc.constantFrom(...MODEL_CLIENT_IDS);

/**
 * Everything that can happen to a note **except** the five signals that match a rule above 12.
 *
 * A prefix drawn from this pool leaves the rules the witnesses below assert free to be decided by
 * the witness itself: a trace that had already been closed, or already carried invalid content,
 * could not then be driven into `syncing` by any suffix, because `reduceSaveInput` never clears
 * those fields — which is the property that makes them terminal.
 */
const quietCommand: fc.Arbitrary<Command> = fc.oneof(
  clientId.map((client): Command => ({ k: 'localEdit', client })),
  clientId.map((client): Command => ({ k: 'remoteEdit', client })),
  fc.constant<Command>({ k: 'localDelete' }),
  fc.constant<Command>({ k: 'remoteDelete' }),
  fc.constant<Command>({ k: 'ack' }),
  fc.constant<Command>({ k: 'staleAck' }),
  fc.boolean().map((applied): Command => ({ k: 'syncStatus', applied })),
  fc.integer({ min: 0, max: 4 }).map((n): Command => ({ k: 'unsynced', n })),
  fc
    .constantFrom(...PERSIST_FAILED_REASONS)
    .map((reason): Command => ({ k: 'persistFailed', reason })),
  fc.constant<Command>({ k: 'projected' }),
  fc.constantFrom(...ROLES).map((role): Command => ({ k: 'role', role })),
  fc
    .constantFrom<SaveStateInput['socket'][]>('connecting', 'connected', 'disconnected')
    .map((socket): Command => ({ k: 'status', socket })),
  fc.constant<Command>({ k: 'open' }),
  fc.constant<Command>({ k: 'authenticated' }),
  fc.constant<Command>({ k: 'synced' }),
  fc.constant<Command>({ k: 'baselineSent' }),
  fc.integer({ min: 0, max: 20_000 }).map((advanceMs): Command => ({ k: 'tick', advanceMs })),
);

/** Every close reason, both ways one can arrive (09-api-reference.md section 3.9, D05-25). */
const closeCommand: fc.Arbitrary<Command> = fc
  .tuple(
    fc.constantFrom(
      'unauthorized',
      'revoked',
      'note-not-found',
      'note-trashed',
      'note-closing',
      'vault-archived',
      'too-large',
      'rate-limited',
      'capacity',
      'awareness-spoof',
      'protocol-error',
      'shutdown',
      'no-owner-lease',
      'unavailable',
    ),
    fc.constantFrom<('close-frame' | 'auth-denied')[]>('close-frame', 'auth-denied'),
  )
  .map(([reason, via]): Command => ({ k: 'close', reason, via }));

/** The whole language, for the properties that must hold of any trace at all. */
const anyCommand: fc.Arbitrary<Command> = fc.oneof(
  quietCommand,
  fc.constant<Command>({ k: 'contentInvalid' }),
  fc.constant<Command>({ k: 'sizeExceeded' }),
  fc.constant<Command>({ k: 'oversizeDelta' }),
  closeCommand,
);

const start: fc.Arbitrary<ModelStart> = fc.record({
  role: fc.constantFrom(...ROLES),
  now: fc.integer({ min: 0, max: 1_000_000 }),
});

const quietTrace = fc.array(quietCommand, { maxLength: 24 });
const anyTrace = fc.array(anyCommand, { maxLength: 24 });

/**
 * The suffix that puts a connected, authenticated, synced, writable session in `saved`: the writer
 * has acknowledged everything the document holds and nothing is outstanding.
 */
const SETTLE: readonly Command[] = [
  { k: 'status', socket: 'connected' },
  { k: 'authenticated' },
  { k: 'synced' },
  { k: 'role', role: 'editor' },
  { k: 'ack' },
  { k: 'unsynced', n: 0 },
];

/** The last snapshot of a folded trace, without a non-null assertion. */
function lastInput(steps: readonly Step[]): SaveStateInput {
  const last = steps.at(-1);
  if (last === undefined) throw new Error('the trace produced no snapshot');
  return last.input;
}

function stateAfter(from: ModelStart, commands: readonly Command[]): SaveState {
  return saveState(lastInput(fold(from, commands)));
}

/** Dominance re-derived here, so the property does not assert `save-state.ts` against itself. */
function acknowledged(input: SaveStateInput): boolean {
  if (input.persisted === null || input.persisted.ds !== input.localDs) return false;
  return dominates(input.persisted.sv as StateVector, input.localSv as StateVector);
}

/**
 * One rule of 05-collaboration-and-durability.md's table, and a suffix that must make that rule the
 * one that matches — whatever the quiet prefix did.
 *
 * This is how "first matching rule wins" is asserted rather than assumed: each suffix leaves several
 * rules' conditions true at once, and only the ordering decides the answer. Rule 5 has two witnesses
 * because its condition is a disjunction, and an implementation that dropped either half would still
 * pass with only the other.
 */
const RULE_WITNESSES: readonly {
  readonly order: number;
  readonly state: SaveState;
  readonly suffix: readonly Command[];
}[] = [
  { order: 1, state: 'revoked', suffix: [{ k: 'close', reason: 'revoked', via: 'close-frame' }] },
  {
    order: 1,
    state: 'revoked',
    suffix: [{ k: 'close', reason: 'awareness-spoof', via: 'close-frame' }],
  },
  {
    order: 1,
    state: 'revoked',
    suffix: [{ k: 'close', reason: 'protocol-error', via: 'close-frame' }],
  },
  {
    order: 2,
    state: 'unauthorized',
    suffix: [{ k: 'close', reason: 'unauthorized', via: 'auth-denied' }],
  },
  { order: 3, state: 'capacity', suffix: [{ k: 'close', reason: 'capacity', via: 'close-frame' }] },
  {
    order: 3,
    state: 'capacity',
    suffix: [{ k: 'close', reason: 'no-owner-lease', via: 'close-frame' }],
  },
  {
    order: 4,
    state: 'vault-archived',
    suffix: [{ k: 'close', reason: 'vault-archived', via: 'close-frame' }],
  },
  {
    order: 5,
    state: 'too-large',
    suffix: [{ k: 'close', reason: 'too-large', via: 'close-frame' }],
  },
  { order: 5, state: 'too-large', suffix: [{ k: 'oversizeDelta' }] },
  {
    order: 6,
    state: 'trashed',
    suffix: [{ k: 'close', reason: 'note-trashed', via: 'close-frame' }],
  },
  { order: 7, state: 'closed', suffix: [{ k: 'close', reason: 'shutdown', via: 'close-frame' }] },
  {
    order: 7,
    state: 'closed',
    suffix: [{ k: 'close', reason: 'note-closing', via: 'close-frame' }],
  },
  {
    order: 7,
    state: 'closed',
    suffix: [{ k: 'close', reason: 'note-not-found', via: 'close-frame' }],
  },
  {
    order: 7,
    state: 'closed',
    suffix: [{ k: 'close', reason: 'rate-limited', via: 'auth-denied' }],
  },
  { order: 8, state: 'disconnected', suffix: [{ k: 'status', socket: 'disconnected' }] },
  {
    order: 8,
    state: 'disconnected',
    suffix: [{ k: 'close', reason: 'unavailable', via: 'auth-denied' }],
  },
  {
    order: 9,
    state: 'connecting',
    suffix: [{ k: 'status', socket: 'connected' }, { k: 'open' }],
  },
  {
    order: 10,
    state: 'rejected',
    suffix: [
      { k: 'status', socket: 'connected' },
      { k: 'authenticated' },
      { k: 'synced' },
      { k: 'role', role: 'viewer' },
      { k: 'unsynced', n: 2 },
    ],
  },
  {
    order: 11,
    state: 'read-only',
    suffix: [
      { k: 'status', socket: 'connected' },
      { k: 'authenticated' },
      { k: 'synced' },
      { k: 'role', role: 'viewer' },
      { k: 'unsynced', n: 0 },
    ],
  },
  {
    order: 11,
    state: 'read-only',
    suffix: [
      { k: 'status', socket: 'connected' },
      { k: 'authenticated' },
      { k: 'synced' },
      { k: 'role', role: 'editor' },
      { k: 'unsynced', n: 0 },
      { k: 'contentInvalid' },
    ],
  },
  {
    order: 11,
    state: 'read-only',
    suffix: [
      { k: 'status', socket: 'connected' },
      { k: 'authenticated' },
      { k: 'synced' },
      { k: 'role', role: 'editor' },
      { k: 'unsynced', n: 0 },
      { k: 'sizeExceeded' },
    ],
  },
  {
    order: 12,
    state: 'save-failed',
    suffix: [
      { k: 'status', socket: 'connected' },
      { k: 'authenticated' },
      { k: 'synced' },
      { k: 'role', role: 'editor' },
      { k: 'unsynced', n: 0 },
      { k: 'persistFailed', reason: 'db_unavailable' },
    ],
  },
  {
    order: 12,
    state: 'save-failed',
    suffix: [
      ...SETTLE,
      { k: 'localEdit', client: 11 },
      { k: 'unsynced', n: 0 },
      { k: 'tick', advanceMs: DOMINANCE_DEADLINE_MS + 1 },
    ],
  },
  {
    order: 13,
    state: 'syncing',
    suffix: [...SETTLE, { k: 'localEdit', client: 22 }, { k: 'unsynced', n: 0 }],
  },
  { order: 14, state: 'saved', suffix: SETTLE },
];

// ---- the properties ----------------------------------------------------------------------------

describe('save-state.machine.prop [hp:HP-1]', () => {
  it.prop(
    [fc.array(fc.tuple(clientId, fc.integer({ min: 0, max: 5_000 })), { maxLength: 3 })],
    PROP,
  )('the model encodes the state vectors @iridium/crdt decodes', (pairs) => {
    const clocks = new Map(pairs);
    expect(decodeStateVector(encodeSv(clocks) as StateVector)).toEqual(clocks);
  });

  it.prop([start, anyTrace], PROP)(
    'saved implies an acknowledgement that contains every local edit',
    (from, commands) => {
      for (const step of fold(from, commands)) {
        if (saveState(step.input) !== 'saved') continue;
        expect(acknowledged(step.input)).toBe(true);
        expect(step.input.unsynced).toBe(0);
        expect(step.input.socket).toBe('connected');
        expect(step.input.synced).toBe(true);
        expect(step.input.authenticated).toBe(true);
        expect(step.input.closeReason).toBeNull();
        expect(step.input.persistFailed).toBeNull();
      }
    },
  );

  it.prop([start, quietTrace], PROP)(
    'a connected, synced, acknowledged session reaches saved with no further input',
    (from, prefix) => {
      expect(stateAfter(from, [...prefix, ...SETTLE])).toBe('saved');
    },
  );

  it.prop([start, quietTrace, clientId], PROP)(
    'a local edit leaves saved at once and returns to it only on a dominating acknowledgement',
    (from, prefix, client) => {
      const edited: readonly Command[] = [
        ...prefix,
        ...SETTLE,
        { k: 'localEdit', client },
        { k: 'unsynced', n: 0 },
      ];
      expect(stateAfter(from, edited)).toBe('syncing');
      expect(stateAfter(from, [...edited, { k: 'ack' }])).toBe('saved');
    },
  );

  it.prop([start, quietTrace, fc.constantFrom('localDelete', 'remoteDelete')], PROP)(
    'a real deletion leaves saved even when all struct clocks and transport acknowledgements are unchanged',
    (from, prefix, kind) => {
      const pending: readonly Command[] = [
        ...prefix,
        ...SETTLE,
        { k: kind },
        { k: 'unsynced', n: 0 },
      ];
      const trace = fold(from, pending);
      const last = lastInput(trace);
      expect(last.persisted?.sv).toEqual(last.localSv);
      expect(last.persisted?.ds).not.toBe(last.localDs);
      // Remote edits retain the last local edit's deadline, including an expired one.
      const expected =
        last.lastLocalEditAt !== null && last.now - last.lastLocalEditAt > DOMINANCE_DEADLINE_MS
          ? 'save-failed'
          : 'syncing';
      expect(saveState(last)).toBe(expected);
      expect(warnsBeforeUnload(last)).toBe(true);
      expect(stateAfter(from, [...pending, { k: 'staleAck' }])).toBe(expected);
      expect(stateAfter(from, [...pending, { k: 'ack' }])).toBe('saved');
    },
  );

  it.prop([start, quietTrace], PROP)(
    'the dominance deadline is driven by tick and by nothing else',
    (from, prefix) => {
      const edited: readonly Command[] = [
        ...prefix,
        ...SETTLE,
        { k: 'localEdit', client: 11 },
        { k: 'unsynced', n: 0 },
      ];
      expect(stateAfter(from, edited)).toBe('syncing');
      expect(stateAfter(from, [...edited, { k: 'tick', advanceMs: DOMINANCE_DEADLINE_MS }])).toBe(
        'syncing',
      );
      expect(
        stateAfter(from, [...edited, { k: 'tick', advanceMs: DOMINANCE_DEADLINE_MS + 1 }]),
      ).toBe('save-failed');
    },
  );

  it.prop([start, anyTrace], PROP)(
    'a standing persist-failed is never reported as saved or as merely syncing',
    (from, commands) => {
      for (const step of fold(from, commands)) {
        if (step.input.persistFailed === null) continue;
        const state = saveState(step.input);
        expect(state).not.toBe('saved');
        expect(state).not.toBe('syncing');
        expect(matchSaveStateRule(step.input).order).toBeLessThanOrEqual(12);
      }
    },
  );

  it.prop([start, quietTrace], PROP)(
    'a newer acknowledgement is what clears a persist-failed',
    (from, prefix) => {
      const failed: readonly Command[] = [
        ...prefix,
        ...SETTLE,
        { k: 'persistFailed', reason: 'db_error' },
      ];
      expect(stateAfter(from, failed)).toBe('save-failed');
      expect(stateAfter(from, [...failed, { k: 'projected' }])).toBe('save-failed');
      expect(stateAfter(from, [...failed, { k: 'staleAck' }])).toBe('save-failed');
      expect(stateAfter(from, [...failed, { k: 'ack' }])).toBe('saved');
    },
  );

  it.prop([start, anyTrace], PROP)(
    'the before-unload warning is exactly unacknowledged work, in every state',
    (from, commands) => {
      for (const step of fold(from, commands)) {
        expect(warnsBeforeUnload(step.input)).toBe(
          step.input.unsynced > 0 || !acknowledged(step.input),
        );
      }
    },
  );

  it.prop([start, quietTrace], PROP)(
    'a viewer whose write was refused reports rejected, and an upgrade alone does not report saved',
    (from, prefix) => {
      const refused: readonly Command[] = [
        ...prefix,
        { k: 'status', socket: 'connected' },
        { k: 'authenticated' },
        { k: 'synced' },
        { k: 'role', role: 'viewer' },
        { k: 'localEdit', client: 33 },
        { k: 'unsynced', n: 1 },
      ];
      expect(stateAfter(from, refused)).toBe('rejected');
      const upgraded: readonly Command[] = [...refused, { k: 'role', role: 'editor' }];
      expect(stateAfter(from, upgraded)).not.toBe('saved');
      expect(stateAfter(from, [...upgraded, { k: 'unsynced', n: 0 }, { k: 'ack' }])).toBe('saved');
    },
  );

  it.prop([start, quietTrace, quietTrace], PROP)(
    'a close is terminal for the session: no later input changes the state it produced',
    (from, prefix, suffix) => {
      for (const witness of RULE_WITNESSES) {
        const closing = witness.suffix.filter((command) => command.k === 'close');
        if (closing.length === 0) continue;
        const closed = [...prefix, ...witness.suffix];
        expect(stateAfter(from, closed)).toBe(witness.state);
        expect(stateAfter(from, [...closed, ...suffix])).toBe(witness.state);
      }
    },
  );

  it.prop([start, quietTrace, fc.constantFrom(...RULE_WITNESSES)], PROP)(
    'every rule of the table is reachable and wins over the rules below it',
    (from, prefix, witness) => {
      const input = lastInput(fold(from, [...prefix, ...witness.suffix]));
      expect(matchSaveStateRule(input)).toEqual({ order: witness.order, state: witness.state });
    },
  );

  it.prop([start, anyTrace], PROP)(
    'durability is monotone: an acknowledgement never moves backwards',
    (from, commands) => {
      let highest = -1;
      for (const step of fold(from, commands)) {
        const seq = step.input.persisted?.seq ?? -1;
        expect(seq).toBeGreaterThanOrEqual(highest);
        highest = seq;
      }
    },
  );

  it.prop([start, quietTrace], PROP)('a projected never unsettles saved', (from, prefix) => {
    const settled = [...prefix, ...SETTLE];
    expect(stateAfter(from, settled)).toBe('saved');
    expect(stateAfter(from, [...settled, { k: 'projected' }])).toBe('saved');
    expect(stateAfter(from, [...settled, { k: 'projected' }, { k: 'projected' }])).toBe('saved');
  });

  it.prop([start, anyTrace], PROP)('saveState is total over every snapshot', (from, commands) => {
    const states: readonly SaveState[] = SAVE_STATES;
    for (const step of fold(from, commands)) {
      expect(states).toContain(saveState(step.input));
    }
  });
});
