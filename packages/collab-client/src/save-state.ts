/**
 * `SaveStateMachine` — the client half of the Saved protocol
 * (05-collaboration-and-durability.md, *Client state machine*; 09-api-reference.md section 3.9).
 *
 * The module owns two pure functions and nothing else:
 *
 * - `saveState(input)` is **memoryless**. It is an ordered rule list where the first matching rule
 *   wins, evaluated over one `SaveStateInput` snapshot. It holds no state, starts no timer and
 *   touches no `Y.Doc`, which is what makes every claim about it checkable by folding a generated
 *   event sequence and asserting over the resulting states (`save-state.machine.prop`).
 * - `reduceSaveInput(previous, event)` is the accumulator that turns provider events and stateless
 *   messages into successive snapshots. `now` reaches it only through a `tick` event, so the 15 s
 *   dominance deadline of rule 12 is driven by the caller's clock and no timer lives here
 *   (05-collaboration-and-durability.md D05-26).
 *
 * `SaveStateInput` and `StateVector` are `@iridium/contracts`' (09-api-reference.md section 3.9 owns
 * the field set, and `contracts.collab.unit` asserts the mapping is exhaustive over it); the rules
 * over those inputs, their order and the `SaveState` union they produce live here and nowhere else.
 *
 * What the module deliberately does **not** do: decide whether to re-attach, when to re-request a
 * baseline, or how long to back off. Those are actions with a lifetime, so they belong to
 * `NoteSession` and `NoteSessionRegistry`, which own a clock; a rule table that could also start a
 * retry would stop being a function of its input.
 */

import type {
  CollabCloseReason,
  CollabCloseVia,
  PersistFailedReason,
  Role,
  SaveStateInput,
  StateVector,
} from '@iridium/contracts';
import { dominates, type StateVector as CrdtStateVector } from '@iridium/crdt';

// ---------------------------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------------------------

/**
 * Every value the indicator can take, in the order 05-collaboration-and-durability.md declares them.
 * `status-pill.transitions.component` (M4) renders exactly these and adds none of its own.
 */
export const SAVE_STATES = [
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
] as const;

/** The client's save state for one note. */
export type SaveState = (typeof SAVE_STATES)[number];

/**
 * The state each close reason produces, as a total map over `CollabCloseReason`.
 *
 * Writing the classification as a `Record` rather than a chain of comparisons is what makes a new
 * close reason a **compile error** until it is classified, which is the property the plan asks for
 * (10-testing-and-quality.md, `save-state.machine.prop` property 8). `unauthorized`, `capacity` and
 * `vault-archived` are their own states rather than presentations of `revoked` because two of them
 * must auto-recover, and folding them into a terminal state would stop the client retrying on every
 * routine ticket expiry (05-collaboration-and-durability.md, *Client state machine*).
 *
 * `no-owner-lease` is classified with `capacity`: the process that answered the upgrade does not
 * hold the schema-scoped collaboration owner lease, and a rolling restart hands the lease over without
 * operator action, so the client retries with backoff exactly as it does for a full admission budget
 * (12-milestones.md section 5.2, `collab/owner-lease.ts`).
 */
const CLOSE_REASON_STATES: Readonly<Record<CollabCloseReason, SaveState>> = {
  revoked: 'revoked',
  'awareness-spoof': 'revoked',
  'protocol-error': 'revoked',
  unauthorized: 'unauthorized',
  capacity: 'capacity',
  unavailable: 'disconnected',
  'no-owner-lease': 'capacity',
  'vault-archived': 'vault-archived',
  'too-large': 'too-large',
  'note-trashed': 'trashed',
  shutdown: 'closed',
  'note-closing': 'closed',
  'note-not-found': 'closed',
  'rate-limited': 'closed',
};

// ---------------------------------------------------------------------------------------------
// Durability across insertion clocks and deleted identities
// ---------------------------------------------------------------------------------------------

/**
 * Does the last acknowledged state contain every local edit?
 *
 * `@iridium/contracts` may not import yjs (13-decision-log.md A14), so `SaveStateInput.localSv` and
 * `persisted.sv` are plain byte arrays, while `@iridium/crdt` brands the same bytes so that a V1
 * update can never be passed where a state vector belongs (A15). This function is the one place in
 * the package where the two spellings of the same bytes meet.
 *
 * The insertion clocks must dominate and deleted identities must match. A deletion can leave
 * every clock unchanged, so neither a null acknowledgement nor a different delete-set fingerprint
 * proves Saved. Exact fingerprint equality is conservative when the server has further deletions.
 */
function persistedDominates(input: SaveStateInput): boolean {
  if (input.persisted === null || input.persisted.ds !== input.localDs) return false;
  // The branding boundary described above: the same bytes, named by the wire contract and by the
  // CRDT package.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return dominates(input.persisted.sv as CrdtStateVector, input.localSv as CrdtStateVector);
}

/**
 * The predicate `beforeunload` (web) and the Electron `close` handler warn on: there is local work
 * the server has not acknowledged.
 *
 * It is deliberately independent of the rule order — a `disconnected` or `save-failed` session with
 * unacknowledged text must warn exactly like a `syncing` one (05-collaboration-and-durability.md,
 * *Client state machine* rule 8 and *Reconnection semantics*).
 */
export function warnsBeforeUnload(input: SaveStateInput): boolean {
  return input.unsynced > 0 || !persistedDominates(input);
}

// ---------------------------------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------------------------------

/**
 * The dominance deadline of rule 12: after this long without an acknowledgement that contains the
 * user's edits, the indicator turns red rather than spinning forever
 * (05-collaboration-and-durability.md, *Client state machine*).
 *
 * Exported because it is a deadline two other modules must agree with rather than restate:
 * `NoteSession` arms the `tick` that makes rule 12 fire at the right moment, and the status pill's
 * tooltip (M4) explains the wait with the same number.
 */
export const DOMINANCE_DEADLINE_MS = 15_000;

/** One rule of the ordered table: its position, the state it produces and when it matches. */
interface SaveStateRuleDefinition {
  readonly order: number;
  readonly state: SaveState;
  readonly when: (input: SaveStateInput) => boolean;
}

/** The rule that produced a state, for the coverage assertion of `save-state.machine.prop`. */
export interface SaveStateRule {
  /** The rule's position in the table of 05-collaboration-and-durability.md, 1-based. */
  readonly order: number;
  readonly state: SaveState;
}

function closedAs(input: SaveStateInput, state: SaveState): boolean {
  return input.closeReason !== null && CLOSE_REASON_STATES[input.closeReason] === state;
}

/**
 * The ordered rule table of 05-collaboration-and-durability.md, *Client state machine* — the single
 * normative definition of the client save state. First match wins; rule 14 always matches.
 */
const SAVE_STATE_RULES: readonly SaveStateRuleDefinition[] = [
  { order: 1, state: 'revoked', when: (i) => closedAs(i, 'revoked') },
  { order: 2, state: 'unauthorized', when: (i) => closedAs(i, 'unauthorized') },
  { order: 3, state: 'capacity', when: (i) => closedAs(i, 'capacity') },
  { order: 4, state: 'vault-archived', when: (i) => closedAs(i, 'vault-archived') },
  // The oversize re-attach delta shares rule 5 with the close: the frame was never sent, and the
  // outcome for the user is the same undeliverable text (05, *Reconnection semantics*, step 0).
  { order: 5, state: 'too-large', when: (i) => closedAs(i, 'too-large') || i.oversizeDelta },
  { order: 6, state: 'trashed', when: (i) => closedAs(i, 'trashed') },
  { order: 7, state: 'closed', when: (i) => closedAs(i, 'closed') },
  {
    order: 8,
    state: 'disconnected',
    when: (i) => closedAs(i, 'disconnected') || i.socket !== 'connected',
  },
  {
    order: 9,
    state: 'connecting',
    when: (i) => i.socket === 'connected' && (!i.authenticated || !i.synced),
  },
  // Rule 10 is the observable form of a refused viewer write: the provider raises no per-update
  // rejection event and does not decrement the count on `SyncStatus(applied=false)`, so a viewer
  // with pending changes is the whole signal (09-api-reference.md section 3.9, D09-24).
  { order: 10, state: 'rejected', when: (i) => i.role === 'viewer' && i.unsynced > 0 },
  {
    order: 11,
    state: 'read-only',
    when: (i) => i.role === 'viewer' || i.contentInvalid || i.oversize,
  },
  {
    order: 12,
    state: 'save-failed',
    when: (i) =>
      i.persistFailed !== null ||
      (!persistedDominates(i) &&
        i.lastLocalEditAt !== null &&
        i.now - i.lastLocalEditAt > DOMINANCE_DEADLINE_MS),
  },
  {
    order: 13,
    state: 'syncing',
    when: (i) => i.unsynced > 0 || i.persisted === null || !persistedDominates(i),
  },
  { order: 14, state: 'saved', when: () => true },
];

/**
 * The rule that matches this snapshot, first match wins.
 *
 * Exported beside `saveState` so that a property file can assert every rule of the table is reachable
 * (10-testing-and-quality.md, `save-state.machine.prop` property 7) without a second copy of the
 * table in the test. Product code reads `saveState`.
 */
export function matchSaveStateRule(input: SaveStateInput): SaveStateRule {
  for (const rule of SAVE_STATE_RULES) {
    if (rule.when(input)) return { order: rule.order, state: rule.state };
  }
  // Unreachable: rule 14 matches every snapshot. Thrown rather than returned as a default so that a
  // table edited into incompleteness fails loudly instead of reporting a plausible `saved`.
  throw new Error(
    'saveState: no rule matched; rule 14 of 05-collaboration-and-durability.md must match every input.',
  );
}

/**
 * The client's save state for one note: a pure function of the snapshot, first matching rule wins.
 *
 * *Saved* requires connected, synced, no transport-pending work, full vector dominance and an
 * equal delete-set fingerprint. Provider sync, a Markdown checkpoint or elapsed time alone cannot
 * establish either half of that committed witness
 * (05-collaboration-and-durability.md, *The Saved protocol*; 13-decision-log.md A19).
 */
export function saveState(input: SaveStateInput): SaveState {
  return matchSaveStateRule(input).state;
}

// ---------------------------------------------------------------------------------------------
// The input accumulator
// ---------------------------------------------------------------------------------------------

/**
 * Everything that can move the snapshot forward.
 *
 * The union is 05-collaboration-and-durability.md's, with two additions it needs to be total:
 *
 * - `status` carries the `HocuspocusProviderWebsocket` status that 09-api-reference.md section 3.9
 *   names as the source of `socket`. 05's union spells the socket's reopen (`open`) but no event
 *   that moves `socket` between its three values, so nothing there could fill the field its own
 *   table's rules 8 and 9 read.
 * - `remoteUpdate` carries the vector and deletion witness after a **relayed** update. Both the
 *   whole local vector and deleted identities are checked (05, *Definition*), so a relayed edit
 *   the writer has not committed yet must hold the indicator back; folding it as a `localUpdate`
 *   instead would be wrong twice over, because that event also counts an unsynced change and moves
 *   the `lastLocalEditAt` that rule 12's deadline is measured from.
 */
export type SaveEvent =
  /** The socket opened: this document's handshake starts again from the beginning. */
  | { readonly e: 'open' }
  /** `HocuspocusProviderWebsocket` status (09-api-reference.md section 3.9). */
  | { readonly e: 'status'; readonly socket: SaveStateInput['socket'] }
  /** `Authenticated {scope}` for this document. */
  | { readonly e: 'authenticated' }
  /** The initial `SyncStep1`/`SyncStep2` exchange completed. */
  | { readonly e: 'synced' }
  /** A local edit: the complete witness the server must acknowledge, and when it happened. */
  | {
      readonly e: 'localUpdate';
      readonly localSv: StateVector;
      readonly localDs: string;
      readonly at: number;
    }
  /** A relayed edit from another participant: the complete witness the server must acknowledge. */
  | { readonly e: 'remoteUpdate'; readonly localSv: StateVector; readonly localDs: string }
  /** `SyncStatus(applied)`; `false` deliberately changes nothing (D09-24). */
  | { readonly e: 'syncStatus'; readonly applied: boolean }
  /** `provider.unsyncedChanges` — the authoritative count. */
  | { readonly e: 'unsyncedChanges'; readonly n: number }
  /** The one and only Saved signal. */
  | { readonly e: 'persisted'; readonly seq: number; readonly sv: StateVector; readonly ds: string }
  /** A writer transaction did not commit. */
  | {
      readonly e: 'persistFailed';
      readonly seq?: number;
      readonly reason: PersistFailedReason;
      readonly at: number;
    }
  /** The committed Markdown projection reached this seq. */
  | { readonly e: 'projected'; readonly seq: number }
  /** The caller's effective role on this document changed. */
  | { readonly e: 'role'; readonly role: Role }
  /** The compaction scan found a carriage return or formatting attributes. */
  | { readonly e: 'contentInvalid' }
  /** The note crossed the soft size cap at compaction. */
  | { readonly e: 'sizeExceeded' }
  /** The re-attach delta was measured above `YJS_UPDATE_MAX_BYTES` and was never sent. */
  | { readonly e: 'oversizeDelta' }
  /** A per-document close, and how the refusal arrived. */
  | {
      readonly e: 'close';
      readonly reason: CollabCloseReason;
      readonly via: NonNullable<CollabCloseVia>;
    }
  /** A `baseline` request left the client. */
  | { readonly e: 'baselineSent' }
  /** The only source of `now`. */
  | { readonly e: 'tick'; readonly now: number };

/** What a fresh snapshot needs that has no zero value. */
export interface InitialSaveInput {
  /** The role the connection was authorized with; `Authenticated {scope}` seeds it. */
  readonly role: Role;
  /** `Y.encodeStateVector(ydoc)` at the moment the session was created. */
  readonly localSv: StateVector;
  /** Canonical delete-set fingerprint at the same capture point as localSv. */
  readonly localDs: string;
  /** The clock reading the session starts from. */
  readonly now: number;
}

/**
 * The snapshot a session starts from, and the one it re-seeds with when it re-attaches a fresh
 * provider after a transient close.
 *
 * Re-attachment is a new snapshot rather than a `SaveEvent` because `reduceSaveInput` never clears
 * `closeReason` — that is where "terminal" actually lives (10-testing-and-quality.md,
 * `save-state.machine.prop` property 6), and an event that could clear it would make `too-large`
 * and `revoked` recoverable by folding one more event. The session re-attaches only for the reasons
 * `close-policy.ts` marks as transient, so the reset can never resurrect a terminal document.
 */
export function initialSaveInput(options: InitialSaveInput): SaveStateInput {
  return {
    socket: 'connecting',
    authenticated: false,
    synced: false,
    unsynced: 0,
    localSv: options.localSv,
    localDs: options.localDs,
    persisted: null,
    persistFailed: null,
    projectedSeq: null,
    role: options.role,
    contentInvalid: false,
    oversize: false,
    oversizeDelta: false,
    closeReason: null,
    closeVia: null,
    lastLocalEditAt: null,
    now: options.now,
  };
}

/**
 * Fold one event into the next snapshot. Pure and total: every member of `SaveEvent` is handled, and
 * the two that deliberately change nothing say so rather than falling through a default.
 */
export function reduceSaveInput(previous: SaveStateInput, event: SaveEvent): SaveStateInput {
  switch (event.e) {
    case 'open':
      // `authenticated` is "seen since the last open" and the provider clears `synced` on close, so
      // a reopened socket re-runs this document's handshake before anything is claimed about it.
      return { ...previous, authenticated: false, synced: false };
    case 'status':
      return { ...previous, socket: event.socket };
    case 'authenticated':
      return { ...previous, authenticated: true };
    case 'synced':
      return { ...previous, synced: true };
    case 'localUpdate':
      // The count is incremented here and corrected absolutely by the provider's own
      // `unsyncedChanges` event; the provider is the authority, this keeps the snapshot truthful in
      // the window between the document update and that event.
      return {
        ...previous,
        localSv: event.localSv,
        localDs: event.localDs,
        lastLocalEditAt: event.at,
        unsynced: previous.unsynced + 1,
      };
    case 'remoteUpdate':
      // Only the vector moves: a relayed edit is not the caller's unsaved work, so it neither
      // counts as an unsynced change nor restarts rule 12's deadline — but it does have to reach
      // `localSv`, or the next dominance check would be run against a vector the document no
      // longer has (05-collaboration-and-durability.md, *Definition*).
      return { ...previous, localSv: event.localSv, localDs: event.localDs };
    case 'syncStatus':
      // `MessageReceiver.applySyncStatusMessage` decrements only on `applied === true`; a refused
      // write raises no event at all, which is why rule 10 keys on the role plus a non-zero count
      // rather than on a rejection the provider never reports (D09-24).
      return event.applied
        ? { ...previous, unsynced: Math.max(0, previous.unsynced - 1) }
        : previous;
    case 'unsyncedChanges':
      return { ...previous, unsynced: event.n };
    case 'persisted':
      return acknowledge(previous, event.seq, event.sv, event.ds);
    case 'persistFailed':
      return {
        ...previous,
        persistFailed: {
          ...(event.seq === undefined ? {} : { seq: event.seq }),
          reason: event.reason,
          at: event.at,
        },
      };
    case 'projected':
      // A `projected` never unsettles `saved`: it fills its own field and touches nothing the rules
      // above rule 14 read, which is what makes the over-budget `flush` answer safe (05, *Forcing
      // currency*).
      return { ...previous, projectedSeq: event.seq };
    case 'role':
      return { ...previous, role: event.role };
    case 'contentInvalid':
      return { ...previous, contentInvalid: true };
    case 'sizeExceeded':
      return { ...previous, oversize: true };
    case 'oversizeDelta':
      return { ...previous, oversizeDelta: true };
    case 'close':
      // Never cleared, whatever arrives later: a terminal close is terminal because no fold can
      // undo it (property 6). A re-attach is a fresh snapshot, not an event.
      return { ...previous, closeReason: event.reason, closeVia: event.via };
    case 'baselineSent':
      // Deliberately no field: 09-api-reference.md section 3.9's input set has none for it, and the
      // "one request, then back to waiting" rule of D05-05 is an action with a lifetime, so
      // `NoteSession` owns it. The member stays in the union because a caller folds a complete
      // trace of what it did, and a hole in the union would make that trace unrepresentable.
      return previous;
    case 'tick':
      return { ...previous, now: event.now };
    default: {
      // Unreachable while the union is handled: the binding is the `never` check the plan asks for
      // (10-testing-and-quality.md, `save-state.machine.prop` property 8), so a new `SaveEvent`
      // member does not compile until this function decides what it does to the snapshot.
      const unhandled: never = event;
      throw new Error(`reduceSaveInput: unhandled save event ${JSON.stringify(unhandled)}.`);
    }
  }
}

/**
 * Apply a `persisted {seq, sv}`.
 *
 * An older acknowledgement arriving out of order is ignored by `seq` comparison, so the machine can
 * never claim less durability than it has already seen (10-testing-and-quality.md,
 * `save-state.machine.prop`, *monotone recovery*). A newer one clears `persistFailed`: that is the
 * memoryless encoding of rule 12's "a `persist-failed` newer than the last `persisted`" — the field
 * set carries no timestamp on `persisted`, so "newer" is exactly "not yet superseded".
 */
function acknowledge(
  previous: SaveStateInput,
  seq: number,
  sv: StateVector,
  ds: string,
): SaveStateInput {
  if (previous.persisted !== null && previous.persisted.seq > seq) return previous;
  return { ...previous, persisted: { seq, sv, ds }, persistFailed: null };
}
