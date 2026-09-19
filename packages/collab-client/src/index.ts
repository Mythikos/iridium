/**
 * `@iridium/collab-client` — the client half of `/collab`.
 *
 * The package is isomorphic (02-system-architecture.md, boundary tag `iso`): it runs in a browser,
 * in the Electron renderer and in Node, so it imports no `node:*` module, touches no DOM global and
 * reaches yjs only through `@iridium/crdt` (13-decision-log.md A14). A host supplies the two things
 * that differ between them — a `WebSocket` implementation and a clock — and nothing else.
 *
 * What it owns, and where each part is specified:
 *
 * - `SaveStateMachine` (`save-state.ts`): the memoryless rule table of
 *   05-collaboration-and-durability.md, *Client state machine*, plus the pure accumulator that turns
 *   provider events and stateless messages into its input snapshots. This is the single definition
 *   of what "Saved" means on a client, and it is property-tested as such (HP-1).
 * - `NoteSession` and `NoteSessionRegistry`: one document, one provider, one save state per open
 *   note, and one session per note per window (07-client-applications.md section 5.2, A41).
 * - The stateless codec's client side (`messages.ts`), the close policy (`close-policy.ts`), the
 *   ticket getter (`tickets.ts`) and the socket configuration (`socket.ts`).
 *
 * The wire schemas themselves are `@iridium/contracts`' and are re-exported by nobody: a consumer
 * that needs `PersistedMsg` or `CollabCloseReason` imports the contract. The same rule holds for the
 * yjs instance types a consumer of `session.ydoc`, `session.ytext` and `session.undoManager` needs:
 * `NoteDoc`, `NoteText` and `NoteUndoManager` are `@iridium/crdt`'s, which is the one package that
 * may name them (A14).
 */

export { base64ToBytes } from './base64.ts';
export { type CollabClock, type CollabTimer, reattachDelayMs, systemCollabClock } from './clock.ts';
export { type ClosePolicy, closePolicy } from './close-policy.ts';
export {
  baselinePayload,
  flushPayload,
  receiveNoteStateless,
  type StatelessIntake,
} from './messages.ts';
export {
  type CollabLog,
  type NoteParticipant,
  type NoteSelection,
  NoteSession,
  type NoteSessionOptions,
  type NoteSnapshot,
} from './note-session.ts';
export { NoteSessionRegistry, type NoteSessionRegistryOptions } from './registry.ts';
export {
  DOMINANCE_DEADLINE_MS,
  type InitialSaveInput,
  initialSaveInput,
  matchSaveStateRule,
  reduceSaveInput,
  SAVE_STATES,
  type SaveEvent,
  type SaveState,
  saveState,
  type SaveStateRule,
  warnsBeforeUnload,
} from './save-state.ts';
export { type CollabSocketOptions, createCollabSocket } from './socket.ts';
export {
  CollabTicketError,
  createTicketGetter,
  isRetryableTicketFailure,
  type TicketGetterOptions,
  type TicketSource,
} from './tickets.ts';
