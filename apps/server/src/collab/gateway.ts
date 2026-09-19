import type { Connection, Document } from '@hocuspocus/server';
/**
 * `CollabGateway` — the only module allowed to touch live connections
 * (04-auth-and-access-control.md §8.4; 05-collaboration-and-durability.md, "The interfaces that
 * confine Hocuspocus", "`participants`: server-authoritative identity", "Role change on a live
 * connection"; 09-api-reference.md §3.6).
 *
 * REST services call it **after COMMIT**, never inside a transaction, and the `AuthzBus` delivers the
 * post-commit events of 04 §8.3 to `handle()`, which lands between the epoch reconciler and the ticket
 * store in subscription order. Every sweep is a bounded iteration over `hocuspocus.documents` and each
 * document's connections; a document's vault comes from the gateway's own name → vault index
 * (maintained by `afterLoadDocument` / `afterUnloadDocument`), so a sweep never queries the database.
 *
 * The participant table is built from `connection.context` — from what `onAuthenticate` proved —
 * and never from awareness; names and colours come from `users`, read once per connection at
 * `connected`. Multiple connections of one user collapse into one entry.
 */
import {
  encodeStateless,
  noteDocName,
  parseDocName,
  type AuthzEpoch,
  type NoteId,
  type Permission,
  type Principal,
  type Role,
  type ServerNoteMessage,
  type ServerVaultMessage,
  type SessionId,
  type UserId,
  type VaultId,
} from '@iridium/contracts';
import { getContent, insertChunked, type NoteDoc } from '@iridium/crdt';

import type { Authorizer } from '../authz/authorize.ts';
import type { AuthzEvent } from '../authz/bus.ts';
import { ClosingSet } from '../notes/lifecycle.ts';
import type { Clock } from '../ops/clock.ts';
import { ProblemError } from '../security/problem.ts';
import { authenticated, type AuthenticatedContext, type CollabHookContext } from './context.ts';
import type { CollabReads, ParticipantIdentity } from './hooks/resolution.ts';

export type { ParticipantIdentity };
import type { OwnerFence } from './owner-lease.ts';
import { CollabRejection, closeEventFor } from './rejection.ts';

/** How long a client has to copy unsent text out before a server-initiated close (D05-12). */
export const CLOSING_GRACE_MS = 2_000;

/** One entry of the `participants` message (05, "`participants`"). */
export interface Participant {
  readonly id: UserId;
  readonly name: string;
  readonly colorHue: number;
  readonly role: Role;
  readonly sessionId: SessionId;
  readonly mode?: 'source' | 'reading' | 'split';
  /** Live document connections of this user, for `GET /notes/:noteId/participants` (09 §2.8). */
  readonly connections: number;
  /** When the user first joined this document, epoch ms; kept across reconnects while connected. */
  readonly since: number;
}

/** The `participants` schema caps the list; the most recently active entries are kept. */
const PARTICIPANTS_MESSAGE_ENTRIES = 64;

/** What `openServerEdit` takes (04 §6.9). */
export interface ServerEditContext {
  readonly principal: Principal;
  readonly permission: Permission;
  readonly reason: 'restore' | 'import' | 'repair';
  readonly revisionId?: number;
}

/** A server-originated edit on a loaded document, over a `DirectConnection`. */
export interface ServerEdit {
  readonly document: NoteDoc;
  /** Emits independently bounded updates under the captured owner and trusted edit origin. */
  insertChunked(index: number, text: string): void;
  transact(fn: (document: NoteDoc) => void): Promise<void>;
  disconnect(): Promise<void>;
}

/** What `Hocuspocus.openDirectConnection` resolves to, as far as the gateway reads it. */
export interface DirectConnectionLike {
  readonly document: Document | null;
  transact(transaction: (document: Document) => void): Promise<void>;
  disconnect(): Promise<void>;
}

interface OwnedDirectConnection extends DirectConnectionLike {
  insertChunked(index: number, text: string): void;
}

/**
 * The two members of the Hocuspocus instance the gateway touches. The instance satisfies it
 * structurally; a unit suite hands it a map, which is what keeps `new Hocuspocus(` at its one site.
 */
export interface GatewayServer {
  readonly documents: Map<string, Document>;
  openDirectConnection(
    documentName: string,
    context?: CollabHookContext,
  ): Promise<DirectConnectionLike>;
}

/** The logging methods the gateway uses. */
export interface GatewayLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** What the gateway needs. */
export interface GatewayOptions {
  readonly clock: Clock;
  readonly logger: GatewayLogger;
  readonly authorize: Authorizer['authorize'];
  /** `dbApp`, for the note → vault resolution of `openServerEdit`. */
  /** The note → vault resolution of `openServerEdit`. */
  readonly reads: Pick<CollabReads, 'resolveNote'>;
  /** Compose ACL writability with the loaded note writer’s independent safety latches. */
  readonly applyWriterLatches: (connection: Connection<CollabHookContext>) => void;
  /** An in-memory command barrier, composed at the native synchronous readOnly apply boundary. */
  readonly principalBlocked?: (userId: UserId) => boolean;
  /** Captured before resolving a direct edit, and checked at its immediate Yjs apply boundary. */
  readonly captureOwner?: () => OwnerFence;
}

/** One user's entry in a document's table: mutable bookkeeping behind the readonly `Participant`. */
interface ParticipantEntry {
  readonly id: UserId;
  readonly name: string;
  readonly colorHue: number;
  role: Role;
  readonly sessionId: SessionId;
  mode: Participant['mode'];
  lastActiveAt: number;
  connections: number;
  readonly joinedAt: number;
}

interface DocumentParticipants {
  readonly entries: Map<UserId, ParticipantEntry>;
}

/** The readonly view of an entry; `mode` is present only when a connection reported one. */
function toParticipant(entry: ParticipantEntry): Participant {
  const { id, name, colorHue, role, sessionId, connections } = entry;
  const since = entry.joinedAt;
  return entry.mode === undefined
    ? { id, name, colorHue, role, sessionId, connections, since }
    : { id, name, colorHue, role, sessionId, connections, since, mode: entry.mode };
}

/** One `participants.users[]` entry: the participant without its session (05, "`participants`"). */
function toWireParticipant(participant: Participant): {
  readonly id: UserId;
  readonly name: string;
  readonly colorHue: number;
  readonly role: Role;
  readonly mode?: Participant['mode'];
} {
  const { id, name, colorHue, role } = participant;
  return participant.mode === undefined
    ? { id, name, colorHue, role }
    : { id, name, colorHue, role, mode: participant.mode };
}

/** The gateway. One per process; `bind` attaches the Hocuspocus instance once it exists. */
export class CollabGateway {
  readonly #options: GatewayOptions;
  readonly #closing = new ClosingSet();
  readonly #vaultOf = new Map<string, VaultId>();
  readonly #participants = new Map<string, DocumentParticipants>();
  #server: GatewayServer | null = null;
  #reauthorize: ((connection: Connection<CollabHookContext>) => Promise<void>) | null = null;

  constructor(options: GatewayOptions) {
    this.#options = options;
  }

  /** Attaches the instance. Called once by the collab plugin after `new Hocuspocus(`. */
  bind(server: GatewayServer): void {
    this.#server = server;
  }

  /** Auth owns the per-connection session check; recovery must never substitute a sibling epoch. */
  bindReauthorization(handler: (connection: Connection<CollabHookContext>) => Promise<void>): void {
    this.#reauthorize = handler;
  }

  /** Joins every actual connection in scope before a mutation barrier may be released. */
  async revalidateUser(userId: UserId | null): Promise<void> {
    const reauthorize = this.#reauthorize;
    if (reauthorize === null) throw new Error('collaboration reauthorization is not bound');
    const connections = [...this.#documents().values()].flatMap((document) =>
      this.#connectionsOf(document).filter(
        (connection) => userId === null || connection.context.userId === userId,
      ),
    );
    const outcomes = await Promise.allSettled(
      connections.map((connection) => reauthorize(connection)),
    );
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'connection reauthorization failed',
      );
    }
  }

  #documents(): Map<string, Document> {
    return this.#server?.documents ?? new Map<string, Document>();
  }

  // ---- the closing set -----------------------------------------------------------------------

  markClosing(noteId: NoteId): void {
    this.#closing.mark(noteId);
  }

  isClosing(noteId: NoteId): boolean {
    return this.#closing.has(noteId);
  }

  clearClosing(noteId: NoteId): void {
    this.#closing.clear(noteId);
  }

  // ---- the document → vault index ------------------------------------------------------------

  /** `afterLoadDocument`: records the vault a document belongs to. */
  registerDocument(documentName: string, vaultId: VaultId): void {
    this.#vaultOf.set(documentName, vaultId);
  }

  /** `afterUnloadDocument`: drops the index entry and the participant table. */
  forgetDocument(documentName: string): void {
    this.#vaultOf.delete(documentName);
    this.#participants.delete(documentName);
  }

  /** The vault of a loaded document, from the index — never from a database lookup. */
  vaultOf(documentName: string): VaultId | undefined {
    return this.#vaultOf.get(documentName);
  }

  // ---- participants ------------------------------------------------------------------------------

  /** `connected`: adds the connection's user and broadcasts the list. */
  join(document: Document, context: AuthenticatedContext, identity: ParticipantIdentity): void {
    const table = this.#tableOf(document.name);
    const existing = table.entries.get(context.userId);
    const now = this.#options.clock.now();
    if (existing === undefined) {
      table.entries.set(context.userId, {
        id: context.userId,
        name: identity.name,
        colorHue: identity.colorHue,
        role: context.role,
        sessionId: context.sessionId,
        mode: undefined,
        lastActiveAt: now,
        connections: 1,
        joinedAt: now,
      });
    } else {
      existing.connections += 1;
      existing.lastActiveAt = now;
      existing.role = context.role;
    }
    this.broadcastParticipants(document);
  }

  /** `onDisconnect`: removes the connection and broadcasts the list. */
  leave(document: Document, context: AuthenticatedContext): void {
    const table = this.#participants.get(document.name);
    if (table === undefined) return;
    const entry = table.entries.get(context.userId);
    if (entry === undefined) return;
    entry.connections -= 1;
    if (entry.connections <= 0) table.entries.delete(context.userId);
    this.broadcastParticipants(document);
  }

  /** `beforeHandleAwareness`: the most recently active connection's `mode`. */
  setMode(documentName: string, userId: UserId, mode: Participant['mode']): void {
    const entry = this.#participants.get(documentName)?.entries.get(userId);
    if (entry === undefined) return;
    entry.lastActiveAt = this.#options.clock.now();
    if (mode !== undefined) entry.mode = mode;
  }

  /** The participant list of a loaded note, most recently active first, capped at the schema's size. */
  participants(noteId: NoteId): readonly Participant[] {
    return this.participantsOf(noteDocName(noteId));
  }

  /** The same, by document name. */
  participantsOf(documentName: string): readonly Participant[] {
    const table = this.#participants.get(documentName);
    if (table === undefined) return [];
    return [...table.entries.values()]
      .toSorted((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, PARTICIPANTS_MESSAGE_ENTRIES)
      .map((entry) => toParticipant(entry));
  }

  /** Broadcasts `{t:'participants'}` to every connection of a note document. */
  broadcastParticipants(document: Document): void {
    if (parseDocName(document.name)?.channel !== 'note') return;
    const users = this.participantsOf(document.name).map((participant) =>
      toWireParticipant(participant),
    );
    document.broadcastStateless(encodeStateless({ v: 1, t: 'participants', users }));
  }

  #tableOf(documentName: string): DocumentParticipants {
    let table = this.#participants.get(documentName);
    if (table === undefined) {
      table = { entries: new Map() };
      this.#participants.set(documentName, table);
    }
    return table;
  }

  // ---- the sweeps --------------------------------------------------------------------------------

  /** Every `note:*` and `vault:*` connection of a user, optionally narrowed to a session or a vault. */
  async revokeUser(
    userId: UserId,
    options: {
      readonly sessionId?: SessionId;
      readonly vaultId?: VaultId;
      readonly exceptSessionId?: SessionId;
      readonly reason?: 'revoked' | 'vault-archived';
    } = {},
  ): Promise<void> {
    const reason = options.reason ?? 'revoked';
    for (const [name, document] of this.#documents()) {
      if (options.vaultId !== undefined && this.#vaultOf.get(name) !== options.vaultId) continue;
      for (const connection of this.#connectionsOf(document)) {
        const context = connection.context;
        if (context.userId !== userId) continue;
        if (options.sessionId !== undefined && context.sessionId !== options.sessionId) continue;
        if (
          options.exceptSessionId !== undefined &&
          context.sessionId === options.exceptSessionId
        ) {
          continue;
        }
        connection.readOnly = true;
        connection.close(closeEventFor(reason));
      }
    }
  }

  /**
   * A role change on live connections: `readOnly` and the context are rewritten and `{t:'role'}` is
   * sent; the connection is never closed, so a downgraded editor keeps the text to export (A40).
   */
  applyReadOnly(connection: Connection<CollabHookContext>, aclReadOnly: boolean): void {
    const userId = connection.context.userId;
    connection.readOnly =
      !connection.document.hasConnection(connection) ||
      aclReadOnly ||
      (userId !== undefined && (this.#options.principalBlocked?.(userId) ?? false));
    this.#options.applyWriterLatches(connection);
  }

  /** Synchronous fence edges; no awaited hook can reset readOnly while the principal is blocked. */
  refreshPrincipalFence(userId: UserId | null): void {
    for (const [name, document] of this.#documents()) {
      const vault = parseDocName(name)?.channel === 'vault';
      for (const connection of this.#connectionsOf(document)) {
        const context = connection.context;
        if (userId !== null && context.userId !== userId) continue;
        this.applyReadOnly(connection, vault || context.role === 'viewer');
        // No recovery marker while a writer's independent content/size/failure latch still applies.
        if (!vault && !connection.readOnly && context.role !== undefined) {
          connection.sendStateless(
            encodeStateless({
              v: 1,
              t: 'role',
              role: context.role,
              recovered: true,
            }),
          );
        }
      }
    }
  }

  async changeRole(userId: UserId, vaultId: VaultId, role: Role, epoch: AuthzEpoch): Promise<void> {
    for (const [name, document] of this.#documents()) {
      if (this.#vaultOf.get(name) !== vaultId) continue;
      const channel = parseDocName(name)?.channel;
      for (const connection of this.#connectionsOf(document)) {
        if (connection.context.userId !== userId) continue;
        const context = connection.context;
        context.role = role;
        context.authzEpoch = epoch;
        this.applyReadOnly(connection, channel === 'vault' || role === 'viewer');
        connection.sendStateless(encodeStateless({ v: 1, t: 'role', role }));
      }
      const entry = this.#participants.get(name)?.entries.get(userId);
      if (entry !== undefined) {
        entry.role = role;
        this.broadcastParticipants(document);
      }
    }
    this.#options.logger.info(
      { event: 'collab.role.changed', userId, vaultId, role },
      'a live role change was applied',
    );
  }

  /** `closing` then close every connection of a note document (trash, or the transient closing set). */
  async closeNote(noteId: NoteId, reason: 'note-trashed' | 'note-closing'): Promise<void> {
    const document = this.#documents().get(noteDocName(noteId));
    if (document === undefined) return;
    if (reason === 'note-trashed') {
      document.broadcastStateless(
        encodeStateless({ v: 1, t: 'closing', reason: 'note-trashed', graceMs: CLOSING_GRACE_MS }),
      );
      await this.#after(CLOSING_GRACE_MS);
    }
    for (const connection of this.#connectionsOf(document)) {
      connection.readOnly = true;
      connection.close(closeEventFor(reason));
    }
  }

  /** `closing {vault-archived, graceMs: 0}` then close every connection in the vault. */
  async archiveVault(vaultId: VaultId): Promise<void> {
    for (const [name, document] of this.#documents()) {
      if (this.#vaultOf.get(name) !== vaultId) continue;
      document.broadcastStateless(
        encodeStateless({ v: 1, t: 'closing', reason: 'vault-archived', graceMs: 0 }),
      );
      for (const connection of this.#connectionsOf(document)) {
        connection.readOnly = true;
        connection.close(closeEventFor('vault-archived'));
      }
    }
  }

  /** `tree-changed`, `member-changed`, `vault-updated` on the vault channel, if it is open. */
  broadcastVault(vaultId: VaultId, message: ServerVaultMessage): void {
    const document = this.#documents().get(`vault:${vaultId}`);
    document?.broadcastStateless(encodeStateless(message));
  }

  /** A server message on a note document, if it is loaded. */
  broadcastNote(noteId: NoteId, message: ServerNoteMessage): void {
    const document = this.#documents().get(noteDocName(noteId));
    document?.broadcastStateless(encodeStateless(message));
  }

  /** Start the bus reaction synchronously; the bus observes and acknowledges its completion. */
  handle(event: AuthzEvent): Promise<void> | void {
    switch (event.type) {
      case 'user.disabled':
        return this.revokeUser(event.userId);
      case 'user.password_changed':
        return this.revokeUser(
          event.userId,
          event.keepSessionId === undefined ? {} : { exceptSessionId: event.keepSessionId },
        );
      case 'session.revoked':
        return this.revokeUser(event.userId, { sessionId: event.sessionId });
      case 'membership.removed':
        return this.revokeUser(event.userId, { vaultId: event.vaultId });
      case 'membership.role_changed':
        return this.changeRole(event.userId, event.vaultId, event.role, {
          userAuthzVersion: event.userAuthzVersion,
          memberVersion: event.memberVersion,
        });
      case 'vault.archived':
        return this.archiveVault(event.vaultId);
      case 'note.trashed':
      case 'note.purged':
        return this.closeNote(event.noteId, 'note-trashed');
      case 'token.revoked':
        return;
    }
  }

  // ---- server-originated edits -----------------------------------------------------------------

  /**
   * Authorizes, then opens a `DirectConnection` whose transactions carry origin
   * `{source:'local', context:{reason, userId, revisionId?}}` (04 §6.9; 05, "Document model").
   *
   * @throws ProblemError `403 forbidden` / `404 not_found` when the principal may not perform
   * `permission` on the note's vault; a system principal is trusted (D04-21).
   */
  async openServerEdit(noteId: NoteId, context: ServerEditContext): Promise<ServerEdit> {
    const direct = await this.#openServerConnection(noteId, context);
    const document = direct.document;
    if (document === null) throw new Error('the direct connection opened no document');
    return {
      document,
      insertChunked: (index, text) => direct.insertChunked(index, text),
      transact: (fn) => direct.transact((loaded) => fn(loaded)),
      disconnect: () => direct.disconnect(),
    };
  }

  /** Keeps an admission-controlled document loaded for a committed read without exposing edits. */
  async openServerDocument(
    noteId: NoteId,
    context: Pick<ServerEditContext, 'principal' | 'permission'>,
  ): Promise<Pick<ServerEdit, 'document' | 'disconnect'>> {
    const direct = await this.#openServerConnection(noteId, context);
    const document = direct.document;
    if (document === null) throw new Error('the direct connection opened no document');
    return { document, disconnect: () => direct.disconnect() };
  }

  async #openServerConnection(
    noteId: NoteId,
    context: Pick<ServerEditContext, 'principal' | 'permission'> &
      Partial<Pick<ServerEditContext, 'reason' | 'revisionId'>>,
  ): Promise<OwnedDirectConnection> {
    const owner = this.#options.captureOwner?.();
    const server = this.#server;
    if (server === null) throw new Error('the collab gateway is not bound to a server yet');
    const resolved = await this.#options.reads.resolveNote(noteId);
    if (resolved === null || resolved.nodeKind !== 'note' || resolved.initializedAt === null) {
      throw new ProblemError('not_found', { detail: 'No such note.' });
    }
    if (resolved.deletedAt !== null) {
      throw new ProblemError('node_trashed', { detail: 'This note is in the trash.' });
    }
    const vaultId = resolved.vault.id;
    const principal = context.principal;
    if (principal.kind !== 'system') {
      const decision = await this.#options.authorize(principal, context.permission, {
        vaultId,
        vault: resolved.vault,
        surface: 'internal',
      });
      if (decision !== 'allow') {
        throw new ProblemError(decision.deny === 'not_found' ? 'not_found' : 'forbidden');
      }
    }
    const userId: UserId | null =
      principal.kind === 'system' ? (principal.onBehalfOf ?? null) : principal.userId;
    owner?.assertActive();
    const editContext: CollabHookContext = {
      ip: 'server',
      requestId:
        context.reason === undefined ? 'server-document:fresh' : `server-edit:${context.reason}`,
      connectedAt: this.#options.clock.now(),
      vaultId,
      noteId,
      ...(userId === null ? {} : { userId }),
      ...(context.reason === undefined ? {} : { reason: context.reason }),
      ...(context.revisionId === undefined ? {} : { revisionId: context.revisionId }),
    };
    let direct: DirectConnectionLike;
    try {
      direct = await server.openDirectConnection(noteDocName(noteId), editContext);
    } catch (error) {
      if (error instanceof CollabRejection && error.reason === 'capacity') {
        throw new ProblemError('capacity', { retryAfterMs: 1_000 });
      }
      throw error;
    }
    try {
      owner?.assertActive();
    } catch (error) {
      await direct.disconnect();
      throw error;
    }
    return {
      document: direct.document,
      insertChunked: (index, text) => {
        const loaded = direct.document;
        if (loaded === null) throw new Error('the direct connection is closed');
        insertChunked(
          getContent(loaded),
          index,
          text,
          { source: 'local', context: editContext },
          () => owner?.assertActive(),
        );
      },
      transact: (transaction) =>
        direct.transact((document) => {
          owner?.assertActive();
          transaction(document);
        }),
      disconnect: () => direct.disconnect(),
    };
  }

  // ---- helpers -----------------------------------------------------------------------------------

  #connectionsOf(document: Document): readonly Connection<CollabHookContext>[] {
    const connections: Connection<CollabHookContext>[] = document.getConnections();
    return connections;
  }

  #after(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#options.clock.after(ms, resolve);
    });
  }

  /** The authenticated context of a connection, for the hooks that hand the gateway a connection. */
  static contextOf(connection: Connection<CollabHookContext>): AuthenticatedContext {
    return authenticated(connection.context);
  }
}
